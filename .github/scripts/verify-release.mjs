#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = JSON.parse(readFileSync('public-release.json', 'utf8'));
const packages = config.publishPackages.map((workspace) => {
  const pkg = JSON.parse(readFileSync(`${workspace}/package.json`, 'utf8'));
  return { name: pkg.name, version: pkg.version };
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
for (let attempt = 1; attempt <= 36; attempt += 1) {
  const missing = packages.filter(({ name, version }) => spawnSync('npm', ['view', `${name}@${version}`, 'version']).status !== 0);
  if (!missing.length) break;
  if (attempt === 36) throw new Error(`npm registry did not expose: ${missing.map(({ name, version }) => `${name}@${version}`).join(', ')}`);
  await delay(10_000);
}

for (const { name, version } of packages) {
  const repository = execFileSync('npm', ['view', `${name}@${version}`, 'repository.url'], { encoding: 'utf8' }).trim();
  if (!repository.includes('rickycambrian/rickydata-sdk')) throw new Error(`${name}@${version} has incorrect repository metadata`);
}

const installRoot = mkdtempSync(join(tmpdir(), 'rickydata-release-verify-'));
try {
  writeFileSync(join(installRoot, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...packages.map(({ name, version }) => `${name}@${version}`)], {
    cwd: installRoot,
    stdio: 'inherit',
  });
  const imports = packages.map(({ name }) => `import(${JSON.stringify(name)})`).join(',');
  execFileSync(process.execPath, ['--input-type=module', '-e', `await Promise.all([${imports}])`], { cwd: installRoot, stdio: 'inherit' });
  const coreVersion = packages.find(({ name }) => name === 'rickydata').version;
  const cliVersion = execFileSync('npx', ['--yes', `rickydata@${coreVersion}`, '--version'], { cwd: installRoot, encoding: 'utf8' }).trim();
  if (cliVersion !== coreVersion) throw new Error(`CLI returned ${cliVersion}, expected ${coreVersion}`);
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}

for (const url of ['https://mcp.rickydata.org/health', 'https://agents.rickydata.org/health', 'https://marketplace.rickydata.org']) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
}

console.log(`Verified ${packages.map(({ name, version }) => `${name}@${version}`).join(', ')}`);
