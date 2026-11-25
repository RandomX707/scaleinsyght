import { createHash } from 'node:crypto';
import { once } from 'node:events';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import { missingFromPdf } from './pdf-text.js';
export { missingFromPdf, pdfText } from './pdf-text.js';
export { claimDueSchedule, markScheduleSlotSkipped, markScheduleSlotStarted, nextScheduleInstant, type DueReportSchedule } from './scheduler.js';
export { persistReportSnapshot, startScheduledReportRun } from './snapshots.js';

export type ExportFormat = 'pdf' | 'xlsx' | 'pptx';
export interface SafeEvidencePack {
  runId: string;
  planHash: string;
  metric: string;
  /** The question the run answered, as asked. */
  question?: string;
  /** One entry per source; grouped answers carry every group, withheld cells stay "<11", lineage answers carry each link. */
  figures: Array<{ sourceId: string; connectorType: string; value: number; rows?: Array<{ label: string; key: string | null; value: string }> }>;
  claims: Array<{ statement: string; evidenceIds: string[] }>;
  evidence: Array<{ evidenceId: string; kind: string; locator: string; contentHash: string; redactedSummary: string }>;
  trust: { groupCount: number; sourceCount: number; joins: string[] };
}
export interface ExportedPack { bytes: Buffer; contentHash: string; contentType: string; filename: string; }

export function safeEvidencePack(input: { runId: string; planHash: string; question?: string; answer: {
  metric: string; bySource: Array<{ sourceId: string; connectorType: string; value: number; rows?: Array<Record<string, unknown>>; lineage?: { steps?: Array<{ from: string; to: string; method: string }> } }>;
  claims: Array<{ statement: string; evidence_ids: string[] }>;
  evidence: Array<{ evidence_id: string; kind: string; locator: string; content_hash: string; redacted_summary: string }>;
  trust: { groupCount: number; sourceCount: number; joins: string[] };
} }): SafeEvidencePack {
  if (!input.runId || !/^[a-f0-9]{64}$/i.test(input.planHash) || !input.answer.metric || !input.answer.bySource.length
    || input.answer.bySource.some((figure) => !Number.isFinite(figure.value))) throw new Error('evidence_pack_invalid');
  const safeText=(value:string)=>{
    if(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value)||/\b\d{8,}\b/.test(value)||/\b(?:ssn|email|phone|customer id|account id)\s*[:=#]\s*\S+/i.test(value)||/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/i.test(value))throw new Error('evidence_pack_sensitive_value');
    return value;
  };
  safeText(input.answer.metric);
  for(const figure of input.answer.bySource)safeText(figure.connectorType);
  for(const claim of input.answer.claims)safeText(claim.statement);
  for(const item of input.answer.evidence){safeText(item.kind);safeText(item.locator);safeText(item.redacted_summary);}
  for(const join of input.answer.trust.joins)safeText(join);
  return {
    runId: input.runId, planHash: input.planHash, metric: input.answer.metric,
    ...(input.question ? { question: safeText(input.question) } : {}),
    figures: input.answer.bySource.map(({ sourceId, connectorType, value, rows, lineage }) => {
      const grouped = rows?.map((row) => ({ label: safeText(String(row.group_value ?? '')), key: row.group_key == null ? null : safeText(String(row.group_key)), value: String(row.value) }));
      const links = lineage?.steps?.map((step) => ({ label: safeText(`${step.from} → ${step.to}`), key: null, value: safeText(step.method) }));
      return { sourceId, connectorType, value, ...(grouped?.length ? { rows: grouped } : links?.length ? { rows: links } : {}) };
    }),
    claims: input.answer.claims.map((claim) => ({ statement: claim.statement, evidenceIds: [...claim.evidence_ids] })),
    evidence: input.answer.evidence.map((item) => ({ evidenceId: item.evidence_id, kind: item.kind, locator: item.locator, contentHash: item.content_hash, redactedSummary: item.redacted_summary })),
    trust: input.answer.trust,
  };
}

function figureLines(pack: SafeEvidencePack): string[] {
  return pack.figures.flatMap((row) => row.rows?.length
    ? [`${row.connectorType} (${row.sourceId}):`, ...row.rows.map((item) => `  ${item.label}${item.key ? ` (${item.key})` : ''}: ${item.value}`)]
    : [`${row.connectorType} (${row.sourceId}): ${row.value}`]);
}

function packText(pack: SafeEvidencePack): string {
  return [`Scale Insyght evidence pack`, ...(pack.question ? [`Question: ${pack.question}`] : []), `Run: ${pack.runId}`, `Plan hash: ${pack.planHash}`, `Metric: ${pack.metric}`, '', 'Figures',
    ...figureLines(pack), '', 'Evidence-backed claims',
    ...pack.claims.map((claim) => `${claim.statement} [${claim.evidenceIds.join(', ')}]`), '', 'Evidence',
    ...pack.evidence.map((item) => `${item.kind}: ${item.redactedSummary} · ${item.locator} · ${item.contentHash}`), '',
    `Trust: ${pack.trust.groupCount} groups, ${pack.trust.sourceCount} sources · ${pack.trust.joins.join(', ')}`].join('\n');
}

async function pdf(pack: SafeEvidencePack): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 48 }); const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = once(doc, 'end');
  doc.fontSize(20).text('Scale Insyght evidence pack');
  doc.moveDown().fontSize(10).text(`${pack.question ? `Question: ${pack.question}\n` : ''}Run: ${pack.runId}\nPlan hash: ${pack.planHash}\nMetric: ${pack.metric}`);
  doc.moveDown().fontSize(14).text('Figures'); doc.fontSize(10);
  for (const line of figureLines(pack)) doc.text(line);
  doc.moveDown().fontSize(14).text('Evidence-backed claims'); doc.fontSize(10);
  for (const claim of pack.claims) doc.text(`${claim.statement} [${claim.evidenceIds.join(', ')}]`);
  doc.moveDown().fontSize(14).text('Evidence'); doc.fontSize(10);
  for (const item of pack.evidence) doc.text(`${item.kind}: ${item.redactedSummary} · ${item.locator} · ${item.contentHash}`);
  doc.moveDown().text(`Trust: ${pack.trust.groupCount} groups, ${pack.trust.sourceCount} sources · ${pack.trust.joins.join(', ')}`);
  doc.end(); await done; return Buffer.concat(chunks);
}

async function xlsx(pack: SafeEvidencePack): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Scale Insyght'; workbook.subject = 'Safe run evidence';
  const figures = workbook.addWorksheet('Figures'); figures.addRows([...(pack.question ? [['Question', pack.question]] : []), ['Metric', pack.metric], ['Source', 'Connector', 'Group', 'Key', 'Value'],
    ...pack.figures.flatMap((row) => row.rows?.length ? row.rows.map((item) => [row.sourceId, row.connectorType, item.label, item.key ?? '', /^-?\d+(\.\d+)?$/.test(item.value) ? Number(item.value) : item.value]) : [[row.sourceId, row.connectorType, '', '', row.value]])]);
  const claims = workbook.addWorksheet('Claims'); claims.addRows([['Claim', 'Evidence IDs'], ...pack.claims.map((claim) => [claim.statement, claim.evidenceIds.join(', ')])]);
  const evidence = workbook.addWorksheet('Evidence'); evidence.addRows([['Kind', 'Summary', 'Locator', 'Content hash'], ...pack.evidence.map((item) => [item.kind, item.redactedSummary, item.locator, item.contentHash])]);
  workbook.addWorksheet('Run').addRows([['Run ID', pack.runId], ['Plan hash', pack.planHash], ['Groups', pack.trust.groupCount], ['Sources', pack.trust.sourceCount]]);
  const result = await workbook.xlsx.writeBuffer(); return Buffer.from(result);
}

async function pptx(pack: SafeEvidencePack): Promise<Buffer> {
  type Slide = { addText(text: string, options: Record<string, unknown>): void };
  type Deck = { author: string; subject: string; title: string; addSlide(): Slide; write(options: { outputType: 'nodebuffer' }): Promise<unknown> };
  const PptxConstructor = PptxGenJS as unknown as new () => Deck;
  const deck = new PptxConstructor(); deck.author = 'Scale Insyght'; deck.subject = 'Safe run evidence'; deck.title = 'Evidence pack';
  const summary = deck.addSlide(); summary.addText('Scale Insyght evidence pack', { x: 0.6, y: 0.4, w: 11, h: 0.6, fontSize: 24 });
  summary.addText(`${pack.question ? `${pack.question}\n` : ''}Run ${pack.runId}\nPlan ${pack.planHash}\nMetric ${pack.metric}`, { x: 0.6, y: 1.2, w: 11, h: 1.0, fontSize: 11 });
  summary.addText(figureLines(pack).join('\n'), { x: 0.6, y: 2.4, w: 11, h: 4.5, fontSize: figureLines(pack).length > 8 ? 10 : 18, breakLine: false });
  const evidence = deck.addSlide(); evidence.addText('Claims and evidence', { x: 0.6, y: 0.4, w: 11, h: 0.6, fontSize: 24 });
  evidence.addText(packText(pack), { x: 0.6, y: 1.2, w: 11, h: 5.5, fontSize: 10, breakLine: false });
  const bytes = await deck.write({ outputType: 'nodebuffer' }); return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer);
}

/** The answer a PDF must contain: the question, every figure line and every claim (known issue K9). */
export function pdfAnswerLines(pack: SafeEvidencePack): string[] {
  return [...(pack.question ? [pack.question] : []), ...figureLines(pack), ...pack.claims.map((claim) => claim.statement)];
}

export async function renderEvidencePack(pack: SafeEvidencePack, format: ExportFormat): Promise<ExportedPack> {
  const bytes = format === 'pdf' ? await pdf(pack) : format === 'xlsx' ? await xlsx(pack) : await pptx(pack);
  // Every exported PDF is read back before it is served; one without the answer is never handed over.
  if (format === 'pdf' && missingFromPdf(bytes, pdfAnswerLines(pack)).length) throw new Error('evidence_pdf_missing_answer_text');
  const contentTypes = {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return { bytes, contentHash: createHash('sha256').update(bytes).digest('hex'), contentType: contentTypes[format], filename: `evidence-${pack.runId}.${format}` };
}
export { dictionaryMarkdown, dictionaryDocx, renderDictionary, type DictionaryExport, type DictionaryFormat } from './dictionary.js';
