import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/** The product's own PDF reader (known issue K9), so tests and the export check read PDFs the same way. */
export { pdfText } from '@scaleinsyght/reports';

export async function xlsxRows(bytes: Buffer, sheet: string): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const rows: unknown[][] = [];
  workbook.getWorksheet(sheet)?.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

async function zipText(bytes: Buffer, pattern: RegExp, tag: RegExp): Promise<string> {
  const zip = await JSZip.loadAsync(bytes); const parts: string[] = [];
  for (const name of Object.keys(zip.files).filter((file) => pattern.test(file)).sort()) {
    const xml = await zip.file(name)!.async('string');
    parts.push([...xml.matchAll(tag)].map((match) => match[1]!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&')).join('\n'));
  }
  return parts.join('\n');
}
export const pptxText = (bytes: Buffer) => zipText(bytes, /^ppt\/slides\/slide\d+\.xml$/, /<a:t>([^<]*)<\/a:t>/g);
export const docxText = (bytes: Buffer) => zipText(bytes, /^word\/document\.xml$/, /<w:t[^>]*>([^<]*)<\/w:t>/g);
