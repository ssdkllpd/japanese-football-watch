const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function json(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function el() { return { textContent:'', innerHTML:'', dataset:{}, querySelectorAll(){return[];}, querySelector(){return null;}, appendChild(){}, insertAdjacentElement(){} }; }

async function load() {
  const seasons = json('seasons.json');
  const season = seasons.seasons.find(s => s.id === seasons.current);
  const D = json(season.data);
  const c = { console, window:{}, document:{ body:el(), querySelector(){return null;}, createElement(){return el();} }, D, selectedSeason:seasons.current,
    loadSeason:async()=>{}, renderAll(){}, renderPlayerDetail(){}, renderClubDetail(){}, renderAttention(){}, renderStats(){}, relevantClubMatches(){return[];}, clubPlayers(){return[];}, clubMatchCard(){return'';}, pcard(){return'';}, mcard(){return'';}, bindEntities(){}, bindWatch(){}, btns(){}, eligible(){return true;}, playerRef(p){return p.playerId||p.name;}, playerByRef(ref){return c.D.players.find(p=>p.playerId===ref||p.name===ref);}, roundNo(){return null;}, fmt(v){return v==null?'—':String(v);}, E(v){return String(v??'');}, $(){return el();}, R:{updated:el(),leagueBtns:el(),players:el(),scopeBtns:el(),metricBtns:el(),statRank:el(),playerDetail:el(),clubDetail:el()}, order:[], scope:'すべて', metric:'goals', metrics:{goals:'得点'}, attLeague:'すべて', page:'home', activePlayer:null, activeClub:null, clubRoundFrom:null, clubRoundTo:null, clearDetailParams(){}, showPage(){}, lastPage:'home', setTimeout, clearTimeout,
    fetch:async url=>{ const rel=String(url).replace(/[?&]v=\d+$/,'').replace(/^\.\//,''); const f=path.join(ROOT,rel); return fs.existsSync(f)?{ok:true,json:async()=>JSON.parse(fs.readFileSync(f,'utf8'))}:{ok:false,status:404,json:async()=>({})}; }
  };
  c.window=c; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(ROOT,'backfill-loader.js'),'utf8'),c); await c.window.JFWBackfill.applyCurrentBackfill(); return c.D;
}

test('Cambuur-Feyenoord preserves unresolved Rating gates and loads verified values', async () => {
  const fragment = json('data/2026-27/backfill/latest-2026-08-24-4.json');
  const rawUeda = fragment.playerMatchStats.find(r => r.recordId === 'r-ueda-cambuur-feyenoord-20260823');
  const rawWatanabe = fragment.playerMatchStats.find(r => r.recordId === 'r-watanabe-cambuur-feyenoord-20260823');
  for (const raw of [rawUeda, rawWatanabe]) {
    assert.equal(raw.ratingInputs.assists.state, 'missing');
    for (const field of ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals']) assert.equal(raw.ratingInputs[field].state, 'missing');
    assert.equal(raw.jfwRating, null);
    assert.equal(raw.priorityUpdate, true);
  }
  assert.equal(rawWatanabe.values.gaOnPitch, 0);
  assert.equal(rawWatanabe.ratingInputs.gaOnPitch.state, 'value');
  assert.equal(rawWatanabe.ratingInputs.gaOnPitch.value, 0);

  const d = await load();
  const match = d.matches.find(m => m.matchId === 'eredivisie-2026-08-23-cambuur-feyenoord');
  assert.ok(match); assert.match(match.match, /2-5/);
  const ueda = d.playerMatchStats.find(r => r.matchId === match.matchId && r.player === '上田綺世');
  const watanabe = d.playerMatchStats.find(r => r.matchId === match.matchId && r.player === '渡辺剛');
  assert.ok(ueda); assert.ok(watanabe);
  assert.equal(ueda.minutes, 67); assert.equal(ueda.goals, 1); assert.equal(ueda.jfwRating, null);
  assert.equal(watanabe.minutes, 67); assert.equal(watanabe.goals, 0); assert.equal(watanabe.jfwRating, null);
});
