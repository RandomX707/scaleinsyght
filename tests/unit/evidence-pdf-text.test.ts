import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { missingFromPdf, pdfAnswerLines, pdfText, renderEvidencePack, type SafeEvidencePack } from '@scaleinsyght/reports';

// Known issue K9: one S7 run read "Export PDF" as empty. The PDF was valid; the test's reader dropped the last byte of
// a compressed stream ending in 0x0D. Every exported PDF is now read back and must contain the answer.
const planHash = () => randomUUID().replaceAll('-', '').padEnd(64, '0');
const pack = (index: number): SafeEvidencePack => ({
  runId: randomUUID(), planHash: planHash(), metric: 'grouped_count', question: 'How many orders does each department have in the PostgreSQL testbed?',
  figures: [{ sourceId: randomUUID(), connectorType: 'postgres', value: 0, rows: [{ label: 'Emergency', key: '3', value: '388' }, { label: 'Imaging', key: '7', value: String(100 + index) }, { label: 'Dermatology', key: '9', value: '<11' }] }],
  claims: [{ statement: `Emergency has the most orders, ${index.toLocaleString('en-US')} runs in.`, evidenceIds: ['e1'] }],
  evidence: [{ evidenceId: 'e1', kind: 'query', locator: 'SELECT department_id, count(*) FROM public.orders GROUP BY 1', contentHash: planHash(), redactedSummary: 'Ran on PostgreSQL' }],
  trust: { groupCount: 1, sourceCount: 1, joins: [] },
});
/** Streams whose compressed bytes end in 0x0D: the case the old reader got wrong. */
function streamsEndingInCarriageReturn(bytes: Buffer): number {
  const source = bytes.toString('latin1'); let count = 0;
  for (const match of source.matchAll(/\/Length\s+(\d+)[^>]*>>\s*stream\r?\n/g)) {
    const start = match.index! + match[0].length; if (bytes[start + Number(match[1]) - 1] === 0x0d) count++;
  }
  return count;
}

describe('every exported PDF contains its answer (known issue K9)', () => {
  it('reads the answer back from 1,000 PDFs, including streams that end in a carriage return', async () => {
    let carriageReturns = 0;
    for (let index = 0; index < 1000; index++) {
      const exported = pack(index); const { bytes } = await renderEvidencePack(exported, 'pdf');
      carriageReturns += streamsEndingInCarriageReturn(bytes);
      expect(missingFromPdf(bytes, pdfAnswerLines(exported)), exported.runId).toEqual([]);
      expect(pdfText(bytes)).toContain('Emergency (3): 388');
    }
    // The case behind K9 occurs about once in 125 PDFs; the test must actually cover it.
    expect(carriageReturns).toBeGreaterThan(0);
  }, 120_000);

  it('reports answer text that is not in the PDF', async () => {
    const exported = pack(1); const { bytes } = await renderEvidencePack(exported, 'pdf');
    expect(missingFromPdf(bytes, ['Emergency (3): 388', 'Cardiology (4): 29'])).toEqual(['Cardiology (4): 29']);
  });

  it('accepts lineage figures whose arrow the standard font cannot draw', async () => {
    const exported = { ...pack(2), figures: [{ sourceId: 's', connectorType: 'power_bi', value: 0, rows: [{ label: 'orders.department_id → Orders report', key: null, value: 'parsed' }] }] };
    const { bytes } = await renderEvidencePack(exported, 'pdf');
    expect(missingFromPdf(bytes, pdfAnswerLines(exported))).toEqual([]);
  });

  it('treats an unreadable stream as an error, never as an empty page', async () => {
    const { bytes } = await renderEvidencePack(pack(3), 'pdf');
    const source = bytes.toString('latin1'); const match = /\/FlateDecode[^>]*>>\s*stream\r?\n/.exec(source)!;
    const corrupt = Buffer.from(bytes); corrupt.fill(0x41, match.index + match[0].length, match.index + match[0].length + 8);
    expect(() => pdfText(corrupt)).toThrow('pdf_stream_unreadable');
  });
});
