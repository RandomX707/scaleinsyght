import { describe, expect, it } from 'vitest';
import { assertLiveModelTestAllowed } from '@scaleinsyght/model-gateway';

describe('local live model test guard',()=>{
  it('c3_test_live_refuses_ci_even_when_opted_in',()=>{
    expect(()=>assertLiveModelTestAllowed({CI:'true',LIVE_MODEL_TEST:'1'} as NodeJS.ProcessEnv)).toThrow('test_live_is_local_only');
  });

  it('c3_test_live_requires_explicit_local_opt_in',()=>{
    expect(()=>assertLiveModelTestAllowed({} as NodeJS.ProcessEnv)).toThrow('LIVE_MODEL_TEST');
    expect(()=>assertLiveModelTestAllowed({LIVE_MODEL_TEST:'1'} as NodeJS.ProcessEnv)).not.toThrow();
  });
});
