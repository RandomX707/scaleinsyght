import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Model replay (decision 69). In tests the gateway answers from recorded responses keyed by a hash of the request,
 * so automated runs never call, or pay for, the live model.
 *   MODEL_REPLAY=replay  answer from recordings; a request with no recording fails with its hash and never goes live.
 *   MODEL_REPLAY=record  call the live model and save the response (the only way tests reach it).
 *   unset / off          the product: plain live calls.
 * Values that change between runs (UUIDs, 64-hex fingerprints, timestamps; bare dates are kept so the contract 7
 * scan still sees any date of birth) are replaced by numbered
 * placeholders before hashing, and mapped back into the replayed response, so a recording matches the same request
 * in a later run.
 */
export type ReplayMode = 'off' | 'replay' | 'record';
type Fetch = (input: URL | string, init?: RequestInit) => Promise<Response>;
export type Recording = { hash: string; recordedAt: string; model: string; purpose: string; request: unknown; response: { content: string; promptTokens: number; completionTokens: number } };

export const REPLAY_HEADER = 'x-scaleinsyght-replay';
export class ModelReplayMissingError extends Error {
  readonly code: string;
  // The code stays within the safe error-code alphabet (activity_events checks it); the hash is in the message and the misses log.
  constructor(readonly hash: string) { super(`model_replay_missing ${hash}`); this.name = 'ModelReplayMissingError'; this.code = 'model_replay_missing'; }
}

export function replayModeFrom(env: NodeJS.ProcessEnv): ReplayMode {
  const value = (env.MODEL_REPLAY ?? 'off').trim().toLowerCase();
  if (value === '' || value === 'off') return 'off';
  if (value === 'record' && (env.CI === 'true' || env.GITHUB_ACTIONS === 'true')) throw new Error('MODEL_REPLAY=record is local only; CI replays');
  if (value === 'replay' || value === 'record') return value;
  throw new Error(`MODEL_REPLAY must be off, replay or record; got ${value}`);
}
export const replayDir = (env: NodeJS.ProcessEnv) => resolve(env.MODEL_REPLAY_DIR ?? 'tests/fixtures/model-replay');
export const missesFile = (env: NodeJS.ProcessEnv) => resolve(env.MODEL_REPLAY_MISSES_FILE ?? '.model-replay-misses.log');

const VOLATILE: Array<[string, RegExp]> = [
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['hex', /\b[0-9a-f]{64}\b/gi],
  ['ts', /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g],
];
export type Placeholders = Map<string, string>; // real value -> placeholder
/** Replaces volatile values with ⟨kind:n⟩ placeholders, numbered by first appearance. */
export function normalizeText(text: string, map: Placeholders = new Map()): { text: string; map: Placeholders } {
  let result = text;
  for (const [kind, pattern] of VOLATILE) {
    result = result.replace(pattern, (value) => {
      const key = kind === 'uuid' || kind === 'hex' ? value.toLowerCase() : value;
      let placeholder = map.get(key);
      if (!placeholder) { placeholder = `⟨${kind}:${[...map.values()].filter((item) => item.startsWith(`⟨${kind}:`)).length + 1}⟩`; map.set(key, placeholder); }
      return placeholder;
    });
  }
  return { text: result, map };
}
/** Same substitution, only for values already in the map (a response may echo request values). */
export function applyKnown(text: string, map: Placeholders): string {
  let result = text;
  for (const [value, placeholder] of [...map.entries()].sort((a, b) => b[0].length - a[0].length)) result = result.split(value).join(placeholder);
  return result;
}
export function restore(text: string, map: Placeholders): string {
  let result = text;
  for (const [value, placeholder] of map) result = result.split(placeholder).join(value);
  return result;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
/** The normalized request and its hash. */
export function requestKey(body: string): { hash: string; request: unknown; map: Placeholders } {
  const { text, map } = normalizeText(body);
  const request = canonical(JSON.parse(text));
  return { hash: createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32), request, map };
}
const purposeOf = (request: unknown) => {
  const system = (request as { messages?: Array<{ role?: string; content?: string }> }).messages?.find((message) => message.role === 'system')?.content ?? '';
  return /check whether a typed/.test(system) ? 'verify' : /write typed, read-only query plans/.test(system) ? 'plan' : /describ/i.test(system) ? 'describe' : 'answer';
};

/** Wraps the live fetch for the given mode. The gateway uses this by default, so every construction site is covered. */
export function replayFetcher(mode: ReplayMode, live: Fetch, env: NodeJS.ProcessEnv, options: { scan?: (recording: Recording, rawBody: string, rawResponse: string) => void } = {}): Fetch {
  if (mode === 'off') return live;
  const dir = replayDir(env);
  return async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const { hash, request, map } = requestKey(body);
    const file = join(dir, `${hash}.json`);
    if (mode === 'replay') {
      if (!existsSync(file)) {
        const purpose = purposeOf(request);
        try {
          appendFileSync(missesFile(env), `${hash} ${purpose}\n`);
          // The normalized request (already through the contract 7 boundary), so a miss can be compared with the nearest recording.
          const debug = resolve(env.MODEL_REPLAY_MISSES_DIR ?? '.model-replay-misses'); mkdirSync(debug, { recursive: true });
          writeFileSync(join(debug, `${hash}.json`), `${JSON.stringify(request, null, 1)}\n`);
        } catch { /* the error below still fails the call */ }
        console.error(`[model-replay] no recording for request ${hash} (${purpose}); record it with MODEL_REPLAY=record. The live model was not called.`);
        throw new ModelReplayMissingError(hash);
      }
      const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording;
      const content = restore(recording.response.content, map);
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: recording.response.promptTokens, completion_tokens: recording.response.completionTokens } }), { status: 200, headers: { 'content-type': 'application/json', [REPLAY_HEADER]: '1' } });
    }
    const response = await live(input, init);
    const raw = await response.text();
    if (response.ok) {
      const data = JSON.parse(raw) as { model?: string; choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === 'string') {
        const recording: Recording = { hash, recordedAt: new Date().toISOString(), model: String((request as { model?: unknown }).model ?? data.model ?? ''), purpose: purposeOf(request), request,
          response: { content: applyKnown(content, map), promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 } };
        options.scan?.(recording, body, content);
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${file}.tmp`, `${JSON.stringify(recording, null, 1)}\n`); renameSync(`${file}.tmp`, file);
      }
    }
    return new Response(raw, { status: response.status, headers: response.headers });
  };
}
