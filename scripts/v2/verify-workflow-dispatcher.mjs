#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueSlots } from '../../dispatcher-worker/index.mjs';

const REPOSITORY = 'ssdkllpd/japanese-football-watch';
const LABELS = {
  'api-football-automation.yml': 'API-Football Automation',
  'api-football-schedule-sync.yml': 'API-Football Schedule Sync',
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifyDispatcher({ env = process.env, request = fetch, now = Date.now,
  sleep = pause, timeoutMs = 25 * 60000, pollMs = 10000 } = {}) {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'WORKFLOW_DISPATCH_TOKEN', 'GITHUB_SHA']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  const startedAt = now();
  const accepted = new Map();
  const completed = new Map();
  const githubHeaders = { authorization: `Bearer ${env.WORKFLOW_DISPATCH_TOKEN}`,
    accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10',
    'user-agent': 'jfw-dispatch-verification' };
  const read = async (url, headers, allowMissing = false) => {
    const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Verification read HTTP ${response.status}`);
    return response.json();
  };
  while (now() - startedAt < timeoutMs) {
    for (const candidate of dueSlots(now())) {
      if (accepted.has(candidate.file)) continue;
      const key = `automation/workflow-dispatch/v1/${candidate.slot.slice(0, 10)}/${candidate.file}/${candidate.slot}.json`;
      const record = await read(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/r2/buckets/jfw-football-data/objects/${key}`,
        { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, true);
      if (!record) continue;
      if (record.workflow !== candidate.file || record.slot !== candidate.slot) throw new Error('Dispatch record identity mismatch');
      if (!Number.isFinite(Date.parse(record.attemptedAt)) || Date.parse(record.attemptedAt) < startedAt - 120000) continue;
      if (['rejected', 'uncertain'].includes(record.status)) throw new Error(`Recorded dispatch ${record.status}: ${candidate.file}`);
      if (record.status === 'accepted') accepted.set(candidate.file, record);
    }
    for (const [file, record] of accepted) {
      if (completed.has(file)) continue;
      const expectedTitle = `${LABELS[file]} [Cloudflare ${record.slot}]`;
      let run;
      if (Number.isSafeInteger(record.workflowRunId)) {
        run = await read(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${record.workflowRunId}`, githubHeaders);
      } else {
        const runs = await read(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${file}/runs?branch=main&event=workflow_dispatch&per_page=100`, githubHeaders);
        run = runs.workflow_runs?.find(value => value.display_title === expectedTitle && value.head_sha === env.GITHUB_SHA);
      }
      if (!run) continue;
      if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
          || run.head_sha !== env.GITHUB_SHA || run.display_title !== expectedTitle) {
        throw new Error(`Dispatched workflow identity mismatch: ${file}`);
      }
      if (run.status !== 'completed') continue;
      if (run.conclusion !== 'success') throw new Error(`Dispatched workflow failed: ${file}, run ${run.id}, ${run.conclusion}`);
      // A successful run containing only skipped jobs is not execution evidence.
      const jobs = await read(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100`, githubHeaders);
      const synchronize = jobs.jobs?.find(job => job.name === 'synchronize');
      if (synchronize?.conclusion !== 'success') throw new Error(`Synchronization did not execute: ${file}`);
      completed.set(file, { workflow: file, slot: record.slot, runId: run.id, url: run.html_url, conclusion: run.conclusion });
    }
    console.log(JSON.stringify({ accepted: accepted.size, completed: completed.size, elapsedSeconds: Math.floor((now() - startedAt) / 1000) }));
    if (completed.size === 2) return { passed: true, triggerSource: 'cloudflare', commit: env.GITHUB_SHA, workflows: [...completed.values()] };
    await sleep(pollMs);
  }
  throw new Error(`Verification timed out: accepted ${accepted.size}/2, completed ${completed.size}/2`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyDispatcher();
  const output = '.tmp/dispatcher/verification.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
