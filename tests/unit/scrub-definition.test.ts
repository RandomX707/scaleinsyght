import { describe, expect, it } from 'vitest';
import { scrubDefinition } from '@scaleinsyght/classification';

describe('definition scrubbing (decision 53)', () => {
  it('replaces string and number literals with typed placeholders and keeps names', () => {
    const sql = "INSERT INTO dbo.X_JOB_LOG (job_name) SELECT N'readmit flags' FROM dbo.encounters2 e WHERE e.patient_id <> 104233 AND e.score > 0.75 AND [col 1] = 'it''s' AND @Rows = 30 -- skip patient 55";
    const scrubbed = scrubDefinition(sql);
    expect(scrubbed).toBe("INSERT INTO dbo.X_JOB_LOG (job_name) SELECT '<string>' FROM dbo.encounters2 e WHERE e.patient_id <> <number> AND e.score > <number> AND [col 1] = '<string>' AND @Rows = <number> -- <comment>");
    expect(scrubbed).not.toMatch(/104233|readmit flags|0\.75|it''s|\b55\b/);
  });
  it('hides block comment text and keeps its line count', () => {
    expect(scrubDefinition('SELECT 1 /* Synthetic Patient One\nMRN-0001 */ FROM t')).toBe('SELECT <number> /* <comment>\n */ FROM t');
    expect(scrubDefinition('SUM([x]) // ignore [y]', 'tableau')).toBe('SUM([x]) // <comment>');
  });
  it('keeps digits inside identifiers, quoted identifiers and dotted names', () => {
    expect(scrubDefinition('SELECT t1.col2, "Col 3" FROM schema1.table_2 t1 WHERE x = 0x1F')).toBe('SELECT t1.col2, "Col 3" FROM schema1.table_2 t1 WHERE x = <number>');
  });
  it('scrubs Tableau formula strings in either quote', () => {
    expect(scrubDefinition('IF [Stay days] > 7 THEN "Over a week" ELSE \'short\' END', 'tableau')).toBe('IF [Stay days] > <number> THEN "<string>" ELSE \'<string>\' END');
  });
});
