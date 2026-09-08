import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_WORKER = 'jfw-football-data-v2';
const PUBLIC_VARS = new Set(['APP_ORIGINS', 'ALLOW_NO_ORIGIN',
  'D1_DATE_INDEX_ENABLED', 'D1_COMPETITION_DATE_INDEX_ENABLED',
  'D1_STANDINGS_ENABLED', 'D1_FIXTURE_DETAIL_ENABLED']);

// Read-only Cloudflare control-plane inspection. Never serialize raw API
// responses: Worker bindings may contain credentials or unrelated settings.
export async function inspectConnection(env, fetchImpl = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(account || '') || !token) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.');
  }
  const checks = [];
  async function get(label, suffix) {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/${suffix}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      const ok = response.ok && body.success === true;
      checks.push({ check: label, ok, httpStatus: response.status,
        errorCodes: Array.isArray(body.errors) ? body.errors.map(e => e.code).filter(Number.isInteger) : [] });
      return ok ? body.result : null;
    } catch {
      checks.push({ check: label, ok: false, reason: 'network_timeout_redirect_or_invalid_response' });
      return null;
    }
  }
  const scripts = await get('list_workers', 'workers/scripts');
  const subdomain = await get('account_subdomain', 'workers/subdomain');
  const names = Array.isArray(scripts)
    ? scripts.map(s => s.id).filter(n => typeof n === 'string' && /^jfw-football[a-z0-9-]*$/.test(n)) : [];
  const listed = Array.isArray(scripts) ? names.includes(PUBLIC_WORKER) : null;
  let settings = null;
  let availability = null;
  if (listed !== false) {
    settings = await get('public_worker_settings', `workers/scripts/${PUBLIC_WORKER}/settings`);
    availability = await get('public_worker_subdomain', `workers/scripts/${PUBLIC_WORKER}/subdomain`);
  }
  const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
  const publicVars = {};
  for (const binding of bindings) {
    if (binding.type === 'plain_text' && PUBLIC_VARS.has(binding.name) && typeof binding.text === 'string') {
      publicVars[binding.name] = binding.text;
    }
  }
  const suffix = subdomain?.subdomain;
  const candidateOrigin = typeof suffix === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(suffix)
    ? `https://${PUBLIC_WORKER}.${suffix}.workers.dev` : null;
  return {
    schemaVersion: 'jfw-cloudflare-connection-inspection/1',
    workerName: PUBLIC_WORKER, listed, projectWorkerNames: names, checks,
    workersDevEnabled: typeof availability?.enabled === 'boolean' ? availability.enabled : null,
    candidateOrigin,
    publicVars,
    bindings: bindings.filter(b => ['FOOTBALL_DATA', 'FOOTBALL_DB'].includes(b.name))
      .map(b => ({ name: b.name, type: b.type })),
    liveHttpVerified: false,
    note: 'Candidate URL comes from account configuration; HTTP/CORS behavior and data readiness are not verified. Custom domains and routes are not inspected. No configuration was changed.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectConnection(process.env);
    fs.mkdirSync('.tmp/cloudflare-connection', { recursive: true });
    fs.writeFileSync('.tmp/cloudflare-connection/report.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.listed !== true || report.checks.some(c => !c.ok)) process.exitCode = 1;
  } catch {
    console.error('Connection inspection could not start. Check the configured Cloudflare credentials.');
    process.exitCode = 1;
  }
}
