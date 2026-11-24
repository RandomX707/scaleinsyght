import { describe, expect, it } from 'vitest';
import { getGoldenMetadataFixture } from '../support/golden-metadata.js';

describe('phase three synthetic tool connectors', () => {
  it('c6_dbt_tableau_power_bi_golden_imports_are_fixture_key_allowlisted', () => {
    expect(getGoldenMetadataFixture('dbt-manifest').assets.some((asset) => asset.name === 'dbt.customer_mart')).toBe(true);
    expect(getGoldenMetadataFixture('tableau-reports').reports[0]?.tool).toBe('tableau');
    expect(getGoldenMetadataFixture('power-bi-reports').reports[0]?.tool).toBe('power_bi');
    expect(() => getGoldenMetadataFixture('../phase3.json')).toThrow('unknown_golden_metadata_fixture');
  });
});
