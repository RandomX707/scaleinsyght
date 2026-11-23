import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('deployment Compose reference', () => {
  it('ci_uses_the_generated_sample_source_url_instead_of_overriding_it', () => {
    const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
    expect(workflow).not.toMatch(/^\s+DATABASE_URL_SAMPLE_SOURCE:/m);
  });

  it('phase6_reference_compose_starts_cold_without_publishing_gateway_ports', () => {
    const compose=readFileSync(new URL('../../compose.yaml',import.meta.url),'utf8');
    const gateway=compose.split('  customer-gateway:\n')[1];
    expect(gateway).toBeTruthy();
    expect(gateway).toContain('profiles: ["private-gateway"]');
    expect(gateway).not.toMatch(/^ {4}ports:/m);
    expect(gateway).toContain('${GATEWAY_CREDENTIAL:?');
    expect(gateway).toContain('${CONTROL_PLANE_URL:?');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('postgres:16');
    expect(compose).toContain('${POSTGRES_PASSWORD:?');
    expect(compose).toContain('${SI_APP_PASSWORD:?');
    expect(compose).toContain('${SESSION_SECRET:?');
    expect(compose).toContain('${ARTIFACT_MASTER_KEY:?');
  });
});
