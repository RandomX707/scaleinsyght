import { describe,expect,it } from 'vitest';
import { GraphAssertionSchema } from '@scaleinsyght/contracts';
import { buildIdPath,fingerprintIdentifier,invalidateAssertionForTransformationChange,reviewAssertion } from '@scaleinsyght/graph';

const assertion={assertion_id:'d942d83a-927f-4d6d-b8f9-8e4d097874d9',relationship_id:'e246627d-22aa-484f-9b1b-8b1f17649af1',evidence_method:'inferred',review_status:'unreviewed',verification:'unverified',evidence_ids:['823f57fa-8278-4c60-a331-16cce3849c43'],confidence_score:0.92,explanation:'Synthetic field-name and format match',transformation:null,collector_version:'phase3-v1',captured_at:'2026-11-23T00:00:00.000Z'} as const;

describe('phase 3 graph semantics',()=>{
 it('c6_assertions_require_evidence_and_keep_review_and_verification_independent',()=>{
  expect(GraphAssertionSchema.safeParse({...assertion,evidence_ids:[]}).success).toBe(false);
  const accepted=reviewAssertion(assertion,'accepted');
  expect(accepted.review_status).toBe('accepted');expect(accepted.verification).toBe('unverified');
  const stale=invalidateAssertionForTransformationChange({...accepted,verification:'run_verified'});
  expect(stale.review_status).toBe('stale');expect(stale.verification).toBe('unverified');
 });

 it('c6_id_path_confidence_uses_weakest_hop_and_gaps_make_it_incomplete',()=>{
  const path=buildIdPath([{assetId:'a',change:'none',confidence:0.99,assertionId:'assertion-a'},{assetId:'b',change:'renamed',confidence:0.71,assertionId:'assertion-b'},{assetId:'c',change:'none',confidence:0.95,assertionId:'assertion-c'}],['gap-1']);
  expect(path.confidence).toBe(0.71);expect(path.complete).toBe(false);expect(path.steps[1]?.change).toBe('renamed');expect(path.gapIds).toEqual(['gap-1']);
 });

 it('c6_keyed_identifier_fingerprints_are_stable_within_tenant_and_distinct_across_tenants',()=>{
  const masterKey=Buffer.alloc(32,7);const value='synthetic-id-never-persisted';
  const north=fingerprintIdentifier(masterKey,'tenant-north',value);const south=fingerprintIdentifier(masterKey,'tenant-south',value);
  expect(fingerprintIdentifier(masterKey,'tenant-north',value)).toBe(north);expect(south).not.toBe(north);expect(north).toMatch(/^[a-f0-9]{64}$/);
 });
});
