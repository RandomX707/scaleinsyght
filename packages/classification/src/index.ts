export type MetadataClass = 'UNCLASSIFIED' | 'METADATA_STRUCTURAL' | 'METADATA_DESCRIPTIVE' | 'METADATA_STATISTICAL';

export interface ModelMetadataInput {
  classification: MetadataClass;
  structural: Record<string, unknown>;
  descriptive: Record<string, string>;
  statistical: Record<string, number | string | null>;
  sensitivityTags: string[];
  groupSize?: number;
  minimumCellSize?: number;
}

export interface ModelMetadata {
  structural: Record<string, unknown>;
  descriptive?: Record<string, string>;
  statistical?: Record<string, number | string | null>;
}

function scrubText(text: string): string {
  return text
    .replace(/'(?:''|[^'])*'/g, "'<string>'")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, '[redacted]');
}

export function prepareMetadataForModel(input: ModelMetadataInput): ModelMetadata {
  const result: ModelMetadata = { structural: input.structural };
  if (input.classification === 'UNCLASSIFIED' || input.classification === 'METADATA_STRUCTURAL') return result;

  if (input.classification === 'METADATA_DESCRIPTIVE') {
    result.descriptive = Object.fromEntries(
      Object.entries(input.descriptive).map(([key, value]) => [key, scrubText(value)]),
    );
    return result;
  }

  const hasTags = input.sensitivityTags.length > 0;
  const thresholdConfigured = input.groupSize !== undefined && input.minimumCellSize !== undefined;
  const groupIsLargeEnough = thresholdConfigured && input.groupSize! >= input.minimumCellSize!;
  if (!hasTags && groupIsLargeEnough) result.statistical = input.statistical;
  return result;
}
export { classifyColumn, type SensitivityEvidence, type SensitivityTag, type SampleValue } from './detect.js';

/**
 * Definition text (view, procedure, function and package SQL; Tableau formulas) with every literal replaced by a typed
 * placeholder, so stored and displayed definitions never carry data values such as hard-coded identifiers
 * (non-negotiable 6, decision 53). String literals become '<string>' (Tableau also "<string>"), numbers <number>.
 * Comments are kept, with the same replacement applied inside them. Identifiers (including digits inside names,
 * bracketed or quoted SQL identifiers and @parameters) are unchanged.
 */
export function scrubDefinition(text: string, dialect: 'sql' | 'tableau' = 'sql'): string {
  let out = ''; let index = 0;
  const isWord = (character: string | undefined) => character !== undefined && /[A-Za-z0-9_@$#]/.test(character);
  while (index < text.length) {
    const character = text[index]!;
    // SQL Server Unicode string N'...'.
    if ((character === 'N' || character === 'n') && text[index + 1] === "'" && !isWord(text[index - 1])) { index++; continue; }
    if (character === "'" || (dialect === 'tableau' && character === '"')) {
      const quote = character; index++;
      while (index < text.length) { if (text[index] === quote) { if (text[index + 1] === quote) { index += 2; continue; } index++; break; } index++; }
      out += `${quote}<string>${quote}`; continue;
    }
    // Bracketed or double-quoted SQL identifiers are names, not values.
    if (character === '[' || (dialect === 'sql' && character === '"')) {
      const close = character === '[' ? ']' : '"'; const end = text.indexOf(close, index + 1);
      const stop = end < 0 ? text.length : end + 1; out += text.slice(index, stop); index = stop; continue;
    }
    if (/[0-9]/.test(character) && !isWord(text[index - 1]) && !(text[index - 1] === '.' && isWord(text[index - 2]))) {
      let end = index;
      if (character === '0' && /[xX]/.test(text[index + 1] ?? '')) { end += 2; while (/[0-9A-Fa-f]/.test(text[end] ?? '')) end++; }
      else { while (/[0-9.]/.test(text[end] ?? '')) end++; if (/[eE]/.test(text[end] ?? '') && /[+\-0-9]/.test(text[end + 1] ?? '')) { end += 2; while (/[0-9]/.test(text[end] ?? '')) end++; } }
      if (isWord(text[end])) { out += character; index++; continue; }
      out += '<number>'; index = end; continue;
    }
    out += character; index++;
  }
  return out;
}
