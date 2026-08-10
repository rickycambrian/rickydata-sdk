import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  prepareLearningRun,
  publishLearningBundle,
  publishLearningInspection,
  sealLearningBundle,
  stageLearningRepository,
  validateLearningBundle,
  validateLearningPolicy,
  validateLearningRunPlan,
  type LearningInspectionV1,
  type LearningSourceManifestV1,
} from '../../learning/index.js';

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw new Error(`Unable to read JSON file: ${path}`); }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function createLearnCommands(): Command {
  const learn = new Command('learn').description('Build and publish private repository learning bundles');

  learn.command('prepare')
    .requiredOption('--mode <mode>', 'inspect or generate')
    .requiredOption('--policy <file>', 'learning policy JSON')
    .requiredOption('--output <file>', 'run plan output JSON')
    .option('--enrollment-code <code>', 'single-use enrollment code')
    .option('--gateway <url>', 'Agent Gateway URL', 'https://agents.rickydata.org')
    .action(async (options) => {
      if (options.mode !== 'inspect' && options.mode !== 'generate') throw new Error('Mode must be inspect or generate');
      const policy = validateLearningPolicy(await readJson(options.policy));
      const plan = await prepareLearningRun(options.gateway, { mode: options.mode, policy, ...(options.enrollmentCode ? { enrollmentCode: options.enrollmentCode } : {}) });
      await writeJson(options.output, plan);
      console.log(JSON.stringify({ status: 'prepared', mode: plan.mode, runId: plan.runId, repository: plan.repository.fullName, cursor: plan.cursorSha ? 'present' : 'empty' }));
    });

  learn.command('stage')
    .requiredOption('--plan <file>', 'run plan JSON')
    .requiredOption('--output <directory>', 'sanitized analysis directory')
    .option('--repository <directory>', 'checked-out repository root', '.')
    .action(async (options) => {
      const plan = validateLearningRunPlan(await readJson(options.plan));
      const manifest = await stageLearningRepository({ repositoryRoot: options.repository, outputDirectory: options.output, plan });
      console.log(JSON.stringify({ status: 'staged', files: manifest.files.length, bytes: manifest.totalBytes, commits: manifest.commits.length, digest: manifest.digest }));
    });

  learn.command('seal')
    .requiredOption('--plan <file>', 'run plan JSON')
    .requiredOption('--stage <directory>', 'sanitized analysis directory')
    .requiredOption('--candidate <file>', 'author candidate JSON')
    .requiredOption('--verification <file>', 'independent verification JSON')
    .requiredOption('--output <file>', 'sealed bundle output JSON')
    .action(async (options) => {
      const stage = resolve(options.stage);
      const bundle = await sealLearningBundle({
        plan: validateLearningRunPlan(await readJson(options.plan)),
        manifest: await readJson(join(stage, '.rickydata', 'source-manifest.json')) as LearningSourceManifestV1,
        candidate: await readJson(options.candidate), verification: await readJson(options.verification), stagedDirectory: stage,
      });
      await writeJson(options.output, bundle);
      console.log(JSON.stringify({ status: 'sealed', lessons: bundle.candidate.lessons.length, digest: bundle.digest }));
    });

  learn.command('publish')
    .option('--bundle <file>', 'sealed bundle JSON')
    .option('--manifest <file>', 'source manifest JSON for inspect mode')
    .requiredOption('--plan <file>', 'run plan JSON')
    .option('--gateway <url>', 'Agent Gateway URL', 'https://agents.rickydata.org')
    .action(async (options) => {
      if (!!options.bundle === !!options.manifest) throw new Error('Provide exactly one of --bundle or --manifest');
      const plan = validateLearningRunPlan(await readJson(options.plan));
      if (options.manifest) {
        const manifest = await readJson(options.manifest) as LearningSourceManifestV1;
        const inspection: LearningInspectionV1 = {
          version: 1, runId: plan.runId, repository: plan.repository, ref: plan.ref, headSha: manifest.headSha,
          sourceDigest: manifest.digest, fileCount: manifest.files.length, totalBytes: manifest.totalBytes, commitCount: manifest.commits.length,
        };
        await publishLearningInspection(options.gateway, inspection);
        console.log(JSON.stringify({ status: 'inspected', files: inspection.fileCount, bytes: inspection.totalBytes, commits: inspection.commitCount, digest: inspection.sourceDigest }));
        return;
      }
      const bundle = validateLearningBundle(await readJson(options.bundle));
      await publishLearningBundle(options.gateway, bundle);
      console.log(JSON.stringify({ status: 'published', lessons: bundle.candidate.lessons.length, digest: bundle.digest }));
    });

  return learn;
}
