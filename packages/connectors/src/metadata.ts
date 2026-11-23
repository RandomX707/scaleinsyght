import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('../../../tests/golden/phase3.json', import.meta.url), 'utf8')) as {
  sources: Array<{ id:string; type:string; name:string }>;
  assets: Array<{ name: string; kind: string }>;
  flows: Array<{ from: string; to: string; grain: string; method: 'observed'|'declared'|'parsed'|'inferred'; confidence: number; change?: string }>;
  disputed: { from: string; to: string; evidence: string[] };
  gaps: Array<{ between: string[]; reason: string }>;
  reportImpact: { report: string; changedAsset: string };
};

export function getGoldenPhase3Dataset() {
  return structuredClone(fixture);
}

export type GoldenMetadataKey = 'dbt-manifest' | 'tableau-reports' | 'power-bi-reports';
export interface GoldenMetadataFixture {
  tool: 'dbt' | 'tableau' | 'power_bi';
  assets: Array<{ name: string; kind: string }>;
  flows: typeof fixture.flows;
  reports: Array<{ name: string; tool: 'tableau' | 'power_bi'; safe_path: string }>;
  disputed: typeof fixture.disputed;
  gaps: typeof fixture.gaps;
}

export function getGoldenMetadataFixture(key: string): GoldenMetadataFixture {
  if (key === 'dbt-manifest') {
    return { tool:'dbt',assets:fixture.assets.filter((asset)=>asset.name.startsWith('dbt.')),flows:fixture.flows.filter((flow)=>flow.from.startsWith('dbt.')||flow.to.startsWith('dbt.')),reports:[],disputed:fixture.disputed,gaps:fixture.gaps };
  }
  if (key === 'tableau-reports') {
    return { tool:'tableau',assets:fixture.assets.filter((asset)=>asset.name.startsWith('Tableau.')),flows:[],reports:[{name:'Tableau.Customer Summary',tool:'tableau',safe_path:'/demo/tableau/customer-summary'}],disputed:fixture.disputed,gaps:[] };
  }
  if (key === 'power-bi-reports') {
    return { tool:'power_bi',assets:fixture.assets.filter((asset)=>asset.name.startsWith('Power BI.')),flows:fixture.flows.filter((flow)=>flow.from.startsWith('Power BI.')||flow.to.startsWith('Power BI.')),reports:[{name:'Power BI.Customer Health',tool:'power_bi',safe_path:'/demo/power-bi/customer-health'}],disputed:fixture.disputed,gaps:[] };
  }
  throw new Error('unknown_golden_metadata_fixture');
}
