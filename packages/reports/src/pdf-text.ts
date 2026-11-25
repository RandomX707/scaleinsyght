import { inflateSync } from 'node:zlib';

/**
 * Text drawn in a PDF written by pdfkit: reads each stream by its declared /Length, inflates it when it is
 * FlateDecode, and decodes the text-showing operators. Enough to prove an exported answer is really in the file;
 * not a general PDF reader.
 *
 * Known issue K9: an earlier test-only reader found streams with /stream\r?\n(.*?)\r?\nendstream/, which drops the
 * last byte of a compressed stream that happens to end in 0x0D, so inflating failed and the page read as empty
 * (about one PDF in 125). The declared length is exact, and an unreadable stream is an error, never skipped.
 */
export function pdfText(bytes: Buffer): string {
  const source = bytes.toString('latin1'); const parts: string[] = [];
  const header = /<<((?:(?!>>\s*stream)[\s\S])*)>>\s*stream\r?\n/g;
  for (let match = header.exec(source); match; match = header.exec(source)) {
    const dictionary = match[1]!;
    const length = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dictionary);
    if (!length || length[2]) throw new Error('pdf_stream_length_unreadable');
    const start = match.index + match[0].length;
    const raw = bytes.subarray(start, start + Number(length[1]));
    header.lastIndex = start + raw.length;
    if (/\/Subtype\s*\/Image|\/Length1/.test(dictionary)) continue; // images and embedded fonts hold no text
    let content: string;
    try { content = (/\/FlateDecode/.test(dictionary) ? inflateSync(raw) : raw).toString('latin1'); }
    catch { throw new Error('pdf_stream_unreadable'); }
    for (const operation of content.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ|(<[0-9a-fA-F]*>|\((?:\\.|[^\\)])*\))\s*Tj/g)) {
      const strings = operation[1] ?? operation[2]!;
      parts.push([...strings.matchAll(/<([0-9a-fA-F]*)>|\(((?:\\.|[^\\)])*)\)/g)].map((item) => item[1] !== undefined
        ? decode(Buffer.from(item[1], 'hex'))
        : decode(Buffer.from(item[2]!.replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))).replace(/\\(.)/g, '$1'), 'latin1'))).join(''));
    }
  }
  return parts.join('\n');
}

const winAnsi = new TextDecoder('windows-1252');
const decode = (bytes: Buffer) => winAnsi.decode(bytes);

/** Letters and digits only: pdfkit wraps long lines and its standard fonts cannot draw every symbol (for example →). */
const comparable = (text: string) => text.replace(/[^A-Za-z0-9]/g, '');

/** The expected lines that are not in the PDF's text, compared on letters and digits. */
export function missingFromPdf(bytes: Buffer, expected: string[]): string[] {
  const text = comparable(pdfText(bytes));
  return expected.filter((line) => !text.includes(comparable(line)));
}
