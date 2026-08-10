import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalDigest,
  resolveLearningCommitWindow,
  sealLearningBundle,
  stageLearningRepository,
  validateLearningCandidate,
  validateLearningPolicy,
  type LearningCandidateV1,
  type LearningRunPlanV1,
  type LearningVerificationV1,
} from '../src/learning/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rickydata-learning-test-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'allowed.ts'), 'export const answer = 42;\n');
  await writeFile(join(root, '.env.local'), 'SECRET=never-stage-this\n');
  await writeFile(join(root, '.gitignore'), '.env*\nuntracked.txt\n');
  await writeFile(join(root, 'untracked.txt'), 'not tracked\n');
  git(root, 'add', '.gitignore', 'src/allowed.ts');
  git(root, 'add', '-f', '.env.local');
  git(root, 'commit', '-m', 'initial');
  return root;
}

function plan(root: string, headSha: string): LearningRunPlanV1 {
  return {
    version: 1,
    runId: 'opaque-run-plan',
    mode: 'generate',
    repository: { id: '123', fullName: 'owner/repo' },
    ref: 'refs/heads/main',
    headSha,
    cursorSha: null,
    commits: [headSha],
    policy: {
      version: 1,
      repository: 'owner/repo',
      branch: 'main',
      workflowPath: '.github/workflows/rickydata-learn.yml',
      schedule: '15 6 * * *',
      maxCommits: 20,
      maxBytes: 25 * 1024 * 1024,
      exclude: [],
    },
  };
}

function candidate(excerpt = 'export const answer = 42;'): LearningCandidateV1 {
  return {
    version: 1,
    lessons: [{
      title: 'A bounded lesson',
      summary: 'A source-grounded summary.',
      markdown: '# A bounded lesson\n\nThe answer is exported as a constant.',
      claims: [{ text: 'The module exports answer as 42.', citationIndexes: [0] }],
      citations: [{ sha: SHA, path: 'src/allowed.ts', startLine: 1, endLine: 1, excerpt }],
    }],
  };
}

const verification: LearningVerificationV1 = {
  version: 1,
  accepted: true,
  lessons: [{ lessonIndex: 0, claims: [{ claimIndex: 0, supported: true }] }],
};

describe('learning policy and candidate contracts', () => {
  it('rejects unsafe policy paths and quiz-shaped author output', () => {
    expect(() => validateLearningPolicy({
      version: 1,
      repository: 'owner/repo',
      branch: 'main',
      workflowPath: '../steal.yml',
      schedule: '15 6 * * *',
      maxCommits: 20,
      maxBytes: 1,
    })).toThrow(/workflow path/i);

    expect(() => validateLearningCandidate({ ...candidate(), quiz: [] })).toThrow(/quiz/i);
    expect(() => validateLearningCandidate({ ...candidate(), lessons: [
      ...candidate().lessons,
      ...candidate().lessons,
      ...candidate().lessons,
      ...candidate().lessons,
    ] })).toThrow(/three lessons/i);
    expect(() => validateLearningCandidate({
      ...candidate(),
      lessons: [{ ...candidate().lessons[0], markdown: '<script>alert(1)</script>' }],
    })).toThrow(/markdown/i);
    expect(() => validateLearningCandidate({
      ...candidate(),
      lessons: [{ ...candidate().lessons[0], arbitraryLabel: 'RickydataAnything' }],
    })).toThrow(/unexpected/i);
    expect(() => validateLearningCandidate({
      ...candidate(),
      lessons: [{ ...candidate().lessons[0], citations: [{ ...candidate().lessons[0].citations[0], path: '../secret' }] }],
    })).toThrow(/path/i);
  });

  it('canonicalizes objects independently of property order', () => {
    expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest({ b: 2, a: 1 }));
  });
});

describe('learning repository staging', () => {
  it('copies only tracked allowed text and emits a deterministic manifest', async () => {
    const root = await repository();
    const head = git(root, 'rev-parse', 'HEAD');
    const first = await stageLearningRepository({ repositoryRoot: root, outputDirectory: join(root, 'stage-a'), plan: plan(root, head) });
    const second = await stageLearningRepository({ repositoryRoot: root, outputDirectory: join(root, 'stage-b'), plan: plan(root, head) });

    expect(first.digest).toBe(second.digest);
    expect(first.files.map((entry) => entry.path)).toEqual(['src/allowed.ts']);
    await expect(readFile(join(root, 'stage-a', 'current', '.env.local'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'stage-a', 'current', 'untracked.txt'), 'utf8')).rejects.toThrow();
  });

  it('chunks later history without skipping and selects the latest 20 commits initially', async () => {
    const root = await repository();
    const cursor = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const added: string[] = [];
    let parent = cursor;
    for (let index = 1; index <= 21; index += 1) {
      parent = git(root, 'commit-tree', tree, '-p', parent, '-m', `change ${index}`);
      added.push(parent);
    }
    git(root, 'update-ref', 'refs/heads/main', parent);
    const head = added.at(-1)!;
    const later = await resolveLearningCommitWindow(root, cursor, head, 20);
    expect(later).toEqual(added.slice(0, 20));

    const initial = await resolveLearningCommitWindow(root, null, head, 20);
    expect(initial).toHaveLength(20);
    expect(initial.at(-1)).toBe(head);
  }, 20_000);

  it('fails closed for symlinks and size overflow, while excluding binaries', async () => {
    const root = await repository();
    await symlink('/etc/passwd', join(root, 'escape'));
    git(root, 'add', 'escape');
    git(root, 'commit', '-m', 'unsafe link');
    await expect(stageLearningRepository({ repositoryRoot: root, outputDirectory: join(root, 'stage-link'), plan: plan(root, git(root, 'rev-parse', 'HEAD')) })).rejects.toThrow(/symlink/i);

    const binaryRoot = await repository();
    await writeFile(join(binaryRoot, 'binary.bin'), Buffer.from([0, 1, 2]));
    git(binaryRoot, 'add', 'binary.bin');
    git(binaryRoot, 'commit', '-m', 'binary');
    const binaryStage = await stageLearningRepository({ repositoryRoot: binaryRoot, outputDirectory: join(binaryRoot, 'stage-bin'), plan: plan(binaryRoot, git(binaryRoot, 'rev-parse', 'HEAD')) });
    expect(binaryStage.files.some((entry) => entry.path === 'binary.bin')).toBe(false);

    const smallRoot = await repository();
    const smallPlan = plan(smallRoot, git(smallRoot, 'rev-parse', 'HEAD'));
    smallPlan.policy.maxBytes = 4;
    await expect(stageLearningRepository({ repositoryRoot: smallRoot, outputDirectory: join(smallRoot, 'stage-small'), plan: smallPlan })).rejects.toThrow(/size/i);
  }, 20_000);
});

describe('learning bundle sealing', () => {
  it('rechecks exact cited bytes and creates a bounded canonical digest', async () => {
    const root = await repository();
    const head = git(root, 'rev-parse', 'HEAD');
    const staged = await stageLearningRepository({ repositoryRoot: root, outputDirectory: join(root, 'stage'), plan: plan(root, head) });
    const valid = candidate();
    valid.lessons[0].citations[0].sha = head;
    const sealed = await sealLearningBundle({ plan: plan(root, head), manifest: staged, candidate: valid, verification, stagedDirectory: join(root, 'stage') });

    expect(sealed.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(JSON.stringify(sealed))).toBeLessThanOrEqual(512 * 1024);

    const mismatched = candidate('export const answer = 43;');
    mismatched.lessons[0].citations[0].sha = head;
    await expect(sealLearningBundle({ plan: plan(root, head), manifest: staged, candidate: mismatched, verification, stagedDirectory: join(root, 'stage') })).rejects.toThrow(/citation/i);
  });

  it('rejects unverified claims and likely secrets without echoing them', async () => {
    const root = await repository();
    const head = git(root, 'rev-parse', 'HEAD');
    const runPlan = plan(root, head);
    const staged = await stageLearningRepository({ repositoryRoot: root, outputDirectory: join(root, 'stage'), plan: runPlan });
    const valid = candidate();
    valid.lessons[0].citations[0].sha = head;
    const rejected: LearningVerificationV1 = { ...verification, accepted: false };
    await expect(sealLearningBundle({ plan: runPlan, manifest: staged, candidate: valid, verification: rejected, stagedDirectory: join(root, 'stage') })).rejects.toThrow(/verification/i);

    const secret = candidate();
    secret.lessons[0].citations[0].sha = head;
    secret.lessons[0].markdown += '\nAKIAIOSFODNN7EXAMPLE';
    try {
      await sealLearningBundle({ plan: runPlan, manifest: staged, candidate: secret, verification, stagedDirectory: join(root, 'stage') });
      throw new Error('expected secret rejection');
    } catch (error) {
      expect(String(error)).toMatch(/secret/i);
      expect(String(error)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
  });
});
