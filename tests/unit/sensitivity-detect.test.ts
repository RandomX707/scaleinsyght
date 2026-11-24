import { describe, expect, it } from 'vitest';
import { classifyColumn } from '@scaleinsyght/classification';

const codes = Array.from({ length: 40 }, (_, index) => `REC-${String(index + 1).padStart(6, '0')}`);
const phones = Array.from({ length: 40 }, (_, index) => `555-01${String(index).padStart(5, '0')}`);

describe('sensitivity detector (decision 41)', () => {
  it('c7_detector_infers_personal_regulated_and_identifier_columns_from_names_and_values', () => {
    expect(classifyColumn({ name: 'full_name', label: 'Full Name', declaredTags: [] }).tags).toEqual(['personal']);
    expect(classifyColumn({ name: 'date_of_birth', declaredTags: [] }).tags).toEqual(['regulated']);
    expect(classifyColumn({ name: 'dob', declaredTags: [] }).tags).toEqual(['regulated']);
    expect(classifyColumn({ name: 'phone_number', declaredTags: [] }).tags).toEqual(['personal']);
    expect(classifyColumn({ name: 'contact', declaredTags: [], sample: phones }).tags).toEqual(['personal']);
    expect(classifyColumn({ name: 'reference', declaredTags: [], sample: codes }).evidence).toEqual([{ tag: 'identifier', detection: 'inferred', reason: expect.stringContaining('record identifier') }]);
    expect(classifyColumn({ name: 'work_email', declaredTags: [] }).tags).toEqual(['personal']);
  });

  it('c7_detector_keeps_declared_tags_and_only_adds', () => {
    const declared = classifyColumn({ name: 'phone', declaredTags: ['personal'] });
    expect(declared.evidence).toEqual([{ tag: 'personal', detection: 'declared', reason: 'declared by the source' }]);
    expect(classifyColumn({ name: 'notes', declaredTags: ['regulated'], sample: codes }).tags).toEqual(['regulated', 'identifier']);
  });

  it('c7_detector_leaves_ordinary_columns_untagged', () => {
    for (const name of ['department_name', 'department_code', 'provider_name', 'status', 'order_type', 'amount', 'patient_id', 'admitted_on'])
      expect(classifyColumn({ name, declaredTags: [] }).tags, name).toEqual([]);
    expect(classifyColumn({ name: 'department_code', declaredTags: [], sample: Array.from({ length: 30 }, (_, index) => `D-${String(index).padStart(3, '0')}`) }).tags).toEqual([]);
    expect(classifyColumn({ name: 'status', declaredTags: [], sample: Array.from({ length: 30 }, (_, index) => ['placed', 'completed', 'cancelled'][index % 3]!) }).tags).toEqual([]);
    expect(classifyColumn({ name: 'reference', declaredTags: [], sample: codes.slice(0, 10) }).tags).toEqual([]);
  });
});
