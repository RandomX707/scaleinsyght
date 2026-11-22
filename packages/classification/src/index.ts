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
