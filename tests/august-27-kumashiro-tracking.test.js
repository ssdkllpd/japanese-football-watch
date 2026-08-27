const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function makeElement() {
  return { textContent:'', innerHTML:'', dataset:{}, querySelectorAll(){return [];}, querySelector(){return null;}, appendChild(){}, insertAdjacentElement(){} };
}

async function loadCurrent() {
  const seasons = readJson('seasons.json');
  const season = seasons.seasons.find(item => item.id === seasons.current);
  const context = {
    console, window:{},
    document:{ body:makeElement(), querySelector(){return null;}, createElement(){return makeElement();} },
    D:readJson(season.data), selectedSeason:seasons.current, loadSeason:async()=>{},
    renderAll(){}, renderPlayerDetail(){}, renderClubDetail(){}, renderAttention(){}, renderStats(){},
    relevantClubMatches(){return [];}, clubPlayers(){return [];}, clubMatchCard(){return '';}, pcard(){return '';}, mcard(){return '';}, bindEntities(){}, bindWatch(){}, btns(){},
    eligible(){return true;}, playerRef(p){return p.playerId||p.name;}, playerByRef(ref){return context.D.players.find(p=>p.playerId===ref||p.name===ref);},
    roundNo(){return null;}, fmt(v){return v==null?'—':String(v);}, E(v){return String(v??'');}, $(){return makeElement();},
    R:{updated:makeElement(),leagueBtns:makeElement(),players:makeElement(),scopeBtns:makeElement(),metricBtns:makeElement(),statRank:makeElement(),playerDetail:makeElement(),clubDetail:makeElement()},
    order:['すべて','プレミアリーグ','チャンピオンシップ','ブンデスリーガ','ラ・リーガ','リーグ・アン','セリエA','エールディヴィジ','ベルギー','ポルトガル','スコットランド'],
    scope:'すべて', metric:'goals', metrics:{goals:'得点',assists:'アシスト'}, attLeague:'すべて', page:'home', activePlayer:null, activeClub:null, clubRoundFrom:null, clubRoundTo:null,
    clearDetailParams(){}, showPage(){}, lastPage:'home',
    fetch:async url=>{const clean=String(url).replace(/[?&]v=\d+$/,'').replace(/^\.\//,''); const file=path.join(ROOT,clean); if(!fs.existsSync(file)) return {ok:false,status:404,json:async()=>({})}; return {ok:true,json:async()=>JSON.parse(fs.readFileSync(file,'utf8'))};},
    setTimeout, clearTimeout
  };
  context.window=context; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'backfill-merge.js'),'utf8'),context,{filename:'backfill-merge.js'});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'backfill-loader.js'),'utf8'),context,{filename:'backfill-loader.js'});
  await context.window.JFWBackfill.applyCurrentBackfill();
  return context.D;
}

test('Keito Kumashiro is present in the current Frankfurt/Bundesliga tracked player master', async () => {
  const manifest=readJson('data/2026-27/backfill/index.json');
  const snapshot=readJson('state/latest_snapshot.json');
  assert.ok(manifest.fragments.includes('latest-2026-08-27.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments,manifest.fragments);
  assert.equal(snapshot.validation.bundesligaFrankfurtKeitoKumashiroMembershipLoadsThroughPlayerUpdates,true);
  const data=await loadCurrent();
  const player=data.players.find(item=>item.name==='神代慶人');
  assert.ok(player);
  assert.ok(player.playerId);
  assert.equal(player.club,'アイントラハト・フランクフルト');
  assert.equal(player.league,'ブンデスリーガ');
  assert.equal(player.trackingStatus,'active');
  assert.equal(player.squadNumber,36);
  assert.equal(player.priorityUpdate,true);
});
