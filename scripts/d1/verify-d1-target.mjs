#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENVIRONMENT_KEYS = Object.freeze({
  d1DatabaseName: 'D1_DATABASE_NAME',
  d1DatabaseId: 'D1_DATABASE_ID',
  adminWorkerName: 'ADMIN_WORKER_NAME',
  r2BucketName: 'R2_BUCKET',
});
const IDENTITY_PATTERNS = Object.freeze({
  d1DatabaseName: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
  d1DatabaseId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  adminWorkerName: /^[a-z0-9][a-z0-9-]{0,62}$/,
  r2BucketName: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
});

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing.`);
  if (value.includes('REPLACE_WITH_')) throw new Error(`${label} has not been reviewed and configured.`);
  if (/\r|\n/.test(value)) throw new Error(`${label} contains a line break.`);
  return value;
}

function parseOrigin(value, label) {
  const text = requiredString(value, label);
  let url;
  try { url = new URL(text); } catch { throw new Error(`${label} is not an absolute URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS origin without credentials.`);
  }
  return url.origin;
}

function requiredIdentity(value, manifestKey, label) {
  const text = requiredString(value, label);
  if (!IDENTITY_PATTERNS[manifestKey].test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

export function loadD1Target(manifestPath, targetName = 'staging') {
  const resolved = path.resolve(manifestPath);
  let document;
  try { document = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch (error) {
    throw new Error(`Unable to read D1 target manifest: ${error?.message || error}`);
  }
  if (document?.schemaVersion !== 'jfw-d1-targets/1') {
    throw new Error('D1 target manifest schemaVersion is unsupported.');
  }
  const target = document?.targets?.[targetName];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`D1 target manifest does not declare ${targetName}.`);
  }
  const expectedEnvironment = targetName === 'staging' ? 'd1-staging' : targetName;
  if (requiredString(target.environment, `${targetName}.environment`) !== expectedEnvironment) {
    throw new Error(`${targetName}.environment must be ${expectedEnvironment}.`);
  }
  for (const key of Object.keys(ENVIRONMENT_KEYS)) {
    requiredIdentity(target[key], key, `${targetName}.${key}`);
  }
  const origin = parseOrigin(target.adminEndpointOrigin, `${targetName}.adminEndpointOrigin`);
  if (origin !== target.adminEndpointOrigin) {
    throw new Error(`${targetName}.adminEndpointOrigin must contain only the exact origin.`);
  }
  return Object.freeze({ ...target });
}

export function verifyD1Target({ env, manifestPath, targetName = 'staging' }) {
  const target = loadD1Target(manifestPath, targetName);
  const mismatches = [];
  for (const [manifestKey, environmentKey] of Object.entries(ENVIRONMENT_KEYS)) {
    const actual = requiredIdentity(env[environmentKey], manifestKey, environmentKey);
    if (actual !== target[manifestKey]) mismatches.push(environmentKey);
  }
  const actualAdminUrl = requiredString(env.ADMIN_INGEST_URL, 'ADMIN_INGEST_URL');
  if (parseOrigin(actualAdminUrl, 'ADMIN_INGEST_URL') !== target.adminEndpointOrigin) {
    mismatches.push('ADMIN_INGEST_URL origin');
  }
  if (mismatches.length) {
    throw new Error(`Resolved D1 target does not exactly match the reviewed manifest: ${mismatches.join(', ')}.`);
  }
  return target;
}

function parseArgs(argv) {
  const manifestIndex = argv.indexOf('--manifest');
  const targetIndex = argv.indexOf('--target');
  if (manifestIndex === -1 || !argv[manifestIndex + 1]) {
    throw new Error('Usage: verify-d1-target.mjs --manifest FILE [--target staging]');
  }
  return {
    manifestPath: argv[manifestIndex + 1],
    targetName: targetIndex === -1 ? 'staging' : argv[targetIndex + 1],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  verifyD1Target({ env: process.env, ...args });
  process.stdout.write(`verified D1 target: ${args.targetName}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
