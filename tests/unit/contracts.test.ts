import { describe, expect, it } from 'vitest';
import {
  canTransitionRun,
  RunEventSchema,
  RunStateSchema,
  SafeEventPayloadSchema,
} from '@scaleinsyght/contracts';
import { validateCapabilityPayload, CapabilityPayloadError } from '@scaleinsyght/contracts';

describe('frozen contracts', () => {
  it('c5_run_transition_matches_the_legal_transition_table', () => {
    expect(canTransitionRun('CREATED', 'PLANNING')).toBe(true);
    expect(canTransitionRun('PLANNING', 'RUNNING')).toBe(false);
    expect(canTransitionRun('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransitionRun('RUNNING', 'PARTIAL')).toBe(true);
  });

  it('c5_terminal_run_states_are_recognized', () => {
    expect(RunStateSchema.parse('POLICY_BLOCKED')).toBe('POLICY_BLOCKED');
    expect(RunStateSchema.safeParse('RETRYING').success).toBe(false);
  });

  it('c5_event_payload_rejects_result_rows_and_credentials', () => {
    expect(SafeEventPayloadSchema.safeParse({ result_ref: 'result://abc', count: 2 }).success).toBe(true);
    expect(SafeEventPayloadSchema.safeParse({ rows: [{ patient: 'synthetic' }] }).success).toBe(false);
    expect(SafeEventPayloadSchema.safeParse({ password: 'secret' }).success).toBe(false);
  });

  it('c5_run_event_requires_sequence_and_tenant', () => {
    expect(RunEventSchema.safeParse({
      tenant_id: 'tenant-a', run_id: crypto.randomUUID(), sequence: 1,
      event_type: 'run_created', safe_payload: {},
    }).success).toBe(true);
    expect(RunEventSchema.safeParse({ run_id: crypto.randomUUID(), event_type: 'run_created' }).success).toBe(false);
  });

  it('c2_bad_capability_input_and_output_return_typed_errors',()=>{
    const schema={type:'object',required:['limit'],properties:{limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false};
    let inputError:unknown;try{validateCapabilityPayload('input',schema,{limit:0});}catch(error){inputError=error;}
    let outputError:unknown;try{validateCapabilityPayload('output',schema,{limit:'many'});}catch(error){outputError=error;}
    expect(inputError).toBeInstanceOf(CapabilityPayloadError);
    expect(outputError).toBeInstanceOf(CapabilityPayloadError);
  });
});
