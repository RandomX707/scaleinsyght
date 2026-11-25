import { inflateSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/** Text drawn in a PDF written by pdfkit: inflates each content stream and decodes its text operators. Enough to check
 * an exported figure is really in the file, not a full PDF reader. */
export function pdfText(bytes: Buffer): string {
  const source = bytes.toString('latin1'); const parts: string[] = [];
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let match = streams.exec(source); match; match = streams.exec(source)) {
    let content: string;
    try { content = inflateSync(Buffer.from(match[1]!, 'latin1')).toString('latin1'); } catch { continue; }
    for (const array of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      parts.push([...array[1]!.matchAll(/<([0-9a-fA-F]+)>|\(((?:\\.|[^\\)])*)\)/g)].map((item) => item[1]
        ? Buffer.from(item[1], 'hex').toString('latin1') : item[2]!.replace(/\\([()\\])/g, '$1')).join(''));
    }
    for (const single of content.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) parts.push(Buffer.from(single[1]!, 'hex').toString('latin1'));
  }
  return parts.join('\n');
}

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
