// Validate the command from the workflow with the real CLI parser. An absent
// config intentionally stops execution before authentication or remote writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const modulePath = process.env.JFW_WRANGLER_MODULE || 'wrangler';
const cli = path.join(path.dirname(require.resolve(`${modulePath}/package.json`)), 'bin/wrangler.js');
const workflow = fs.readFileSync(new URL('../../.github/workflows/public-worker-deploy.yml', import.meta.url), 'utf8');
const line = workflow.split('\n').find(value => /^\s*npx --yes wrangler@4 secret delete API_FOOTBALL_KEY\b/.test(value));
assert.ok(line, 'actual cleanup command must be present');
assert.doesNotMatch(line, /[$`"'\\]/, 'complex shell syntax needs an explicit parser');
const args = line.trim().split(/\s+/).slice(3);
const index = args.indexOf('--config');
assert.ok(index >= 0 && args[index + 1]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-cleanup-cli-'));
args[index + 1] = path.join(temp, 'intentionally-absent.toml');
const childEnv = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' };
function rejection(command) {
  try { execFileSync(process.execPath, [cli, ...command], { env: childEnv, encoding: 'utf8', stdio: 'pipe', timeout: 15000 }); }
  catch (error) { return `${error.stdout || ''}${error.stderr || ''}`; }
  throw new Error('CLI unexpectedly reached successful command execution');
}
try {
  const parsed = rejection(args);
  assert.match(parsed, /Could not read file:/, parsed);
  assert.doesNotMatch(parsed, /Unknown argument/);
  // This is the exact flag that broke deployment; the real parser must reject it.
  assert.match(rejection([...args, '--force']), /Unknown argument: force/);
  console.log('PASS: actual public secret cleanup arguments parse; unsupported --force is rejected; no remote changes');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
