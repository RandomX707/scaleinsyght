import type { StructuredAnswer } from './executor.js';

export interface PersonalContextMemory {
  vocabulary: Record<string, string>;
  defaultSources: string[];
  savedPlanIds: string[];
  answerStyle: 'concise' | 'detailed' | 'sql_first' | 'lineage_first' | null;
  corrections?: Array<{ term: string; meaning: string }>;
}

export interface PersonalizedAnswer {
  answer: StructuredAnswer;
  presentation: { layout: 'compact' | 'expanded' | 'source-first' | 'evidence-first'; title: string; claimOrder: string[]; correctionCount: number };
}

export function applyPersonalContext(answer: StructuredAnswer, memory: PersonalContextMemory): PersonalizedAnswer {
  const order = [...answer.claims];
  if (memory.answerStyle === 'concise') order.sort((a, b) => Number(a.kind === 'interpretation') - Number(b.kind === 'interpretation'));
  const title = memory.vocabulary[answer.metric] ?? memory.corrections?.find((item) => item.term === answer.metric)?.meaning ?? answer.metric.replaceAll('_', ' ');
  const layout = memory.answerStyle === 'detailed' ? 'expanded'
    : memory.answerStyle === 'sql_first' ? 'source-first'
      : memory.answerStyle === 'lineage_first' ? 'evidence-first' : 'compact';
  return {
    answer,
    presentation: { layout, title, claimOrder: order.map((claim) => claim.claim_id), correctionCount: memory.corrections?.length ?? 0 },
  };
}
