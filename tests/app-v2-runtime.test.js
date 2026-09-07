'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const team = (id, name) => ({ id: `af:team:${id}`, name });
const home = team(1, 'Home Club'), away = team(2, 'Away Club');
function visible(el,w) { for(let node=el;node;node=node.parentElement){const css=w.getComputedStyle(node);if(node.hidden || css.display === 'none' || css.visibility === 'hidden') return false;}return true;}
function fixture() { return { id: 'af:fixture:10', fixtureId: 'af:fixture:10', competitionId: 'af:competition:39', competitionName: 'League', seasonId: 'af:season:39:2026', dateJst: '2026-09-01', kickoffUtc: '2026-09-01T12:00:00Z', status: { short: 'FT' }, teams: { home, away }, score: { goals: { home: 0, away: 1 } } }; }
function bundle() { return { fixture: fixture(), sectionStates: Object.fromEntries(['lineups','events','teamStats','playerStats'].map(key => [key, { presence: 'present' }])), lineups: [home,away].map((t,i) => ({ teamId:t.id, formation:'4-4-2', startXI:[{id:`af:player:${i+1}`,name:`Starter ${i+1}`,number:i+9,position:'F'}], substitutes:[{id:`af:player:${i+3}`,name:`Bench ${i+1}`,number:20}], coach:{ name:`Coach ${i+1}`,photo:`https://photos.test/coach${i}.png` } })), playerStats:[home,away].map((t,i)=>({ teamId:t.id, playerId:`af:player:${i+1}`,playerName:`Starter ${i+1}`,position:'F',values:{rating:7+i},jfwRating:{value:8,factors:{attack:1}} })), teamStats:[{teamId:home.id,values:{shots_on_goal:0,ball_possession:null},fieldStates:{ball_possession:{presence:'not_fetched'}}},{teamId:away.id,values:{shots_on_goal:2,ball_possession:null},fieldStates:{ball_possession:{presence:'not_applicable'}}}], events:[] }; }
async function boot(t,{hash='#/matches?date=2026-09-01&filter=all',legacy={},detail=bundle(),feed,storage={},apiBase='https://api.test',publicConfig,search='',request}={}) {
 const dom = new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:`https://football.test/${search}${hash}`,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window, calls=[];
 for(const css of ['app-v2.css','app-v2-league.css','app-v2-wireframe.css']) {const style=w.document.createElement('style');style.textContent=fs.readFileSync(path.join(root,css),'utf8');w.document.head.append(style);}
 t.after(()=>w.close());
 w.matchMedia=()=>({matches:false});
 w.scrollTo=(arg)=>{Object.defineProperty(w,'scrollY',{value:arg.top||0,configurable:true});};
 if(apiBase) w.FOOTBALL_V2_API_BASE=apiBase;
 for(const [k,v] of Object.entries(storage)) w.localStorage.setItem(k,typeof v === 'string' ? v : JSON.stringify(v));
 w.JFWV2BackfillData={loadCurrentMergedData:async()=>({players:[],topMatches:[],...legacy})};
 w.fetch=async url=>{calls.push(String(url));if(request){const response=await request(url);if(response)return response;}const p=new URL(url).pathname;let body=p.includes('/fixtures/')?detail:p.includes('/dates/')?(feed?await feed():{fixtures:[fixture()]}):{fixtures:[]};return {ok:true,status:200,json:async()=>structuredClone(body)};};
 for(const file of ['formation-view.js','app-v2-config.js','app-v2-data.js','app-v2-history.js','app-v2-router.js','app-v2.js']) if(fs.existsSync(path.join(root,file)))w.eval(file === 'app-v2-config.js' && publicConfig ? publicConfig : fs.readFileSync(path.join(root,file),'utf8'));
 await tick();
 const click=async selector=>{const el=w.document.querySelector(selector);assert.ok(el,`missing ${selector}`);el.click();await tick();};
 return {w,doc:w.document,calls,click,text:()=>w.document.getElementById('appMain').textContent};
}

test('club deep link stays a club after a delayed date response',async t=>{
 let resolve; const feed=new Promise(r=>resolve=r);
 const app=await boot(t,{hash:'#/teams/af%3Ateam%3A1',feed:()=>feed});
 resolve({fixtures:[fixture()]}); await tick();
 assert.equal(app.doc.getElementById('pageEyebrow').textContent,'クラブ詳細');
 assert.match(app.text(),/Home Club/);
});
test('two nested back operations preserve the exact departure date and filter',async t=>{
 const app=await boot(t,{hash:'#/matches?date=2026-09-01&filter=all'});
 await app.click('[data-fixture]'); await app.click('[data-detail-tab="lineup"]'); await app.click('[data-team-id]');
 await app.click('[data-entity-back]'); assert.match(app.w.location.hash,/fixtures/);
 await app.click('#detailBack'); assert.equal(app.w.location.hash,'#/matches?date=2026-09-01&filter=all');
 assert.equal(app.doc.getElementById('pageTitle').textContent,'試合');
});
test('search preserves its input node during typing and composition',async t=>{
 const app=await boot(t); await app.click('#searchButton');
 const input=app.doc.getElementById('globalSearch');input.focus();input.value='Home';input.setSelectionRange(2,2);
 input.dispatchEvent(new app.w.Event('input',{bubbles:true}));
 assert.equal(app.doc.getElementById('globalSearch'),input); assert.equal(input.selectionStart,2);
 input.dispatchEvent(new app.w.CompositionEvent('compositionstart')); input.value='日本';input.dispatchEvent(new app.w.Event('input',{bubbles:true}));
 assert.equal(app.doc.getElementById('globalSearch'),input);
});
test('lineup renders both starting lists, both benches and visible coaches',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup'});
 assert.equal(app.doc.querySelectorAll('.lineup-card').length,2);
 for(const name of ['Starter 1','Starter 2','Bench 1','Bench 2','Coach 1','Coach 2']) assert.match(app.text(),new RegExp(name));
 assert.equal(app.doc.querySelectorAll('.coach-row img').length,2);
 for(const el of app.doc.querySelectorAll('.lineup-card,.lineup-person,.coach-row'))assert.ok(visible(el,app.w),'required lineup content must remain visible');
 for(const card of app.doc.querySelectorAll('.lineup-card'))assert.match(card.textContent,/ベンチ 1/);
});
test('ratings are grouped under the corresponding home and away team',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings'});
 for(const [id,name] of [['af:team:1','Starter 1'],['af:team:2','Starter 2']]){
 const group=app.doc.querySelector(`[data-rating-team="${id}"]`);assert.ok(group);assert.ok(visible(group,app.w));assert.match(group.textContent,new RegExp(name));assert.equal(group.querySelectorAll('.rating-row').length,1);
 }
});
test('all five fixture tabs update URL and expose an associated tabpanel',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10'});
 for(const tab of ['overview','lineup','events','stats','ratings']){
 await app.click(`[data-detail-tab="${tab}"]`);assert.equal(new URLSearchParams(app.w.location.hash.split('?')[1]).get('tab'),tab);
 const selected=app.doc.querySelector('[role="tab"][aria-selected="true"]');const panel=app.doc.getElementById(selected.getAttribute('aria-controls'));assert.ok(panel);assert.equal(panel.getAttribute('role'),'tabpanel');
 }
});
test('unavailable detail preserves score and suppresses detailed rows on every tab',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10',detail:{...bundle(),detailAvailability:'unavailable'}});
 for(const tab of ['overview','lineup','events','stats','ratings']){await app.click(`[data-detail-tab="${tab}"]`);assert.match(app.text(),/詳細は取得できません/);assert.equal(app.doc.querySelectorAll('.lineup-person,.rating-row,.team-stat-row').length,0);assert.match(app.doc.querySelector('.score-value').textContent,/0 - 1/);}
});
test('zero, not fetched, not applicable and fetched empty remain distinct',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=stats'});
 assert.match(app.doc.querySelector('.team-stat-row').textContent,/0/);
 assert.ok(app.doc.querySelector('[data-presence="not_fetched"]'));assert.equal(app.doc.querySelector('[data-presence="not_applicable"]').textContent,'非該当');
 await app.click('[data-detail-tab="events"]');assert.match(app.text(),/該当なし/);assert.equal(app.doc.querySelectorAll('#fixture-panel [data-presence="not_fetched"]').length,0);
});
test('follow toggles store IDs only and do not request the fixture again',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10'});const before=app.calls.filter(x=>x.includes('/fixtures/')).length;
 await app.click('[data-follow-type="teams"]');assert.equal(app.calls.filter(x=>x.includes('/fixtures/')).length,before);
 assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,['af:team:1']);
});

test('JFW mode opens and closes an eligible rating breakdown in its URL',async t=>{
 const legacy={trackingPeriods:[{playerId:'af:player:1',teamId:'af:team:1',competitionId:'af:competition:39',tracked:true,from:'2026-08-01T00:00:00Z',to:null}]};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings',legacy});
 await app.click('[data-rating-mode="jfw"]');
 assert.match(app.w.location.hash,/ratingMode=jfw/);
 assert.ok(app.doc.querySelector('[data-rating-player="af:player:2"] [data-presence="not_applicable"]'));
 await app.click('[data-rating-player="af:player:1"]');assert.match(app.w.location.hash,/player=af%3Aplayer%3A1/);assert.ok(app.doc.querySelector('.rating-breakdown'));
 await app.click('[data-close-rating]');assert.doesNotMatch(app.w.location.hash,/player=/);assert.equal(app.doc.querySelector('.rating-breakdown'),null);
});
test('J1 never shows a supplied JFW score and unknown tracking stays unfetched',async t=>{
 const detail=bundle();detail.fixture.competitionId='af:competition:98';
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw',detail});
 assert.equal(app.doc.querySelectorAll('.rating-row b [data-presence="not_applicable"]').length,2);
 const unknown=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw'});
 assert.equal(unknown.doc.querySelectorAll('.rating-row b [data-presence="not_fetched"]').length,2);
});
test('missing formation draws no overlapping players but keeps textual players and coach',async t=>{
 const detail=bundle();detail.lineups.forEach(l=>l.layoutConfidence='none');
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.equal(app.doc.querySelectorAll('.pitch-player').length,0);assert.equal(app.doc.querySelectorAll('.pitch-unavailable').length,2);
 assert.equal(app.doc.querySelectorAll('.lineup-person').length,4);assert.equal(app.doc.querySelectorAll('.coach-row').length,2);
});
test('public HTML consumes compiled config and ignores URL and saved overrides on production',async t=>{
 const {buildConfig}=require('../scripts/v2/build-ui-config.js');
 const app=await boot(t,{apiBase:null,publicConfig:buildConfig('https://configured.test'),search:'?api=https://override.test',storage:{'football-v2-api-base':'https://saved.test'}});
 assert.ok(app.calls.length);assert.ok(app.calls.every(url=>url.startsWith('https://configured.test/')));
});
test('fetched empty date is zero; failed and malformed feeds never become zero',async t=>{
 const empty=await boot(t,{feed:()=>({fixtures:[]})});assert.match(empty.text(),/0件/);
 const bad=await boot(t,{feed:()=>({})});assert.doesNotMatch(bad.text(),/0件/);
 const failed=await boot(t,{request:async()=>({ok:false,status:404,json:async()=>({error:'Not found'})})});assert.doesNotMatch(failed.text(),/0件/);
});
test('cancelled and postponed statuses stay exclusive from final styling',async t=>{
 const rows=['CANC','ABD','AWD','WO','PST'].map((short,i)=>({...fixture(),fixtureId:`af:fixture:${i}`,status:{short},ingestionState:'finalized'}));
 const app=await boot(t,{feed:()=>({fixtures:rows})});
 assert.equal(app.doc.querySelectorAll('.status-pill.is-cancelled').length,4);assert.equal(app.doc.querySelectorAll('.status-pill.is-final').length,0);
 assert.match(app.doc.querySelector('[data-fixture="af:fixture:4"]').textContent,/延期/);
});
test('old follows migrate to ID-only entries and absence from cache is not deletion',async t=>{
 const app=await boot(t,{hash:'#/following',storage:{'football-v2-follows':{teams:[{id:'af:team:999',name:'Old name',logo:'old.png'}],players:[],competitions:[]}}});
 assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,['af:team:999']);
 assert.match(app.text(),/参照先は未取得/);assert.doesNotMatch(app.text(),/Old name|削除済み/);
 await app.click('[data-follow-id="af:team:999"]');assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,[]);
});
test('search closes to the full prior competition route across repeated excursions',async t=>{
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A39%3A2026&tab=standings'});
 const prior=app.w.location.hash;
 for(let i=0;i<2;i++){await app.click('#searchButton');await app.click('#searchBack');assert.equal(app.w.location.hash,prior);assert.ok(app.doc.querySelector('[data-competition-tab="standings"][aria-selected="true"]'));}
});
test('saved scroll belongs to each history entry and survives delayed list rendering',async t=>{
 const app=await boot(t);await tick();
 app.w.scrollTo({top:350});app.w.dispatchEvent(new app.w.Event('scroll'));
 await app.click('[data-fixture]');await app.click('#detailBack');await tick();
 assert.equal(app.w.scrollY,350);
 const key=app.w.history.state.footballV2.key;
 await app.click('[data-page="more"]');await app.click('[data-page="matches"]');
 assert.notEqual(app.w.history.state.footballV2.key,key);assert.equal(app.w.history.state.footballV2.scrollY,0);
});
test('a late fixture response cannot repaint a route that was left',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10',request:async url=>url.includes('/fixtures/')?pending:null});
 await app.click('[data-page="more"]');release({ok:true,status:200,json:async()=>bundle()});await tick();
 assert.equal(app.doc.getElementById('pageTitle').textContent,'その他');assert.equal(app.doc.querySelector('.score-hero'),null);
});
test('429, archive preparation and 404 expose different recovery messages',async t=>{
 for(const [status,code,expected] of [[429,'Rate limit exceeded',/アクセスが集中/],[409,'archive_pending',/過去のデータを準備中/],[404,'entity_not_found',/見つかりません/]]) {
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10',request:async url=>url.includes('/fixtures/')?{ok:false,status,json:async()=>({error:code})}:null});
 assert.match(app.text(),expected);assert.ok(app.doc.querySelector('[data-retry]'));if(status===404)assert.ok(app.doc.querySelector('[data-open-search]'));
 }
});
test('unknown attention is not described as uncomputed legacy scores',async t=>{
 const app=await boot(t,{hash:'#/japanese',legacy:{topMatches:[{match:'Old match',score:'S+'}]}});
 assert.match(app.text(),/視聴価値データは未取得/);assert.doesNotMatch(app.text(),/未算出のため除外|価値0/);
});

test('scope switching uses stored competition aggregates and keeps past tracked scores after a transfer',async t=>{
 const app=await boot(t,{hash:'#/japanese',legacy:{_dataIntegrity:{season:'2026-27'},players:[{playerId:'jp-1',name:'Former Player',league:'J1',club:'New Club',trackingStatus:'out_of_scope',rankingEligible:true,seasonStats:{apps:3,goals:5,assists:1},competitionStats:{'Premier League':{apps:2,goals:2,assists:0},J1:{apps:1,goals:99,assists:99}}}]}});
 assert.match(app.text(),/無所属・追跡対象外/);assert.match(app.doc.getElementById('japaneseList').textContent,/G 5/);
 const select=app.doc.getElementById('japaneseCompetition');assert.equal(select.disabled,false);assert.ok(![...select.options].some(o=>o.value==='J1'));
 select.value='Premier League';select.dispatchEvent(new app.w.Event('change'));assert.match(app.doc.getElementById('japaneseList').textContent,/G 2/);assert.doesNotMatch(app.doc.getElementById('japaneseList').textContent,/G 99/);
});
test('known competition seasons can change without losing the selected tab',async t=>{
 const app=await boot(t,{feed:()=>({fixtures:[fixture(),{...fixture(),fixtureId:'af:fixture:11',seasonId:'af:season:39:2025'}]})});
 await app.click('[data-page="leagues"]');await app.click('[data-competition-id="af:competition:39"]');await app.click('[data-competition-tab="standings"]');
 const select=app.doc.getElementById('competitionSeason');assert.ok(select);select.value='af:season:39:2025';select.dispatchEvent(new app.w.Event('change'));await tick();
 const params=new URLSearchParams(app.w.location.hash.split('?')[1]);assert.equal(params.get('competitionSeason'),'af:season:39:2025');assert.equal(params.get('tab'),'standings');
});
test('provider missing and not applicable share the agreed non-applicable label',async t=>{
 const detail=bundle();detail.teamStats[0].fieldStates.ball_possession.presence='provider_missing';
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=stats',detail});
 const missing=app.doc.querySelector('#fixture-panel [data-presence="provider_missing"]');const na=app.doc.querySelector('#fixture-panel [data-presence="not_applicable"]');
 assert.equal(missing.textContent,'非該当');assert.equal(na.textContent,'非該当');
 assert.equal(app.w.getComputedStyle(missing).borderStyle,'solid');assert.equal(app.w.getComputedStyle(na).borderStyle,'solid');
});
test('coach provider identity supplies the official photo URL and error falls back to initials',async t=>{
 const detail=bundle();detail.lineups[0].coach={id:'af:coach:77',providerId:77,name:'Example Coach'};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const coach=app.doc.querySelector('.coach-row'),img=coach.querySelector('img');assert.equal(img.src,'https://media.api-sports.io/football/coachs/77.png');
 img.dispatchEvent(new app.w.Event('error'));assert.equal(img.hidden,true);assert.match(coach.textContent,/EC/);assert.ok(visible(coach,app.w));
});
test('computed attention below the list threshold is not mislabelled as uncomputed',async t=>{
 const detail=bundle();detail.fixture.attention={presence:'present',displayedScore:'12.00'};detail.fixture.watch={label:'Sample service'};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10',detail});assert.match(app.text(),/視聴価値 12.00/);assert.match(app.text(),/配信: Sample service/);assert.doesNotMatch(app.text(),/未算出/);
});
