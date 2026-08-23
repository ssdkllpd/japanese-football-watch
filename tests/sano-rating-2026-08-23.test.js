const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
function el(){ return {textContent:'',innerHTML:'',dataset:{},querySelectorAll(){return[]},querySelector(){return null},appendChild(){},insertAdjacentElement(){}}; }
function harness(){
  const manifest=readJson('data/2026-27/backfill/index.json');
  const frags=new Map(manifest.fragments.map(n=>[n,readJson(`data/2026-27/backfill/${n}`)]));
  const c={console,window:{},document:{body:el(),querySelector(){return null},createElement(){return el()}},D:structuredClone(readJson('data.json')),selectedSeason:'2026-27',loadSeason:async()=>{},renderAll(){},renderPlayerDetail(){},renderClubDetail(){},renderAttention(){},renderStats(){},relevantClubMatches(){return[]},clubPlayers(){return[]},clubMatchCard(){return''},pcard(){return''},mcard(){return''},bindEntities(){},bindWatch(){},btns(){},eligible(){return true},playerRef(p){return p.playerId||p.name},playerByRef(ref){return c.D.players.find(p=>p.playerId===ref||p.name===ref)},roundNo(){return null},fmt(v){return v==null?'—':String(v)},E(v){return String(v??'')},$(){return el()},R:{updated:el(),leagueBtns:el(),players:el(),scopeBtns:el(),metricBtns:el(),statRank:el(),playerDetail:el(),clubDetail:el()},order:['すべて','エールディヴィジ'],scope:'すべて',metric:'goals',metrics:{goals:'得点'},attLeague:'すべて',page:'home',activePlayer:null,activeClub:null,clubRoundFrom:null,clubRoundTo:null,clearDetailParams(){},showPage(){},lastPage:'home',fetch:async url=>{const v=String(url).split('?')[0];if(v.endsWith('/index.json'))return{ok:true,json:async()=>manifest};const n=v.split('/').at(-1);return frags.has(n)?{ok:true,json:async()=>frags.get(n)}:{ok:false,status:404,json:async()=>({})}},setTimeout,clearTimeout};
  c.window=c; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(ROOT,'backfill-loader.js'),'utf8'),c); return c;
}

test('Sano Excelsior minutes resolve priority gate and produce JFW Rating without zero-filling advanced fields', async()=>{
  const c=harness(); await c.window.JFWBackfill.applyCurrentBackfill();
  const r=c.D.playerMatchStats.find(x=>x.recordId==='r-sano-excelsior-psv-20260815');
  assert.ok(r); assert.equal(r.minutes,28); assert.equal(r.jfwRating,6); assert.equal(r.ratingCoverage,0.447); assert.equal(r.ratingConfidence,'medium');
  for(const f of ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals']){assert.equal(r.ratingInputs[f]?.state,'value');assert.equal(r.ratingInputs[f]?.value,0)}
  assert.equal(r.ratingInputs.keyPasses?.state,'missing'); assert.equal(r.priorityUpdate,true); assert.ok(!r.priorityFields.includes('minutes'));
});

test('snapshot mirrors manifest after Sano refinement',()=>{
  const m=readJson('data/2026-27/backfill/index.json'); const s=readJson('state/latest_snapshot.json');
  assert.equal(m.fragments.at(-1),'latest-2026-08-23-13.json'); assert.deepEqual(s.overlayManifest.orderedFragments,m.fragments); assert.equal(s.validation.eredivisieSanoDebutRatingRefined,true);
});
