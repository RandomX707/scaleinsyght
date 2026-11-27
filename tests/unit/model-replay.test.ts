import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelReplayMissingError, REPLAY_HEADER, replayFetcher, replayModeFrom, requestKey } from '@scaleinsyght/model-gateway';

const body = (connection: string, fingerprint: string, at: string) => JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'You write typed, read-only query plans' },
  { role: 'user', content: JSON.stringify({ question: 'Orders by department since 2025-01-01', metadata: { connection, profiled_at: at }, identifier_fingerprints: [fingerprint] }) }] });
const a = body('11111111-2222-4333-8444-555555555555', 'a'.repeat(64), '2026-11-28T09:00:00.000Z');
const b = body('99999999-8888-4777-8666-555555555555', 'b'.repeat(64), '2026-11-29T10:30:00.000Z');
const env = () => { const dir = mkdtempSync(join(tmpdir(), 'replay-')); return { MODEL_REPLAY_DIR: join(dir, 'rec'), MODEL_REPLAY_MISSES_FILE: join(dir, 'misses.log') } as NodeJS.ProcessEnv; };
const liveAnswer = (content: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

describe('model replay (decision 69)', () => {
  it('keys a request by its stable content: ids, fingerprints and timestamps vary, dates in the question do not', () => {
    expect(requestKey(a).hash).toBe(requestKey(b).hash);
    expect(requestKey(a.replace('since 2025-01-01', 'since 2024-01-01')).hash).not.toBe(requestKey(a).hash);
  });

  it('records once live, then replays with the new run\'s ids and costs nothing', async () => {
    const e = env(); let liveCalls = 0;
    const record = replayFetcher('record', async (...args) => { liveCalls++; return liveAnswer('{"source":"11111111-2222-4333-8444-555555555555"}')(...args); }, e);
    await record('http://x/chat/completions', { method: 'POST', body: a });
    expect(liveCalls).toBe(1);
    const [file] = readdirSync(e.MODEL_REPLAY_DIR!);
    expect(readFileSync(join(e.MODEL_REPLAY_DIR!, file!), 'utf8')).not.toContain('11111111-2222');
    const replay = replayFetcher('replay', async () => { throw new Error('live model called'); }, e);
    const response = await replay('http://x/chat/completions', { method: 'POST', body: b });
    expect(response.headers.get(REPLAY_HEADER)).toBe('1');
    expect((await response.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('{"source":"99999999-8888-4777-8666-555555555555"}');
  });

  it('a request with no recording fails with its hash, is logged, and never reaches the live model', async () => {
    const e = env(); let liveCalls = 0;
    const replay = replayFetcher('replay', async () => { liveCalls++; return new Response('{}'); }, e);
    const error = await replay('http://x', { method: 'POST', body: a }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelReplayMissingError);
    expect((error as ModelReplayMissingError).hash).toBe(requestKey(a).hash);
    expect((error as ModelReplayMissingError).code).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(readFileSync(e.MODEL_REPLAY_MISSES_FILE!, 'utf8')).toContain(`${requestKey(a).hash} plan`);
    expect(liveCalls).toBe(0);
  });

  it('record-missing replays what exists and goes live only for the rest', async () => {
    const e = env(); let liveCalls = 0;
    const live = async (...args: Parameters<typeof fetch>) => { liveCalls++; return liveAnswer('{"ok":true}')(...args); };
    await replayFetcher('record', live, e)('http://x', { method: 'POST', body: a });
    const other = a.replace('Orders by department', 'Orders by provider');
    const fill = replayFetcher('record-missing', live, e);
    expect((await fill('http://x', { method: 'POST', body: b })).headers.get(REPLAY_HEADER)).toBe('1');
    expect((await fill('http://x', { method: 'POST', body: other })).headers.get(REPLAY_HEADER)).toBeNull();
    expect(liveCalls).toBe(2);
    expect(readdirSync(e.MODEL_REPLAY_DIR!)).toHaveLength(2);
  });

  it('modes: off by default, record refused in CI, unknown values rejected', () => {
    expect(replayModeFrom({})).toBe('off');
    expect(replayModeFrom({ MODEL_REPLAY: 'replay' })).toBe('replay');
    expect(() => replayModeFrom({ MODEL_REPLAY: 'record', CI: 'true' })).toThrow(/local only/);
    expect(() => replayModeFrom({ MODEL_REPLAY: 'record-missing', GITHUB_ACTIONS: 'true' })).toThrow(/local only/);
    expect(() => replayModeFrom({ MODEL_REPLAY: 'live' })).toThrow();
  });
});
