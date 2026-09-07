'use strict';

// Run only against an isolated copy. Production/source files are never mutated.
// Usage: node scripts/v2/check-ui-r3-mutations.js <new evidence directory>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-ui-r3-evidence-'));
if (process.argv[2]) fs.mkdirSync(output, { recursive: false });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-ui-r3-mutations-'));
const files = [
  ...fs.readdirSync(root).filter(name => /\.(js|css|html|webmanifest)$/.test(name)),
  ...fs.readdirSync(path.join(root, 'tests')).filter(name => /^app-v2-.*\.test\.js$/.test(name)).map(name => `tests/${name}`),
  'scripts/v2/build-ui-config.js', 'config/competition-scope-v1.json', 'config/api-football-existing-results.json',
];
const originals = new Map();
for (const file of files) {
  const bytes = fs.readFileSync(path.join(root, file));
  originals.set(file, bytes);
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), bytes);
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'), 'dir');
const uiTests = files.filter(name => name.startsWith('tests/'));

function run(label, args, cwd = work) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${label}: interrupted`);
  const log = result.stdout + result.stderr;
  fs.writeFileSync(path.join(output, `${label}.log`), log);
  return { status: result.status, log };
}
const baseline = run('ui-baseline', ['--test', '--test-reporter=tap', ...uiTests]);
assert.equal(baseline.status, 0, 'unmodified isolated copy must pass before mutations');

const mutations = [
  ['ignore_match_filters', 'app-v2.js', 'function filteredFixtures() {', 'function filteredFixtures() { return state.fixtures;', 'match filter buttons'],
  ['remove_popstate', 'app-v2.js', "window.addEventListener('popstate', scheduleRouteApply);", '', 'native back between same-hash'],
  ['allow_j1_fixture', 'app-v2.js', 'return data.trackedFixture(row, state.legacy?.trackingPeriods, config.scope) === true;', "return row.competitionId === 'af:competition:98' || data.trackedFixture(row, state.legacy?.trackingPeriods, config.scope) === true;", 'match filter buttons'],
  ['remove_season_change', 'app-v2.js', "$('competitionSeason')?.addEventListener('change', event => {", "$('competitionSeason')?.addEventListener('unused-change', event => {", 'known competition seasons'],
  ['disable_scroll_restore', 'app-v2-history.js', 'function rendered() {', 'function rendered() { return;', 'saved scroll belongs'],
  ['remove_legacy_wiring', 'app-v2.js', "if (migrated) history.replaceState(history.state, '', `${location.pathname}${migrated.search}${migrated.hash}`);", '', 'legacy query startup'],
  ['remove_320px_guard', 'app-v2-wireframe.css', /@media \(max-width: 359px\) \{[\s\S]*?\n\}/, '', 'narrow-screen CSS'],
  ['empty_recent_is_unfetched', 'app-v2.js', 'let presence = data.section(state.legacy || {},\'playerMatchStats\');', "let presence = !records?.length ? 'not_fetched' : data.section(state.legacy || {},'playerMatchStats');", 'player recent matches'],
  ['raw_aggregate_ids', 'app-v2.js', 'function aggregateLabel(id, type, player) {', 'function aggregateLabel(id, type, player) { return id;', 'aggregate headings'],
  ['fixed_follow_icon_color', 'app-v2-wireframe.css', '.icon-follow { color:inherit; }', '.icon-follow { color:var(--warn); }', 'follow icons inherit'],
  ['remove_cold_follow_refresh', 'app-v2.js', "if (route.kind === 'following') renderFollowing();", '', 'cold follow rows'],
];
const results = [];
for (const [name, file, before, after, testName] of mutations) {
  const original = originals.get(file).toString('utf8');
  const occurrences = typeof before === 'string' ? original.split(before).length - 1 : [...original.matchAll(new RegExp(before.source, 'g'))].length;
  assert.equal(occurrences, 1, `${name}: mutation marker must match exactly once`);
  fs.writeFileSync(path.join(work, file), original.replace(before, after));
  try {
    if (file.endsWith('.js')) {
      const syntax = run(`${name}-syntax`, ['--check', file]);
      assert.equal(syntax.status, 0, `${name}: syntax errors must not count as detection`);
    }
    const result = run(name, ['--test', '--test-reporter=tap', `--test-name-pattern=${testName}`, ...uiTests]);
    const failedTests = [...result.log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
    const detected = result.status !== 0 && failedTests.some(title => title.startsWith(testName));
    results.push({ mutation: name, file, detected, exitCode: result.status, failedTests });
    console.log(`${name}: ${detected ? 'DETECTED' : 'NOT DETECTED'}`);
  } finally {
    fs.writeFileSync(path.join(work, file), originals.get(file));
  }
}
for (const [file, bytes] of originals) {
  assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, `source changed: ${file}`);
  assert.deepEqual(fs.readFileSync(path.join(work, file)), bytes, `copy not restored: ${file}`);
}
const allTests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js')).map(name => `tests/${name}`);
const full = run('full-suite', ['--test', '--test-reporter=tap', ...allTests], root);
const summary = { node: process.version, baselineExitCode: baseline.status, fullSuiteExitCode: full.status, sourceUnchanged: true, isolatedCopy: work, results };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Evidence: ${output}`);
assert.equal(full.status, 0, 'full regression suite must pass');
assert.ok(results.every(result => result.detected), 'all targeted regressions must be detected');
