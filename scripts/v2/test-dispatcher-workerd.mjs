// Run the production dispatch function with native workerd fetch and local R2.
// Outbound traffic terminates in an in-process GitHub stub; no credentials or
// external provider/GitHub requests are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wrangler = process.env.JFW_WRANGLER_MODULE || 'wrangler';
const wranglerRoot = path.dirname(require.resolve(`${wrangler}/package.json`));
assert.equal(JSON.parse(fs.readFileSync(path.join(wranglerRoot, 'package.json'))).version, '4.147.0');
const { Miniflare, convertV4MiniflareOptions } = require(require.resolve('miniflare', { paths: [wranglerRoot] }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-dispatcher-workerd-'));
const source = fs.readFileSync(path.join(root, 'dispatcher-worker/index.mjs'), 'utf8');
const calls = [];
let redirectStage;
let runtime;
try {
  runtime = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: temp,
    modules: [
      { type: 'ESModule', path: path.join(temp, 'harness.mjs'), contents: `
        import { dispatchScheduled } from './dispatcher.mjs';
        export default { async fetch(request, env) {
          const epoch = new URL(request.url).pathname.slice(1) || 'runtime-1';
          try {
            const result = await dispatchScheduled({ scheduledTime: Date.parse('2026-10-16T06:00:00Z') }, { ...env, DISPATCH_EPOCH: epoch });
            return Response.json(result);
          } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
        } };
      ` },
      { type: 'ESModule', path: path.join(temp, 'dispatcher.mjs'), contents: source },
    ],
    // The pinned local binary supports dates through 2026-10-08.
    compatibilityDate: '2026-10-08',
    bindings: { DISPATCH_ENABLED: 'true', WORKFLOW_DISPATCH_TOKEN: 'local-test-only' },
    r2Buckets: ['DISPATCH_STATE'],
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://api.github.com');
      assert.match(url.pathname, /^\/repos\/ssdkllpd\/japanese-football-watch\/actions\/workflows\/api-football-(automation|schedule-sync)\.yml\/(runs|dispatches)$/);
      assert.equal(request.headers.get('authorization'), 'Bearer local-test-only');
      calls.push({ method: request.method, path: url.pathname });
      if (redirectStage === 'inspection' || (redirectStage === 'dispatch' && request.method === 'POST')) {
        return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/' } });
      }
      if (request.method === 'GET') return Response.json({ workflow_runs: [] });
      assert.equal((await request.json()).ref, 'main');
      return new Response(null, { status: 204 });
    },
  }));
  const response = await runtime.dispatchFetch('http://local.test/runtime-1');
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.results.map(item => item.status), ['accepted', 'accepted']);
  assert.equal(calls.length, 4);
  const repeat = await runtime.dispatchFetch('http://local.test/runtime-1');
  assert.deepEqual((await repeat.json()).results.map(item => item.status), ['already_attempted', 'already_attempted']);
  assert.equal(calls.length, 4, 'local R2 claims must prevent duplicate fetches');
  for (const stage of ['inspection', 'dispatch']) {
    redirectStage = stage;
    const before = calls.length;
    const redirected = await runtime.dispatchFetch(`http://local.test/${stage}`);
    assert.equal(redirected.status, 500);
    assert.match((await redirected.json()).error, stage === 'inspection' ? /inspection HTTP 302/ : /rejected/);
    assert.equal(calls.length - before, stage === 'inspection' ? 1 : 2);
  }
  console.log('PASS: workerd native fetch, two dispatches, R2 deduplication, and redirect rejection');
} finally {
  await runtime?.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
}
