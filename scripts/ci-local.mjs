#!/usr/bin/env node
/**
 * LOCAL CI: the jobs from .github/workflows/ci.yml, run on this machine.
 *
 * The same steps and environment as CI (no provider keys, no database), for when you want the verdict
 * before pushing.
 *
 *   node scripts/ci-local.mjs                 install, typecheck, build
 *   node scripts/ci-local.mjs --jobs build    a subset
 *   node scripts/ci-local.mjs --post-status   also report each verdict on HEAD as a GitHub commit
 *                                             status (context local-ci/<job>); refused on a dirty tree,
 *                                             since the verdict would describe code HEAD doesn't have
 */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JOBS = {
  install: ['bun', ['install', '--frozen-lockfile']],
  typecheck: ['bun', ['run', 'typecheck']],
  build: ['bun', ['run', 'build']],
};

const args = process.argv.slice(2);
const jobsIndex = args.indexOf('--jobs');
const jobs = jobsIndex >= 0 ? args[jobsIndex + 1].split(',') : Object.keys(JOBS);
for (const job of jobs) if (!JOBS[job]) throw new Error(`Unknown job "${job}". Jobs: ${Object.keys(JOBS).join(', ')}`);
const postStatus = args.includes('--post-status');

const git = (...command) => execFileSync('git', command, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain').length > 0;
if (postStatus && dirty) {
  console.error('Refusing --post-status with uncommitted changes: the verdict would describe code HEAD does not have.');
  process.exit(2);
}
if (postStatus) {
  // A status can only be attached to a commit GitHub already has.
  try { execFileSync('git', ['fetch', '-q', 'origin', branch], { stdio: 'ignore' }); } catch {}
  let pushed = false;
  try { pushed = git('branch', '-r', '--contains', sha).length > 0; } catch {}
  if (!pushed) {
    console.error(`Push ${sha.slice(0, 12)} first: GitHub can only attach a status to a commit it has.`);
    process.exit(2);
  }
}

// CI's environment: no provider keys, no app database; only the disposable test server.
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(OPENAI|COMPOSIO|CONTEXT_DEV|ANTHROPIC|TYPESAFE|DATABASE_URL|APP_BASE_URL|CRON_SECRET|ADMIN_SECRET|IP_HASH_SALT)/.test(key)) delete env[key];
env.CI = 'true';

const logDir = join(tmpdir(), `persona-ci-${sha.slice(0, 12)}`);
mkdirSync(logDir, { recursive: true });

function run(job) {
  const [command, commandArgs] = JOBS[job];
  const logPath = join(logDir, `${job}.log`);
  const log = createWriteStream(logPath);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { env, shell: process.platform === 'win32' });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', (code) => {
      log.end();
      resolve({ job, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000), logPath });
    });
  });
}

// A clean checkout has no generated route types; stale ones from a dev server can name deleted routes.
rmSync('.next/types', { recursive: true, force: true });
console.log(`local CI on ${branch} @ ${sha.slice(0, 12)}${dirty ? ' (with UNCOMMITTED changes)' : ''}: ${jobs.join(', ')}`);
console.log(`logs: ${logDir}`);
const results = [];
for (const job of jobs) {
  process.stdout.write(`  ${job.padEnd(10)} running…`);
  const result = await run(job);
  results.push(result);
  process.stdout.write(`\r  ${job.padEnd(10)} ${result.ok ? 'PASS' : 'FAIL'}  ${result.seconds}s${result.ok ? '' : `  → ${result.logPath}`}\n`);
  if (!result.ok && job === 'install') break;
}

if (postStatus) {
  const slug = git('remote', 'get-url', 'origin').match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
  if (!slug) console.error('Could not read the GitHub repo from origin; no statuses posted.');
  for (const result of slug ? results : []) {
    execFileSync('gh', [
      'api', '-X', 'POST', `repos/${slug}/statuses/${sha}`,
      '-f', `state=${result.ok ? 'success' : 'failure'}`,
      '-f', `context=local-ci/${result.job}`,
      '-f', `description=${result.ok ? 'passed' : 'failed'} locally in ${result.seconds}s (scripts/ci-local.mjs)`,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (slug) console.log(`posted ${results.length} status(es) to ${slug}@${sha.slice(0, 12)}`);
}

process.exit(results.every((result) => result.ok) ? 0 : 1);
