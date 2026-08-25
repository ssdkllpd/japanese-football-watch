const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBackfillHarness } = require('./helpers/backfill-harness');

function contextForCurrentSeason() {
  return buildBackfillHarness({ loadRating: true, order: ['すべて'] });
}

async function loaded() {
  const c = contextForCurrentSeason();
  await c.window.JFWBackfill.initialLoad;
  return c;
}

function recordsFor(c, name) {
  const p = c.D.players.find(x=>x.name===name);
  assert.ok(p, `${name} player missing`);
  return (c.D.playerMatchStats||[])
    .filter(r=>r.playerId===p.playerId || r.player===name || r.playerName===name)
    .map(r=>c.window.JFWRating.withComputedRating(r));
}

test('all current-season final JFW Rating values are null/unrated or within 3.0-10.0', async()=>{
  const c = await loaded();
  for (const r of c.D.playerMatchStats||[]) {
    const out = c.window.JFWRating.withComputedRating(r);
    if (out.jfwRating === undefined || out.jfwRating === null) continue;
    assert.ok(c.window.JFWRating.isRatingValue(out.jfwRating), `${r.recordId||r.matchId}: invalid final rating ${out.jfwRating}`);
  }
});

test('unrated appearances never enter rating count or minutes-weighted denominator', async()=>{
  const c = await loaded();
  for (const p of c.D.players||[]) {
    const recs = recordsFor(c, p.name);
    const appeared = recs.filter(r=>Number(r.minutes ?? r.ratingInputs?.minutes?.value)>0);
    const valid = appeared.filter(r=>c.window.JFWRating.isRatingValue(r.jfwRating));
    const summary = c.window.JFWRating.seasonSummary(recs);
    assert.equal(summary.appearances, appeared.length, `${p.name}: appearance count mismatch`);
    assert.equal(summary.ratedGames, valid.length, `${p.name}: unrated game leaked into ratedGames`);
    if (summary.average != null) assert.ok(c.window.JFWRating.isRatingValue(summary.average), `${p.name}: invalid season average ${summary.average}`);
    if (summary.recentAverage != null) assert.ok(c.window.JFWRating.isRatingValue(summary.recentAverage), `${p.name}: invalid recent average ${summary.recentAverage}`);
  }
});

test('Nelson Ishiwatari Omonia match stays unrated and cannot drag season average to 4.8', async()=>{
  const c = await loaded();
  const recs = recordsFor(c, '石渡ネルソン');
  const omonia = recs.find(r=>r.matchId==='uel-2026-08-20-stvv-omonia');
  assert.ok(omonia, 'Omonia record missing');
  assert.equal(c.window.JFWRating.isRatingValue(omonia.jfwRating), false, 'Omonia should remain unrated until required inputs are complete');
  const summary = c.window.JFWRating.seasonSummary(recs);
  assert.equal(summary.appearances, 3);
  assert.equal(summary.ratedGames, 2);
  assert.ok(summary.average >= 6.0 && summary.average <= 8.0, `Nelson average unexpectedly ${summary.average}`);
  assert.notEqual(summary.average, 4.8);
});
