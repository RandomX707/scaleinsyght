import { SaxesParser } from 'saxes';

/**
 * Reads a Tableau workbook (.twb, the documented workbook XML) for lineage. Only structure leaves this module:
 * data sources and the tables they read, how each field maps to a column, which fields each calculated field refers to,
 * and which fields each worksheet uses. Formula text, server and user names and parameter captions are never returned;
 * captions are returned with the data source's server, user and database names removed (Tableau's default captions
 * embed them). Custom SQL and the database name are returned so the caller can parse and match them in memory; neither
 * may be stored (contract 7).
 */

export type TableauRelation =
  | { name: string; kind: 'table'; schema: string | null; table: string }
  | { name: string; kind: 'custom_sql'; sql: string }
  | { name: string; kind: 'unsupported'; type: string };

export type TableauFieldSource =
  /** A column of one of the data source's relations, as recorded in the workbook's metadata records. */
  | { kind: 'column'; relation: string; column: string }
  /** A calculated field: the fields its formula refers to, never the formula itself. `datasource` is set when the
   * formula names another data source's field (`[federated.x].[Field]`); otherwise the field is in the same one. */
  | { kind: 'calculated'; references: FieldReference[]; usesParameters: boolean }
  /** Tableau did not record where the field comes from. */
  | { kind: 'unmapped' };

export type FieldReference = { datasource: string | null; field: string };

export type TableauField = { name: string; caption: string; dataType: string | null; role: string | null; source: TableauFieldSource };

export type TableauDatasource = {
  /** Internal name, for example `federated.0a1b2c3`; worksheets refer to data sources by it. */
  name: string;
  caption: string;
  /** The database driver class, for example `postgres`, `sqlserver` or `snowflake`; null when the workbook has none. */
  connectionClass: string | null;
  /** Database names the data source connects to. In memory only, for matching to the linked warehouse; never store. */
  databases: string[];
  relations: TableauRelation[];
  fields: TableauField[];
};

export type TableauWorksheet = { name: string; fields: Array<{ datasource: string; field: string }> };

export type TableauWorkbook = { version: string | null; datasources: TableauDatasource[]; worksheets: TableauWorksheet[] };

type Element = { name: string; attributes: Record<string, string>; children: Element[]; text: string };

/** Largest workbook accepted, in characters. Workbooks are XML with no data rows; extracts live in .twbx files. */
export const MAX_WORKBOOK_CHARS = 20 * 1024 * 1024;

class TableauWorkbookInvalid extends Error { constructor(code = 'tableau_workbook_invalid') { super(code); } }

function parseXml(xml: string): Element {
  const parser = new SaxesParser({ xmlns: false });
  const root: Element = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: Element[] = [root];
  let failure: Error | null = null;
  parser.on('error', (error) => { failure ??= error; });
  // A workbook never needs a DTD; refusing one rules out entity expansion of any kind.
  parser.on('doctype', () => { failure ??= new TableauWorkbookInvalid(); });
  parser.on('opentag', (tag) => {
    const element: Element = { name: tag.name, attributes: tag.attributes as Record<string, string>, children: [], text: '' };
    stack.at(-1)!.children.push(element);
    if (!tag.isSelfClosing) stack.push(element);
  });
  parser.on('closetag', (tag) => { if (!tag.isSelfClosing) stack.pop(); });
  parser.on('text', (text) => { stack.at(-1)!.text += text; });
  parser.on('cdata', (text) => { stack.at(-1)!.text += text; });
  try { parser.write(xml).close(); } catch (error) { failure ??= error as Error; }
  if (failure) throw failure instanceof TableauWorkbookInvalid ? failure : new TableauWorkbookInvalid();
  return root;
}

/** Tableau writes object-model elements with prefixes such as `_.fcp.ObjectModelEncapsulateLegacy.true...relation`. */
const localName = (name: string) => name.slice(name.lastIndexOf('.') + 1);
const children = (element: Element, name: string) => element.children.filter((child) => localName(child.name) === name);
const child = (element: Element, name: string) => children(element, name)[0];
const descendants = (element: Element, name: string, found: Element[] = []): Element[] => {
  for (const item of element.children) { if (localName(item.name) === name) found.push(item); descendants(item, name, found); }
  return found;
};

/** Splits a bracketed Tableau identifier path such as `[public].[orders]` or `[a]]b]` into its parts. */
export function splitBracketed(value: string): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === '.') { index++; continue; }
    if (value[index] !== '[') { const end = value.indexOf('.', index); parts.push(value.slice(index, end < 0 ? undefined : end)); index = end < 0 ? value.length : end; continue; }
    let part = ''; index++;
    while (index < value.length) {
      if (value[index] === ']') { if (value[index + 1] === ']') { part += ']'; index += 2; continue; } index++; break; }
      part += value[index++];
    }
    parts.push(part);
  }
  return parts;
}
const unbracket = (value: string) => splitBracketed(value).at(-1) ?? value;

/**
 * The fields a Tableau formula refers to, by local name. String literals and comments are skipped, so their contents
 * never appear in the result. `[Parameters].[Name]` is a parameter, not data, and is reported only as a flag.
 */
export function formulaReferences(formula: string): { references: FieldReference[]; usesParameters: boolean } {
  const references = new Map<string, FieldReference>();
  const add = (datasource: string | null, field: string) => { references.set(`${datasource ?? ''}\0${field}`, { datasource, field }); };
  let usesParameters = false;
  let index = 0;
  // Returns null for an unterminated bracket, so text after it is never mistaken for a field name.
  const readBracket = (): string | null => {
    let name = ''; index++;
    while (index < formula.length) {
      if (formula[index] === ']') { if (formula[index + 1] === ']') { name += ']'; index += 2; continue; } index++; return name; }
      name += formula[index++];
    }
    return null;
  };
  while (index < formula.length) {
    const character = formula[index]!;
    if (character === '/' && formula[index + 1] === '/') { const end = formula.indexOf('\n', index); index = end < 0 ? formula.length : end; continue; }
    if (character === '/' && formula[index + 1] === '*') { const end = formula.indexOf('*/', index + 2); index = end < 0 ? formula.length : end + 2; continue; }
    if (character === '"' || character === "'") {
      index++;
      while (index < formula.length) { if (formula[index] === character) { if (formula[index + 1] === character) { index += 2; continue; } index++; break; } index++; }
      continue;
    }
    if (character === '[') {
      const first = readBracket();
      if (first === null) break;
      if (formula[index] === '.' && formula[index + 1] === '[') {
        index++; const second = readBracket(); if (second === null) break;
        if (first === 'Parameters') usesParameters = true; else add(first, second);
        continue;
      }
      add(null, first);
      continue;
    }
    index++;
  }
  return { references: [...references.values()], usesParameters };
}

function readRelations(datasource: Element): TableauRelation[] {
  const found = new Map<string, TableauRelation>();
  const visit = (relation: Element) => {
    const type = relation.attributes.type ?? '';
    const name = relation.attributes.name ?? '';
    if (type === 'join' || type === 'collection') { for (const item of children(relation, 'relation')) visit(item); return; }
    if (!name || found.has(name)) return;
    if (type === 'table' && relation.attributes.table) {
      const parts = splitBracketed(relation.attributes.table);
      found.set(name, { name, kind: 'table', schema: parts.length >= 2 ? parts.at(-2)! : null, table: parts.at(-1)! });
    } else if (type === 'text') {
      found.set(name, { name, kind: 'custom_sql', sql: relation.text.trim() });
    } else {
      // Unions, stored procedures and anything newer are recorded, never guessed; their fields end in a gap.
      found.set(name, { name, kind: 'unsupported', type: type || 'unknown' });
    }
  };
  // Legacy workbooks keep relations under <connection>; the object model (2020.2 and later) also keeps them under
  // <object-graph>. Both are read and deduplicated by relation name.
  const connection = child(datasource, 'connection');
  for (const relation of connection ? children(connection, 'relation') : []) visit(relation);
  for (const object of descendants(datasource, 'object')) for (const properties of children(object, 'properties')) for (const relation of children(properties, 'relation')) visit(relation);
  return [...found.values()];
}

function readDatasource(element: Element): TableauDatasource {
  const name = element.attributes.name ?? '';
  const connection = child(element, 'connection');
  const named = connection ? descendants(connection, 'named-connection').map((item) => child(item, 'connection')).filter((item): item is Element => Boolean(item)) : [];
  const classes = [...new Set(named.map((item) => item.attributes.class).filter((value): value is string => Boolean(value)))];
  const direct = connection?.attributes.class && connection.attributes.class !== 'federated' ? [connection] : [];
  const connectionClass = direct.length ? direct[0]!.attributes.class! : classes.length === 1 ? classes[0]! : classes.length ? 'multiple' : null;
  const details = [...direct, ...named];
  const databases = [...new Set(details.map((item) => item.attributes.dbname).filter((value): value is string => Boolean(value)))];
  // Tableau's default captions embed the database, server or user, for example "orders (riverside_dw)".
  const sensitive = [...new Set(details.flatMap((item) => [item.attributes.dbname, item.attributes.server, item.attributes.username, item.attributes.filename]).filter((value): value is string => Boolean(value && value.length >= 3)))];
  const scrub = (caption: string) => {
    let safe = caption;
    for (const value of sensitive) safe = safe.split(value).join('');
    return safe.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  };
  const relations = readRelations(element);
  const fields = new Map<string, TableauField>();
  for (const record of connection ? descendants(connection, 'metadata-record') : []) {
    if (record.attributes.class !== 'column') continue;
    const local = child(record, 'local-name')?.text.trim(); const remote = child(record, 'remote-name')?.text.trim(); const parent = child(record, 'parent-name')?.text.trim();
    if (!local || !remote || !parent) continue;
    const field = unbracket(local);
    fields.set(field, { name: field, caption: field, dataType: child(record, 'local-type')?.text.trim() || null, role: null, source: { kind: 'column', relation: unbracket(parent), column: remote } });
  }
  for (const column of children(element, 'column')) {
    const raw = column.attributes.name; if (!raw) continue;
    const field = unbracket(raw);
    const calculation = child(column, 'calculation');
    const existing = fields.get(field);
    let source: TableauFieldSource = existing?.source ?? { kind: 'unmapped' };
    if (calculation) {
      const fromFormula = calculation.attributes.formula ? formulaReferences(calculation.attributes.formula) : { references: [], usesParameters: false };
      // Groups and bins name their base field in a column attribute instead of a formula.
      const base: FieldReference[] = calculation.attributes.column ? [{ datasource: null, field: unbracket(calculation.attributes.column) }] : [];
      const references = [...fromFormula.references, ...base]
        .map((reference) => reference.datasource === name ? { datasource: null, field: reference.field } : reference)
        .filter((reference, index, all) => !(reference.datasource === null && reference.field === field)
          && all.findIndex((other) => other.datasource === reference.datasource && other.field === reference.field) === index);
      source = { kind: 'calculated', references, usesParameters: fromFormula.usesParameters };
    }
    fields.set(field, { name: field, caption: scrub(column.attributes.caption?.trim() || existing?.caption || field) || field, dataType: column.attributes.datatype ?? existing?.dataType ?? null, role: column.attributes.role ?? null, source });
  }
  return { name, caption: scrub(element.attributes.caption?.trim() || '') || relations.map((relation) => relation.kind === 'table' ? relation.table : relation.name).join(' + ') || name, connectionClass, databases, relations, fields: [...fields.values()] };
}

function readWorksheet(element: Element): TableauWorksheet {
  const used = new Map<string, { datasource: string; field: string }>();
  for (const dependencies of descendants(element, 'datasource-dependencies')) {
    const datasource = dependencies.attributes.datasource; if (!datasource || datasource === 'Parameters') continue;
    const add = (raw: string | undefined) => { if (!raw) return; const field = unbracket(raw); used.set(`${datasource}\0${field}`, { datasource, field }); };
    // Column instances are what the sheet places on shelves; plain columns are only definitions and are not counted.
    for (const instance of children(dependencies, 'column-instance')) add(instance.attributes.column);
  }
  return { name: element.attributes.name ?? '', fields: [...used.values()] };
}

/** Reads a .twb workbook. Throws `tableau_workbook_invalid` for anything that is not workbook XML, and
 * `tableau_workbook_too_large` above MAX_WORKBOOK_CHARS. A packaged .twbx (a zip file) is refused as `tableau_twbx_unsupported`. */
export function readTableauWorkbook(input: string | Buffer): TableauWorkbook {
  if (Buffer.isBuffer(input) && input.subarray(0, 2).toString('latin1') === 'PK') throw new TableauWorkbookInvalid('tableau_twbx_unsupported');
  const xml = (Buffer.isBuffer(input) ? input.toString('utf8') : input).replace(/^\uFEFF/, '');
  if (xml.startsWith('PK')) throw new TableauWorkbookInvalid('tableau_twbx_unsupported');
  if (xml.length > MAX_WORKBOOK_CHARS) throw new TableauWorkbookInvalid('tableau_workbook_too_large');
  const workbook = parseXml(xml).children.find((item) => item.name === 'workbook');
  if (!workbook) throw new TableauWorkbookInvalid();
  const datasourcesElement = child(workbook, 'datasources');
  const datasources = (datasourcesElement ? children(datasourcesElement, 'datasource') : [])
    .filter((item) => item.attributes.name && item.attributes.name !== 'Parameters' && item.attributes.hasconnection !== 'false')
    .map(readDatasource);
  const worksheetsElement = child(workbook, 'worksheets');
  const worksheets = (worksheetsElement ? children(worksheetsElement, 'worksheet') : []).map(readWorksheet).filter((sheet) => sheet.name);
  if (!datasources.length) throw new TableauWorkbookInvalid('tableau_workbook_has_no_datasources');
  return { version: workbook.attributes.version ?? null, datasources, worksheets };
}
