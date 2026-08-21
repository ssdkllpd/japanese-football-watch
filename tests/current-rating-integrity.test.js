const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function json(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function makeElement() { return { dataset:{}, querySelector(){return null;}, querySelectorAll(){return[];}, appendChild(){}, insertAdjacentElement(){} }; }

function contextForCurrentSeason() {
  const seasons = json('seasons.json');
  const season = seasons.seasons.find(s => s.id === seasons.current);
  assert.ok(season, 'current season must resolve');
  const context = {
    console,
    D: json(season.data),
    selectedSeason: seasons.current,
    window: {},
    document: { body: makeElement(), querySelector(){return null;}, createElement(){return makeElement();} },
    fetch: async url => {
      const clean = String(url).replace(/[?&]v=\d+$/, '').replace(/^\.\//, '');
      const file = path.join(ROOT, clean);
      if (!fs.existsSync(file)) return { ok:false, status:404, json:async()=>({}) };
      return { ok:true, json:async()=>JSON.parse(fs.readFileSync(file,'utf8')) };
    },
    setTimeout, clearTimeout,
    loadSeason: async()=>{}, renderAll(){}, renderPlayerDetail(){}, renderClubDetail(){}, renderAttention(){}, renderStats(){},
    relevantClubMatches(){return[];}, clubPlayers(){return[];}, clubMatchCard(){return'';}, pcard(){return'';}, mcard(){return'';},
    bindEntities(){}, bindWatch(){}, btns(){}, eligible(){return true;},
    playerRef(p){return p.playerId||p.name;}, playerByRef(ref){return context.D.players.find(p=>p.playerId===ref||p.name===ref);},
    roundNo(){return null;}, fmt(v){return v==null?'—':String(v);}, E(v){return String(v??'');}, $(){return makeElement();},
    R:{updated:makeElement(),leagueBtns:makeElement(),players:makeElement(),scopeBtns:makeElement(),metricBtns:makeElement(),statRank:makeElement(),playerDetail:makeElement(),clubDetail:makeElement()},
    order:['すべて'], scope:'すべて', metric:'goals', metrics:{goals:'得点'}, attLeague:'すべて', page:'home', activePlayer:null, activeClub:null,
    clubRoundFrom:null, clubRoundTo:null, clearDetailParams(){}, showPage(){}, lastPage:'home'
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'jfw-rating.js'),'utf8'), context, {filename:'jfw-rating.js'});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'backfill-loader.js'),'utf8'), context, {filename:'backfill-loader.js'});
  return context;
}

async function loaded() {
  const c = contextForCurrentSeason();
  await c.window.JFWBackfill.applyCurrentBackfill();
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
  assert.ok(summary.average >= 6.0 && summary.average <= 7.0, `Nelson average unexpectedly ${summary.average}`);
  assert.notEqual(summary.average, 4.8);
});
