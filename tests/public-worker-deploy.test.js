'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'config', 'public-worker-target.json');

test('public Worker target and rendered configuration lock the reviewed origins and resources', async t => {
  const { loadPublicWorkerTarget, renderPublicWrangler } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = loadPublicWorkerTarget(manifestPath);
  assert.equal(target.workerName, 'jfw-football-data-v2');
  assert.equal(target.workerOrigin, 'https://jfw-football-data-v2.ssdkllpd.workers.dev');
  assert.equal(target.appOrigin, 'https://ssdkllpd.github.io');
  assert.equal(target.r2BucketName, 'jfw-football-data');
  assert.equal(target.d1DatabaseId, 'fdfd74e4-2702-4aa2-ab20-c062e952fe25');
  assert.equal(target.d1CutoverAuthorization.migrationWorkflowRunId, 35090817724);
  assert.equal(
    target.d1CutoverAuthorization.migrationCommit,
    '8ce12d98017286ed18682583fea71951525724ef',
  );
  assert.equal(
    target.d1CutoverAuthorization.migrationTree,
    '2e5b35e746f9babedf402ec628bf25f4df8d26f0',
  );
  assert.equal(
    target.d1CutoverAuthorization.migrationArtifactSha256,
    'f0e16d1c741c7d47e22b989ec5b5e40afba570d71cb57c9b848b5faa7401e68a',
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-public-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rendered = renderPublicWrangler(target, path.join(directory, 'wrangler.toml'));
  assert.match(rendered, /name = "jfw-football-data-v2"/);
  assert.match(rendered, /workers_dev = true/);
  assert.match(rendered, /binding = "FOOTBALL_DATA"/);
  assert.match(rendered, /binding = "FOOTBALL_DB"/);
  assert.match(rendered, /APP_ORIGINS = "https:\/\/ssdkllpd.github.io"/);
  assert.match(rendered, /LIVE_COMPETITION_IDS = "39,40,61,78,88,94,135,140,144,179"/);
  for (const flag of Object.keys(target.d1ReadFlags)) {
    assert.match(rendered, new RegExp(`${flag} = "true"`));
  }
  const rollback = renderPublicWrangler(target, path.join(directory, 'rollback.toml'), {
    disableD1Reads: true,
  });
  for (const flag of Object.keys(target.d1ReadFlags)) {
    assert.match(rollback, new RegExp(`${flag} = "false"`));
  }
  assert.equal(rendered.includes('API_FOOTBALL_KEY'), false);
});

test('committed Web UI configuration points at the reviewed public Worker origin', async () => {
  const vm = require('node:vm');
  const { loadPublicWorkerTarget } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = loadPublicWorkerTarget(manifestPath);
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app-v2-config.js'), 'utf8'), context);
  assert.equal(context.window.FOOTBALL_V2_CONFIG.apiBase, target.workerOrigin);
  assert.equal(context.window.FOOTBALL_V2_CONFIG.trackingEnabled, false);
  assert.equal(context.window.FOOTBALL_V2_CONFIG.attentionEnabled, false);
});

test('public Worker renderer rejects target drift and unreviewed D1 read flags', async () => {
  const { loadPublicWorkerTarget } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-public-target-'));
  try {
    const drifted = path.join(directory, 'drifted.json');
    fs.writeFileSync(drifted, JSON.stringify({ ...target, workerOrigin: 'https://other.workers.dev' }));
    assert.throws(() => loadPublicWorkerTarget(drifted), /workerOrigin does not match/);
    const unauthorized = path.join(directory, 'unauthorized.json');
    fs.writeFileSync(unauthorized, JSON.stringify({
      ...target,
      d1CutoverAuthorization: {
        ...target.d1CutoverAuthorization,
        authorizedFlags: target.d1CutoverAuthorization.authorizedFlags
          .filter(name => name !== 'D1_STANDINGS_ENABLED'),
      },
    }));
    assert.throws(() => loadPublicWorkerTarget(unauthorized), /not authorized.*D1_STANDINGS_ENABLED/);

    const wrongDatabase = path.join(directory, 'wrong-database.json');
    fs.writeFileSync(wrongDatabase, JSON.stringify({
      ...target,
      d1CutoverAuthorization: {
        ...target.d1CutoverAuthorization,
        databaseId: '00000000-0000-0000-0000-000000000000',
      },
    }));
    assert.throws(() => loadPublicWorkerTarget(wrongDatabase), /databaseId does not match/);

    const { d1CutoverAuthorization, d1ReadProbes, ...withoutAuthorization } = target;
    const disabled = path.join(directory, 'disabled.json');
    fs.writeFileSync(disabled, JSON.stringify({
      ...withoutAuthorization,
      d1ReadFlags: Object.fromEntries(Object.keys(target.d1ReadFlags).map(name => [name, false])),
    }));
    assert.doesNotThrow(() => loadPublicWorkerTarget(disabled));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deployment verifies every D1 route and automatically rolls back failed cutover checks', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'public-worker-deploy.yml'), 'utf8',
  );
  assert.match(workflow, /push:[\s\S]*branches: \[main\]/);
  assert.match(workflow, /scripts\/d1\/fixture-repository\.js/);
  assert.match(workflow, /environment: d1-staging/);
  const render = workflow.indexOf('render-public-wrangler.mjs');
  const deploy = workflow.indexOf('wrangler@4 deploy');
  const secret = workflow.indexOf('secret put API_FOOTBALL_KEY');
  const health = workflow.indexOf('Verify allowed-origin health and CORS');
  const d1Reads = workflow.indexOf('Verify every enabled D1 public read path');
  const rollback = workflow.indexOf('Roll back all D1 public reads');
  assert.equal(
    render > 0 && deploy > render && secret > deploy && health > secret
      && d1Reads > health && rollback > d1Reads,
    true,
  );
  assert.match(workflow, /access-control-allow-origin/);
  assert.match(workflow, /x-jfw-data-source: d1/);
  assert.match(workflow, /api\/v2\/dates/);
  assert.match(workflow, /api\/v2\/competitions/);
  assert.match(workflow, /api\/v2\/fixtures/);
  assert.match(workflow, /--disable-d1-reads/);
  assert.match(workflow, /failure\(\).*steps\.deploy\.outcome == 'success'/);
  assert.match(workflow, /--retry-all-errors/);
  assert.match(workflow, /test "\$status" = '403'/);
  assert.equal(workflow.includes('d1 execute'), false);
  assert.equal(workflow.includes('d1 migrations apply'), false);
});

const workflow = fs.readFileSync(path.join(root, '.github/workflows/public-worker-deploy.yml'), 'utf8');

function deploymentStep(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, name);
  const rest = workflow.slice(start);
  const end = rest.indexOf('\n      - ', 1);
  const block = end < 0 ? rest : rest.slice(0, end);
  const match = block.match(/        run: (\||>-)[^\n]*\n([\s\S]*)/);
  assert.ok(match, name);
  const lines = [];
  for (const line of match[2].split('\n')) {
    if (line.trim() && !line.startsWith('          ')) break;
    lines.push(line.replace(/^          /, ''));
  }
  return match[1] === '>-' ? lines.join(' ') : lines.join('\n');
}

function shell(script, directory, env = {}) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: directory, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000,
  });
}

test('public deployment requires successful same-commit migration and Admin deployment after preflight', () => {
  const provision = workflow.split('\n  provision:\n')[1].split('\n  deploy:\n')[0];
  const deploy = workflow.split('\n  deploy:\n')[1];
  assert.match(provision, /^    needs: preflight$/m);
  assert.match(provision, /^    uses: \.\/\.github\/workflows\/d1-staging-provision\.yml$/m);
  assert.match(provision, /^    secrets: inherit$/m);
  assert.match(deploy, /^    needs: provision$/m);
  assert.doesNotMatch(provision, /\bif:|continue-on-error/);
  assert.doesNotMatch(deploy.split('    steps:')[0], /\bif:|continue-on-error/);
  assert.match(workflow, /group: public-worker-deploy/);
  for (const dependency of ['admin-worker/**', 'migrations/**', '.github/workflows/d1-staging-provision.yml']) {
    assert.ok(workflow.includes(`- '${dependency}'`), dependency);
  }
  const provisionWorkflow = fs.readFileSync(path.join(root, '.github/workflows/d1-staging-provision.yml'), 'utf8');
  assert.match(provisionWorkflow, /workflow_call:/);
  assert.match(provisionWorkflow, /group: d1-staging-write/);
  assert.doesNotMatch(provisionWorkflow, /continue-on-error|if:.*always\(/);
});

test('Admin provisioning holds the staging write lock on its job without a nested caller lock', () => {
  const provisionWorkflow = fs.readFileSync(path.join(root, '.github/workflows/d1-staging-provision.yml'), 'utf8');
  assert.doesNotMatch(provisionWorkflow.split('\njobs:')[0], /concurrency:/);
  assert.match(provisionWorkflow, /apply-schema-and-deploy-admin:\n    concurrency:\n      group: d1-staging-write\n      queue: max\n      cancel-in-progress: false/);
  const caller = workflow.split('\n  provision:\n')[1].split('\n  deploy:\n')[0];
  assert.doesNotMatch(caller, /concurrency:|group:/);
});

test('deployment includes cancellation in rollback and bounds every curl request', () => {
  const rollback = workflow.split('- name: Roll back all D1 public reads')[1].split('- name: Upload public deployment evidence')[0];
  assert.match(rollback, /if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && steps\.deploy\.outcome == 'success' \}\}/);
  const commands = workflow.match(/curl[^\n]*(?:\\\n[^\n]*)*/g);
  assert.equal(commands.length, 6);
  for (const command of commands) {
    assert.match(command, /--connect-timeout 5\b/);
    assert.match(command, /--max-time 20\b/);
    if (command.includes('--retry ')) assert.match(command, /--retry-max-time 60\b/);
  }
  assert.ok(workflow.indexOf('mkdir -p .tmp/public-worker/evidence') < workflow.indexOf('- name: Deploy public read Worker'));
});

test('actual deployment preflight rejects missing secrets before any write', async t => {
  const script = deploymentStep('Validate deployment prerequisites before any remote write');
  const env = {
    CLOUDFLARE_API_TOKEN: 'offline-cloudflare', CLOUDFLARE_ACCOUNT_ID: 'offline-account',
    ADMIN_INGEST_TOKEN: 'offline-admin', API_FOOTBALL_KEY: 'offline-provider',
    PUBLIC_DATE_AUDIT_TOKEN: 'offline-audit-token-32-characters-long',
    ADMIN_WORKER_NAME: 'jfw-football-admin-ingest-staging',
    ADMIN_INGEST_URL: 'https://jfw-football-admin-ingest-staging.ssdkllpd.workers.dev',
    D1_DATABASE_NAME: 'jfw-football-staging',
    D1_DATABASE_ID: 'fdfd74e4-2702-4aa2-ab20-c062e952fe25', R2_BUCKET: 'jfw-football-data',
  };
  for (const [name, overrides, expected] of [
    ['valid', {}, 0],
    ...['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ADMIN_INGEST_TOKEN', 'API_FOOTBALL_KEY', 'PUBLIC_DATE_AUDIT_TOKEN']
      .map(name => [name, { [name]: '' }, 1]),
    ['short audit token', { PUBLIC_DATE_AUDIT_TOKEN: 'a'.repeat(31) }, 1],
    ['wrong target', { D1_DATABASE_ID: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, 1],
  ]) {
    await t.test(name, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-deploy-preflight-'));
      try {
        for (const entry of ['scripts', 'config', 'migrations']) fs.cpSync(path.join(root, entry), path.join(directory, entry), { recursive: true });
        const result = shell(script, directory, { ...env, ...overrides });
        assert.equal(result.status, expected, result.stderr);
        assert.equal(fs.existsSync(path.join(directory, '.tmp/public-worker/wrangler.toml')), expected === 0);
        assert.equal(`${result.stdout}${result.stderr}`.includes(env.PUBLIC_DATE_AUDIT_TOKEN), false);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }
  assert.doesNotMatch(script, /npx|fetch|curl|wrangler@4/);
});

test('actual audit secret installation sends the exact token on stdin and preserves failures', async t => {
  const script = deploymentStep('Install dedicated public date audit secret');
  assert.match(workflow, /PUBLIC_DATE_AUDIT_TOKEN: \$\{\{ secrets\.PUBLIC_DATE_AUDIT_TOKEN \}\}/);
  assert.ok(workflow.indexOf('Install dedicated public date audit secret') > workflow.indexOf('Deploy public read Worker'));
  assert.ok(workflow.indexOf('Verify authenticated fresh date reads') > workflow.indexOf('Install dedicated public date audit secret'));
  for (const failure of [false, true]) {
    await t.test(failure ? 'failed installation stops the step' : 'token bytes are unchanged', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-deploy-secret-'));
      try {
        fs.writeFileSync(path.join(directory, 'npx'), `#!${process.execPath}\nconst fs=require('node:fs');
const input=fs.readFileSync(0,'utf8');
const ok=input===process.env.PUBLIC_DATE_AUDIT_TOKEN && process.argv.slice(2).join(' ')==='--yes wrangler@4 secret put PUBLIC_DATE_AUDIT_TOKEN --config .tmp/public-worker/wrangler.toml';
process.exit(ok && process.env.FAIL_INSTALL!=='true' ? 0 : 22);
`, { mode: 0o755 });
        const result = shell(script, directory, {
          PATH: `${directory}:${process.env.PATH}`, PUBLIC_DATE_AUDIT_TOKEN: 'a'.repeat(32), FAIL_INSTALL: String(failure),
        });
        assert.equal(result.status, failure ? 22 : 0, result.stderr);
        assert.equal(`${result.stdout}${result.stderr}`.includes('a'.repeat(32)), false);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }
});

test('actual fresh deployment probe checks both authenticated feeds and refuses incomplete evidence', async t => {
  const script = deploymentStep('Verify authenticated fresh date reads');
  for (const mode of ['valid', 'valid-token-collision', 'unauthorized', 'cached', 'r2-fallback', 'wrong-date', 'wrong-competition', 'missing-fixture', 'fresh-open', 'fresh-open-competition', 'missing-token-open', 'wrong-token-open', 'denial-cached', 'denial-503', 'timeout']) {
    await t.test(mode, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-deploy-fresh-'));
      try {
        fs.mkdirSync(path.join(directory, 'bin'));
        fs.symlinkSync(path.join(root, 'config'), path.join(directory, 'config'), 'dir');
        fs.writeFileSync(path.join(directory, 'bin/curl'), `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2), url=args.at(-1), mode=process.env.PROBE_MODE;
const value=flag=>args[args.indexOf(flag)+1];
const target=JSON.parse(fs.readFileSync('config/public-worker-target.json','utf8'));
const headers=args.flatMap((v,i)=>v==='--header'?[args[i+1]]:[]);
const sent=headers.find(v=>v.startsWith('x-jfw-audit-token: '))?.slice('x-jfw-audit-token: '.length);
const authed=sent===process.env.PUBLIC_DATE_AUDIT_TOKEN;
if(!headers.includes('Origin: '+target.appOrigin) || !url.endsWith('?fresh=1')) process.exit(22);
if(value('--connect-timeout')!=='5' || value('--max-time')!=='20' || value('--retry-max-time')!=='60') process.exit(99);
if(mode==='timeout') process.exit(28);
const competition=url.includes('/competitions/');
fs.appendFileSync('requests.jsonl',JSON.stringify({competition,fresh:true,authenticated:authed,tokenKind:authed?'valid':sent===undefined?'none':'wrong'})+'\\n');
const open=mode==='fresh-open' || (mode==='fresh-open-competition' && competition) || (mode==='missing-token-open' && sent===undefined) || (mode==='wrong-token-open' && sent!==undefined && !authed);
const status=authed || open ? (mode==='unauthorized'?401:200) : mode==='denial-503'?503:401;
const cached=mode==='cached' || (mode==='denial-cached' && !authed);
fs.writeFileSync(value('--dump-header'),'HTTP/2 '+status+'\\r\\naccess-control-allow-origin: '+target.appOrigin+'\\r\\ncache-control: '+(cached?'public, max-age=300':'no-store')+'\\r\\nx-jfw-data-source: '+(mode==='r2-fallback'?'r2':'d1')+'\\r\\n');
if(value('--output')!=='/dev/null') fs.writeFileSync(value('--output'),JSON.stringify({date:mode==='wrong-date'?'2000-01-01':target.d1ReadProbes.date,fixtures:mode==='missing-fixture'?[]:[{fixtureId:target.d1ReadProbes.fixtureId}],...(competition?{competition:{id:mode==='wrong-competition'?'af:competition:999':target.d1ReadProbes.competitionId}}:{})}));
if(args.includes('--write-out')) process.stdout.write(String(status));
if(args.includes('--fail') && status>=400) process.exit(22);
`, { mode: 0o755 });
        const auditToken = mode === 'valid-token-collision' ? 'invalid-public-date-audit-token-01' : 'a'.repeat(32);
        const result = shell(script, directory, {
          PATH: `${directory}/bin:${process.env.PATH}`, PROBE_MODE: mode, PUBLIC_DATE_AUDIT_TOKEN: auditToken,
        });
        const report = path.join(directory, '.tmp/public-worker/evidence/fresh-date-audit-report.json');
        if (mode === 'valid' || mode === 'valid-token-collision') {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), { passed: true, authenticated: true, cacheControl: 'no-store', routes: 2, rejectedUnauthenticatedRequests: 4 });
          assert.deepEqual(fs.readFileSync(path.join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [
            { competition: false, fresh: true, authenticated: true, tokenKind: 'valid' },
            { competition: true, fresh: true, authenticated: true, tokenKind: 'valid' },
            { competition: false, fresh: true, authenticated: false, tokenKind: 'none' },
            { competition: false, fresh: true, authenticated: false, tokenKind: 'wrong' },
            { competition: true, fresh: true, authenticated: false, tokenKind: 'none' },
            { competition: true, fresh: true, authenticated: false, tokenKind: 'wrong' },
          ]);
        } else {
          assert.notEqual(result.status, 0, `${mode} was accepted`);
          assert.equal(fs.existsSync(report), false);
        }
        assert.equal(`${result.stdout}${result.stderr}`.includes(auditToken), false);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
