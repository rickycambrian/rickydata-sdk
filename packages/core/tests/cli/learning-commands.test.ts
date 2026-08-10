import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
});

describe('rickydata learn CLI', () => {
  it('exposes prepare, stage, seal, and publish', () => {
    const learn = createProgram().commands.find((command) => command.name() === 'learn');
    expect(learn?.commands.map((command) => command.name())).toEqual(['prepare', 'stage', 'seal', 'publish']);
  });

  it('obtains GitHub OIDC in memory and emits only a non-secret run plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rickydata-learn-cli-'));
    const policyPath = join(root, 'learning.json');
    const outputPath = join(root, 'plan.json');
    await writeFile(policyPath, JSON.stringify({
      version: 1, repository: 'owner/repo', branch: 'main',
      workflowPath: '.github/workflows/rickydata-learn.yml', schedule: '15 6 * * *',
      maxCommits: 20, maxBytes: 1024, exclude: [],
    }));
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.example/token?existing=yes';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'actions-request-token';
    const runPlan = {
      version: 1, runId: 'run-1', mode: 'inspect', repository: { id: '123', fullName: 'owner/repo' },
      ref: 'refs/heads/main', headSha: '0123456789abcdef0123456789abcdef01234567', cursorSha: null, commits: [],
      policy: JSON.parse(await readFile(policyPath, 'utf8')),
    };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'github-oidc-secret' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => runPlan });
    vi.stubGlobal('fetch', mockFetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'rickydata', 'learn', 'prepare', '--mode', 'inspect', '--policy', policyPath, '--enrollment-code', 'one-time-code', '--output', outputPath, '--gateway', 'https://gateway.example']);

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(runPlan);
    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toContain('github-oidc-secret');
    expect(output).not.toContain('one-time-code');
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ headers: { authorization: 'Bearer github-oidc-secret', 'content-type': 'application/json' } });
  });

  it('fails with a redacted error when Actions OIDC is unavailable', async () => {
    const learn = createProgram();
    await expect(learn.parseAsync(['node', 'rickydata', 'learn', 'prepare', '--mode', 'inspect', '--policy', 'missing.json', '--output', 'plan.json'])).rejects.toThrow();
  });
});
