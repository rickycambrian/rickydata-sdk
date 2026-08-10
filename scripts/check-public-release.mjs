#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const config = JSON.parse(readFileSync(join(repoRoot, 'public-release.json'), 'utf8'));
const privateRepositoryName = ['rickydata', '_SDK'].join('');
const failures = [];
const skipDirectories = new Set(['.git', 'node_modules', 'dist', '.turbo', 'coverage']);
const forbiddenPaths = [
  '.agents',
  '.claude',
  '.codex',
  '.githooks',
  '.rickydata_code',
  '.git-secrets-map.example.json',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/SECRET_HYGIENE.md',
  'docs/agents',
  'docs/research',
  'docs/rollout-prompts',
  'docs/specs',
  'scripts/sync-public-release.mjs',
  'packages/core/tests/public-release-tools.test.ts',
];
const allowedMarkdown = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/KFDB_GETTING_STARTED.md',
  'docs/contracts/human-agent-collaboration.md',
  'docs/pr-review-system.md',
  'docs/release.md',
  'docs/sdk-mcp-dynamic-agent-loading.md',
  'packages/core/vendor/erc8128/README.md',
]);
const allowedTopLevel = new Set([
  '.github',
  '.gitignore',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'docs',
  'examples',
  'package-lock.json',
  'package.json',
  'packages',
  'public-release.json',
  'scripts',
  'tsconfig.base.json',
  'turbo.json',
]);

function normalize(path) {
  return path.split('\\').join('/');
}

function fail(message) {
  failures.push(message);
}

function isForbiddenPath(path) {
  return forbiddenPaths.some((forbidden) => path === forbidden || path.startsWith(`${forbidden}/`));
}

function isTextFile(path) {
  const bytes = readFileSync(path);
  return !bytes.subarray(0, 4096).includes(0);
}

function inspectText(path, relativePath) {
  const body = readFileSync(path, 'utf8');
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(body)) fail(`Absolute workstation path in ${relativePath}`);
  if (body.includes(`github.com/rickycambrian/${privateRepositoryName}`)) fail(`Private repository URL in ${relativePath}`);
  const publicTestKey = `0x${'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'}`;
  for (const match of body.matchAll(/0x[a-fA-F0-9]{64}/g)) {
    const repeatedExample = /^0x([a-fA-F0-9])\1{63}$/.test(match[0]);
    if (match[0] !== publicTestKey && !repeatedExample) fail(`Private key-like value in ${relativePath}`);
  }
  for (const match of body.matchAll(/(?:ghp|github_pat|sk-(?:ant|proj|live))[_-][A-Za-z0-9_-]{20,}/g)) {
    if (!match[0].includes('SHOULD-NEVER-PRINT')) fail(`Secret-like token in ${relativePath}`);
  }
}

function walk(path) {
  for (const entry of readdirSync(path)) {
    if (skipDirectories.has(entry)) continue;
    const absolute = join(path, entry);
    const relativePath = normalize(relative(repoRoot, absolute));
    if (isForbiddenPath(relativePath)) {
      fail(`Forbidden private path: ${relativePath}`);
      continue;
    }
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (entry === '.DS_Store' || entry.endsWith('.tgz') || entry === '.env' || entry.startsWith('.env.')) {
      fail(`Forbidden release file: ${relativePath}`);
      continue;
    }
    if (entry.endsWith('.md') && !allowedMarkdown.has(relativePath)) fail(`Unapproved Markdown file: ${relativePath}`);
    if (isTextFile(absolute)) inspectText(absolute, relativePath);
  }
}

for (const entry of readdirSync(repoRoot)) {
  if (entry !== '.git' && !skipDirectories.has(entry) && !allowedTopLevel.has(entry)) {
    fail(`Unexpected top-level release path: ${entry}`);
  }
}
walk(repoRoot);

const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
if (rootPackage.private !== true) fail('Root package must remain private');
if (rootPackage.scripts?.['check:public'] !== 'node scripts/check-public-release.mjs') {
  fail('Root package must expose scripts.check:public');
}
if (rootPackage.scripts?.['sync:public']) fail('Public package.json must not expose the private sync command');

const publicRepository = `git+${config.publicRepository}`;
const publicIssues = config.publicRepository.replace(/\.git$/, '/issues');
const publishSet = new Set(config.publishPackages);
for (const directory of readdirSync(join(repoRoot, 'packages'))) {
  const workspace = `packages/${directory}`;
  const packagePath = join(repoRoot, workspace, 'package.json');
  if (!existsSync(packagePath)) continue;
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!publishSet.has(workspace)) {
    if (pkg.private !== true) fail(`${workspace} must be private or listed in publishPackages`);
    continue;
  }
  if (pkg.private === true) fail(`${workspace} is listed for publication but marked private`);
  if (pkg.repository?.url !== publicRepository || pkg.repository?.directory !== workspace) {
    fail(`${workspace} repository metadata must point to the public monorepo directory`);
  }
  if (pkg.bugs?.url !== publicIssues) fail(`${workspace} bugs URL must point to the public repository`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail(`${workspace} must declare an npm files allowlist`);
  if (pkg.license !== 'MIT') fail(`${workspace} must declare the MIT license`);
}

for (const workspace of publishSet) {
  if (!existsSync(join(repoRoot, workspace, 'package.json'))) fail(`Publish package is missing: ${workspace}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`public-release-check: ${failure}`);
  process.exit(1);
}
console.log(`public-release-check: passed for ${repoRoot}`);
