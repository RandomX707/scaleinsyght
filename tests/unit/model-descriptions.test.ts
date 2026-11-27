import { describe, expect, it } from 'vitest';
import { DESCRIPTION_LIMITS, descriptionBatches, describeRequest, validDraft, type DescriptionSubject } from '@scaleinsyght/profiler';

const subject = (name: string, kind = 'table', sql: string | null = null): DescriptionSubject => ({ name, kind, columns: ['id', 'name'], keys: [], parameters: [], returns: [], reads: [], writes: [], calls: [], sql });

describe('model-drafted descriptions (decision 66)', () => {
  it('accepts one or two plain sentences in sentence case only', () => {
    expect(validDraft('Lists each customer with their region and account manager.')).toBe(true);
    expect(validDraft('Holds daily order totals. Refreshed each night from the orders table.')).toBe(true);
    for (const bad of ['too short.', 'lists customers and regions for reporting.', 'One. Two sentences here. And a third one too.', 'Holds totals\nper day.', 'Holds `orders` totals per day.', 'Holds daily totals per region', 'x'.repeat(400) + '.', 42, null])
      expect(validDraft(bad), String(bad)).toBe(false);
  });
  it('batches tables many per call and code objects a few, bounded by size', () => {
    const tables = Array.from({ length: 60 }, (_, index) => subject(`dbo.t${index}`));
    const routines = Array.from({ length: 14 }, (_, index) => subject(`dbo.p${index}`, 'procedure', 'SELECT 1'));
    const batches = descriptionBatches([...tables, ...routines]);
    expect(batches.map((batch) => batch.length)).toEqual([25, 25, 10, 6, 6, 2]);
    const large = Array.from({ length: 6 }, (_, index) => subject(`dbo.big${index}`, 'function', 'x'.repeat(DESCRIPTION_LIMITS.sqlChars)));
    expect(descriptionBatches(large).every((batch) => batch.length < 6)).toBe(true);
  });
  it('sends names, structure and capped scrubbed SQL through the cheap alias, never statistics', () => {
    const request = describeRequest('tenant', [subject('dbo.orders'), subject('dbo.usp_load', 'procedure', `INSERT INTO dbo.orders SELECT '<string>' ${'y'.repeat(10_000)}`)]);
    expect(request).toMatchObject({ alias: 'cheap', purpose: 'describe', metadata: { classification: 'METADATA_DESCRIPTIVE', statistical: {}, sensitivityTags: [] } });
    expect(JSON.stringify(request.metadata.structural)).not.toContain('INSERT');
    expect(request.metadata.descriptive['definition dbo.usp_load']).toHaveLength(DESCRIPTION_LIMITS.sqlChars);
    // The gateway refuses undefined values in metadata: the request must survive a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(request.metadata))).toStrictEqual(request.metadata);
    expect(JSON.stringify(request.metadata)).not.toContain('"sql"');
    expect(JSON.stringify(request.responseSchema)).toContain('"enum":["dbo.orders","dbo.usp_load"]');
  });
});
