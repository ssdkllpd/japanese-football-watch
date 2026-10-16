#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function renderDispatcher(root, output, deploymentEpoch = 'local-1') {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(deploymentEpoch)) throw new Error('Invalid deployment epoch');
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/workflow-dispatcher.json'), 'utf8'));
  if (policy.schemaVersion !== 'jfw-workflow-dispatcher/1'
      || !['github', 'cloudflare'].includes(policy.triggerSource)
      || Object.keys(policy).length !== 2) throw new Error('Invalid dispatcher policy');
  const enabled = policy.triggerSource === 'cloudflare';
  if (enabled) {
    for (const workflow of ['api-football-automation.yml', 'api-football-schedule-sync.yml']) {
      const text = fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8');
      if (/^  schedule:/m.test(text)) throw new Error(`Remove legacy schedule before enabling Cloudflare: ${workflow}`);
    }
  }
  const main = path.relative(path.dirname(output), path.join(root, 'dispatcher-worker/index.mjs')).split(path.sep).join('/');
  const config = `name = "jfw-football-workflow-dispatcher"
main = ${JSON.stringify(main)}
compatibility_date = "2026-10-16"
workers_dev = false

[vars]
DISPATCH_ENABLED = "${enabled}"
DISPATCH_EPOCH = "${deploymentEpoch}"

[triggers]
crons = ["* * * * *"]

[[r2_buckets]]
binding = "DISPATCH_STATE"
bucket_name = "jfw-football-data"

[observability]
enabled = true
`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, config);
  return { enabled };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--output');
  if (index < 0 || !process.argv[index + 1]) throw new Error('--output required');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const epoch = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  console.log(JSON.stringify(renderDispatcher(root, path.resolve(process.argv[index + 1]), epoch)));
}
