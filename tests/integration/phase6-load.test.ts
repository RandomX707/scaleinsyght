import { describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { runLoadCheck } from '../../scripts/test-load.js';

config({path:'.env'});

describe('Phase 6 first progress event load objective', () => {
  it('c5_first_progress_event_p95_under_three_seconds_under_load', async () => {
    const result=await runLoadCheck(100);
    expect(result.runs).toBe(100);
    expect(result.p95Ms).toBeLessThan(3000);
  },30_000);
});
