import { describe, expect, it } from 'vitest';
import { evaluateCapabilityAuthorization } from '@scaleinsyght/policy';

describe('contract 1/2 capability policy', () => {
  it('c2_release1_action_effects_are_denied_even_when_requested', () => {
    for (const effectClass of ['MUTATION', 'DEPLOY', 'RELEASE', 'IRREVERSIBLE'] as const) {
      expect(evaluateCapabilityAuthorization({
        registered: true, enabled: true, effectClass, entitled: true,
      })).toMatchObject({ outcome: 'deny' });
    }
  });

  it('c1_allow_requires_registered_enabled_read_capability_and_entitlement', () => {
    expect(evaluateCapabilityAuthorization({
      registered: true, enabled: true, effectClass: 'READ', entitled: true,
    }).outcome).toBe('allow');
    expect(evaluateCapabilityAuthorization({
      registered: true, enabled: true, effectClass: 'READ', entitled: false,
    }).outcome).toBe('deny');
  });
});
