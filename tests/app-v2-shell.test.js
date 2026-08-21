'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app-v2.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app-v2.css'), 'utf8');
const leagueCss = fs.readFileSync(path.join(root, 'app-v2-league.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app-v2.js'), 'utf8');

test('v2 app javascript is syntactically valid', () => {
  assert.doesNotThrow(() => new Function(js));
});

test('v2 shell exposes the approved five primary destinations', () => {
  for (const page of ['matches', 'leagues', 'following', 'japanese', 'more']) {
    assert.match(html, new RegExp(`data-page="${page}"`));
  }
  assert.match(html, /<title>Football Companion<\/title>/);
  assert.doesNotMatch(html, /<h1[^>]*>海外日本人ウォッチ<\/h1>/);
});

test('v2 match home is wired to Core date, live and fixture endpoints', () => {
  assert.match(js, /\/api\/v2\/dates\//);
  assert.match(js, /\/api\/v2\/live/);
  assert.match(js, /\/api\/v2\/fixtures\//);
  assert.match(js, /Core feed/);
});

test('v2 shell keeps mobile bottom navigation and a desktop equivalent', () => {
  assert.match(css, /\.bottom-nav\{/);
  assert.match(css, /\.desktop-rail\{/);
  assert.match(css, /@media\(min-width:840px\)/);
});

test('league directory opens competition matches and standings through Core APIs', () => {
  assert.match(html, /app-v2-league\.css/);
  assert.match(js, /data-competition-id/);
  assert.match(js, /function renderCompetitionDetail\(\)/);
  assert.match(js, /\/api\/v2\/competitions\/\$\{encodeURIComponent\(detail\.id\)\}\/dates\//);
  assert.match(js, /\/seasons\/\$\{encodeURIComponent\(detail\.seasonId\)\}\/standings/);
  assert.match(js, /data-competition-tab="\$\{tab\}"/);
  assert.match(leagueCss, /\.standings-row/);
});

test('standings UI preserves missing values instead of rendering them as zero', () => {
  assert.match(js, /row\?\.overall\?\.played \?\? '—'/);
  assert.match(js, /row\?\.goalDifference \?\? '—'/);
  assert.match(js, /row\?\.points \?\? '—'/);
  assert.match(js, /未取得の順位・勝点を0として表示していません/);
});

test('competition match count is zero only for an explicitly fetched empty index', () => {
  assert.match(js, /detail\.matchesPresence === 'present' && !detail\.matchesLoading/);
  assert.match(js, /detail\.matchesPresence !== 'present'/);
  assert.match(js, /未取得を0試合として表示していません/);
  assert.match(js, /取得済みの日付インデックスは0試合です/);
});

test('stale competition date requests cannot commit fixtures or errors', () => {
  const guard = "if (loadSequence !== state.competitionLoadSequence || state.competitionDetail !== detail) return;";
  const guardedAt = js.indexOf(guard);
  assert.ok(guardedAt >= 0);
  assert.ok(js.indexOf('detail.fixtures = fixtures;', guardedAt) > guardedAt);
  assert.ok(js.indexOf('detail.matchesError = matchesError;', guardedAt) > guardedAt);
});

test('Japanese tracking is an optional page while generic match data remains the default page', () => {
  assert.match(js, /page: 'matches'/);
  assert.match(js, /日本人追跡は総合データアプリのオプション機能/);
});

test('legacy fallback never shows fixtures from a different selected date', () => {
  assert.match(js, /function legacyFixturesForDate\(legacy, date\)/);
  assert.match(js, /filter\(row => row\.dateJst === date\)/);
  assert.doesNotMatch(js, /if \(!state\.fixtures\.length\) state\.fixtures = \(legacy\.topMatches/);
});

test('stale match requests cannot overwrite a newer date or another page', () => {
  assert.match(js, /const loadSequence = \+\+state\.matchLoadSequence/);
  assert.match(js, /const requestedDate = state\.date/);
  assert.match(js, /if \(loadSequence !== state\.matchLoadSequence\) return/);
  assert.match(js, /state\.page === 'matches' && !state\.detail/);
});

test('closing fixture detail invalidates its pending Core response', () => {
  assert.match(js, /const detailRequest = \{ summary, bundle: null, loading: true, error: null \}/);
  assert.match(js, /if \(state\.detail !== detailRequest\) return/);
});
