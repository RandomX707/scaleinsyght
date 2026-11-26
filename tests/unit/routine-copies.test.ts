import { describe, expect, it } from 'vitest';
import { detectCopies, normaliseRoutine, routineSimilarity } from '@scaleinsyght/profiler';

// Decision 62: a procedure or function whose normalised SQL is near-identical to another is a customer's copy of it.
const body = (name: string, extra = '') => `CREATE OR REPLACE PROCEDURE ${name}() LANGUAGE plpgsql AS $procedure$
BEGIN -- load admissions
  INSERT INTO reporting.admissions (patient_id, admitted_at, ward) SELECT e.patient_id, e.admitted_at, e.ward FROM clinical.encounters e
  WHERE e.kind = <text> AND e.admitted_at >= <date> ${extra};
  UPDATE reporting.load_log SET finished_at = now() WHERE job = <text>;
END $procedure$`;
const asFunction = (name: string) => `CREATE OR REPLACE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql AS $function$
BEGIN /* copied */
  INSERT INTO reporting.admissions (patient_id, admitted_at, ward) SELECT e.patient_id, e.admitted_at, e.ward FROM clinical.encounters e
  WHERE e.kind = <text> AND e.admitted_at >= <date> ;
  UPDATE reporting.load_log SET finished_at = now() WHERE job = <text>;
END $function$`;

describe('copy detection', () => {
  it('compares bodies, ignoring comments, the header and the routine’s own name', () => {
    expect(normaliseRoutine(body('etl.usp_load_admissions'), 'etl.usp_load_admissions()')).not.toContain('usp_load_admissions');
    expect(routineSimilarity(normaliseRoutine(body('etl.usp_load_admissions'), 'etl.usp_load_admissions()'), normaliseRoutine(asFunction('etl.fn_load_admissions'), 'etl.fn_load_admissions()'))).toBe(1);
  });
  it('flags the later-created near-identical routine as the copy, with its similarity', () => {
    const copies = detectCopies([
      { qualifiedName: 'etl.usp_load_admissions()', text: body('etl.usp_load_admissions'), createdOrder: 100 },
      { qualifiedName: 'etl.fn_load_admissions()', text: asFunction('etl.fn_load_admissions'), createdOrder: 250 },
      { qualifiedName: 'etl.usp_other()', text: 'CREATE PROCEDURE etl.usp_other() AS $p$ BEGIN DELETE FROM staging.x WHERE loaded < <date>; END $p$', createdOrder: 50 },
    ]);
    expect([...copies]).toEqual([['etl.fn_load_admissions()', { copyOf: 'etl.usp_load_admissions()', similarity: 1 }]]);
  });
  it('does not flag routines that only share some statements', () => {
    const changed = body('etl.usp_load_discharges').replace('reporting.admissions', 'reporting.discharges').replace('admitted_at, ward', 'discharged_at, ward, outcome').replace('e.admitted_at >= <date>', 'e.discharged_at >= <date> AND e.outcome IS NOT NULL');
    expect(detectCopies([
      { qualifiedName: 'etl.usp_load_admissions()', text: body('etl.usp_load_admissions'), createdOrder: 1 },
      { qualifiedName: 'etl.usp_load_discharges()', text: changed, createdOrder: 2 },
    ]).size).toBe(0);
  });
});
