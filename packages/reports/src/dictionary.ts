import { createHash } from 'node:crypto';
import JSZip from 'jszip';

/** One source's dictionary as the Dictionary page shows it: structure, profile statistics and descriptions only.
 * Statistics on tagged columns are already withheld by the profiler (contract 7); no row values exist here. */
export type DictionaryExport = {
  sourceName: string; generatedAt: string;
  tables: Array<{ name: string; columns: Array<{ name: string; label: string | null; dataType: string | null; tags: string[]; nullRate: number | null; distinctCount: number | null; description: string | null }> }>;
};
export type DictionaryFormat = 'markdown' | 'docx';

const percent = (value: number | null) => value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`;
const number = (value: number | null) => value === null ? 'not measured' : value.toLocaleString('en-US');
const cell = (value: string) => value.replaceAll('|', '\\|').replace(/\s+/g, ' ');
const column = (name: string) => name.slice(name.lastIndexOf('.') + 1);

export function dictionaryMarkdown(input: DictionaryExport): string {
  const columns = input.tables.reduce((total, table) => total + table.columns.length, 0);
  const documented = input.tables.reduce((total, table) => total + table.columns.filter((item) => item.description).length, 0);
  const lines = [`# Data dictionary: ${input.sourceName}`, '', `Generated ${input.generatedAt} by Scale Insyght. ${input.tables.length.toLocaleString('en-US')} tables, ${columns.toLocaleString('en-US')} columns, ${documented.toLocaleString('en-US')} documented.`, ''];
  for (const table of input.tables) {
    lines.push(`## ${table.name}`, '', '| Column | Type | Sensitivity | Nulls | Distinct | Description |', '|---|---|---|---|---|---|');
    for (const item of table.columns) {
      const withheld = item.tags.length ? 'withheld' : null;
      lines.push(`| ${cell(item.label && item.label !== column(item.name) ? `${column(item.name)} (${item.label})` : column(item.name))} | ${cell(item.dataType ?? 'unknown')} | ${item.tags.length ? item.tags.join(', ') : 'none'} | ${withheld ?? percent(item.nullRate)} | ${withheld ?? number(item.distinctCount)} | ${cell(item.description ?? '')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const paragraph = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
const row = (cells: string[], header = false) => `<w:tr>${cells.map((value) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r>${header ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`;

/** A minimal Word document (Office Open XML) with the same content as the Markdown export. */
export async function dictionaryDocx(input: DictionaryExport): Promise<Buffer> {
  const body: string[] = [paragraph(`Data dictionary: ${input.sourceName}`, 'Title'), paragraph(`Generated ${input.generatedAt} by Scale Insyght.`)];
  for (const table of input.tables) {
    body.push(paragraph(table.name, 'Heading1'));
    body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${row(['Column', 'Type', 'Sensitivity', 'Nulls', 'Distinct', 'Description'], true)}${table.columns.map((item) => row([
      item.label && item.label !== column(item.name) ? `${column(item.name)} (${item.label})` : column(item.name), item.dataType ?? 'unknown', item.tags.length ? item.tags.join(', ') : 'none',
      item.tags.length ? 'withheld' : percent(item.nullRate), item.tags.length ? 'withheld' : number(item.distinctCount), item.description ?? ''])).join('')}</w:tbl>`);
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function renderDictionary(input: DictionaryExport, format: DictionaryFormat): Promise<{ bytes: Buffer; contentType: string; filename: string; contentHash: string }> {
  const bytes = format === 'markdown' ? Buffer.from(dictionaryMarkdown(input), 'utf8') : await dictionaryDocx(input);
  const slug = input.sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source';
  return { bytes, contentType: format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: `dictionary-${slug}.${format === 'markdown' ? 'md' : 'docx'}`, contentHash: createHash('sha256').update(bytes).digest('hex') };
}
