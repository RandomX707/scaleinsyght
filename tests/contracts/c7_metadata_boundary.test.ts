import { describe, expect, it } from 'vitest';
import { prepareMetadataForModel } from '@scaleinsyght/classification';
import golden from '../golden/phase1.json' with { type: 'json' };

describe('contract 7 profiler metadata boundary', () => {
  it('c7_view_literals_are_replaced_with_typed_placeholders', () => {
    const safe = prepareMetadataForModel({
      classification: 'METADATA_DESCRIPTIVE',
      structural: { name: 'patient_view', type: 'view' },
      descriptive: { definition: golden.viewDefinition },
      statistical: {},
      sensitivityTags: [],
    });
    expect(JSON.stringify(safe)).not.toContain('C-1042');
    expect(safe.descriptive?.definition).toContain("'<string>'");
  });

  it('c7_sensitive_person_name_and_email_are_removed_from_comments', () => {
    const safe = prepareMetadataForModel({
      classification: 'METADATA_DESCRIPTIVE',
      structural: { name: 'account_table', type: 'table' },
      descriptive: { comment: golden.sensitiveComment },
      statistical: {},
      sensitivityTags: [],
    });
    expect(JSON.stringify(safe)).not.toContain('Sample Person');
    expect(JSON.stringify(safe)).not.toContain('sample.person@example.invalid');
  });

  it('c7_statistics_for_tagged_fields_are_withheld', () => {
    const safe = prepareMetadataForModel({
      classification: 'METADATA_STATISTICAL',
      structural: { name: golden.taggedField, type: 'field' },
      descriptive: {},
      statistical: { min: 'C-1042', max: 'C-9876', distinctCount: 700 },
      sensitivityTags: ['identifier'],
    });
    expect(safe.statistical).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('C-1042');
  });

  it('c7_statistics_for_groups_below_tenant_threshold_are_withheld', () => {
    const safe = prepareMetadataForModel({
      classification: 'METADATA_STATISTICAL',
      structural: { name: 'small_group_count', type: 'field' },
      descriptive: {},
      statistical: { count: golden.smallGroupSize },
      sensitivityTags: [],
      groupSize: golden.smallGroupSize,
      minimumCellSize: 10,
    });
    expect(safe.statistical).toBeUndefined();
  });

  it('c7_unclassified_sources_expose_structural_metadata_only', () => {
    const safe = prepareMetadataForModel({
      classification: 'UNCLASSIFIED',
      structural: { name: 'orders', type: 'table', columns: ['id', 'total'] },
      descriptive: { comment: 'sensitive', definition: "SELECT 'C-1042'" },
      statistical: { min: 1, max: 10 },
      sensitivityTags: [],
    });
    expect(safe).toEqual({ structural: { name: 'orders', type: 'table', columns: ['id', 'total'] } });
  });
});
