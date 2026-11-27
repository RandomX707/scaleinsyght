import { existsSync, readFileSync, rmSync } from 'node:fs';
import { missesFile, replayModeFrom } from '@scaleinsyght/model-gateway';

// Decision 69: the testbed replays recorded model responses. A request with no recording is logged by the gateway;
// this teardown fails the run and lists the hashes, so a miss is never hidden by a product fallback.
export default function setup() {
  const mode = replayModeFrom({ ...process.env, MODEL_REPLAY: process.env.MODEL_REPLAY ?? 'replay' });
  const file = missesFile(process.env);
  rmSync(file, { force: true });
  console.log(`Model replay mode: ${mode}`);
  return () => {
    if (!existsSync(file)) return;
    const misses = [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean))];
    if (misses.length) throw new Error(`Model replay: ${misses.length} request(s) had no recording (live model not called). Record with MODEL_REPLAY=record:\n${misses.join('\n')}`);
  };
}
