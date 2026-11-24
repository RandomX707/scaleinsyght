import { describe, expect, it } from 'vitest';
import { normalizeTenantSlug, normalizeUserEmail, validateFirstUserPassword } from '../../scripts/tenant-create.js';

describe('tenant:create input handling', () => {
  it('tenant_create_normalizes_tenant_names_and_email_addresses', () => {
    expect(normalizeTenantSlug('Riverside Health / East')).toBe('riverside-health-east');
    expect(normalizeUserEmail('  Owner+Demo@Example.invalid ')).toBe('owner+demo@example.invalid');
  });

  it('tenant_create_rejects_invalid_workspace_email_and_weak_password', () => {
    expect(() => normalizeTenantSlug('---')).toThrow('tenant_name_invalid');
    expect(() => normalizeUserEmail('not an email')).toThrow('email_invalid');
    expect(() => validateFirstUserPassword('too-short')).toThrow('password_too_short');
  });
});
