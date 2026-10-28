'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(predicate, message) {
 for (let attempt = 0; attempt < 80; attempt++) {
  if (predicate()) return;
  await tick();
 }
 assert.fail(message);
}
function section(app, title) {
 const heading = [...app.doc.querySelectorAll('h2')].find(el => el.textContent === title);
 assert.ok(heading, `missing section ${title}`);
 return heading.closest('section');
}
const team = (id, name) => ({ id: `af:team:${id}`, name });
const home = team(1, 'Home Club'), away = team(2, 'Away Club');
function visible(el,w) { for(let node=el;node;node=node.parentElement){const css=w.getComputedStyle(node);if(node.hidden || css.display === 'none' || css.visibility === 'hidden') return false;}return true;}
function fixture() { return { id: 'af:fixture:10', fixtureId: 'af:fixture:10', competitionId: 'af:competition:39', competitionName: 'League', seasonId: 'af:season:39:2026', dateJst: '2026-09-01', kickoffUtc: '2026-09-01T12:00:00Z', status: { short: 'FT' }, teams: { home, away }, score: { goals: { home: 0, away: 1 } } }; }
function bundle() { return { fixture: fixture(), sectionStates: Object.fromEntries(['lineups','events','teamStats','playerStats'].map(key => [key, { presence: 'present' }])), lineups: [home,away].map((t,i) => ({ teamId:t.id, formation:'4-4-2', startXI:[{id:`af:player:${i+1}`,name:`Starter ${i+1}`,number:i+9,position:'F'}], substitutes:[{id:`af:player:${i+3}`,name:`Bench ${i+1}`,number:20}], coach:{ name:`Coach ${i+1}`,photo:`https://photos.test/coach${i}.png` } })), playerStats:[home,away].map((t,i)=>({ teamId:t.id, playerId:`af:player:${i+1}`,playerName:`Starter ${i+1}`,position:'F',values:{rating:7+i},jfwRating:{value:8,factors:{attack:1}} })), teamStats:[{teamId:home.id,values:{shots_on_goal:0,ball_possession:null},fieldStates:{ball_possession:{presence:'not_fetched'}}},{teamId:away.id,values:{shots_on_goal:2,ball_possession:null},fieldStates:{ball_possession:{presence:'not_applicable'}}}], events:[] }; }

test('bench portraits show stacked scoring contributions alongside the incoming minute, photo and shirt number',async t=>{
 const detail=bundle();
 detail.lineups[0].substitutes[0].photo='https://photos.test/bench.png';
 detail.playerStats.push({teamId:home.id,playerId:'af:player:3',values:{minutes:30,goals:2,assists:3}});
 detail.events=[{type:'substitution',teamId:home.id,playerId:'af:player:1',relatedPlayerId:'af:player:3',elapsed:60}];
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const row=app.doc.querySelector('[data-player-id="af:player:3"]').closest('.lineup-person');
 for(const [kind,count,label] of [['goal',2,'ゴール 2回'],['assist',3,'アシスト 3回']]){
  const stack=row.querySelector(`.lineup-portrait [data-contribution="${kind}"]`);
  assert.equal(stack.dataset.count,String(count));assert.equal(stack.getAttribute('aria-label'),label);
  assert.equal(stack.querySelectorAll('.pitch-contribution-badge').length,count);
 }
 assert.ok(row.querySelector('[data-contribution=goal] svg'));
 assert.equal(row.querySelector('[data-contribution=assist] .pitch-assist-symbol').textContent,'A');
 assert.equal(row.querySelector('img').getAttribute('src'),'https://photos.test/bench.png');
 assert.equal(row.querySelector('strong').textContent,'Bench 1');
 assert.equal(row.querySelector('.shirt-number').textContent,'20');
 assert.equal(row.querySelector('.substitution').textContent,'IN 60′');
 assert.match(row.textContent,/出場 30分/);
 await app.click('[data-lineup-team="af:team:2"]');
 assert.equal(app.doc.querySelector('.lineup-person .pitch-contribution-stack'),null);
});

test('bench scoring falls back to confirmed same-team events without awarding cancelled or own goals',async t=>{
 const detail=bundle();detail.playerStats=[];
 detail.events=[
  {type:'goal',detail:'Normal Goal',teamId:home.id,playerId:'af:player:3'},
  {type:'goal',detail:'Normal Goal',teamId:home.id,playerId:'af:player:1',relatedPlayerId:'af:player:3'},
  ...['Own Goal','Missed Penalty','Goal cancelled'].map(description=>({type:'goal',detail:description,teamId:home.id,playerId:'af:player:3',relatedPlayerId:'af:player:3'})),
  {type:'goal',detail:'Normal Goal',teamId:away.id,playerId:'af:player:3',relatedPlayerId:'af:player:3'},
 ];
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const row=app.doc.querySelector('[data-player-id="af:player:3"]').closest('.lineup-person');
 assert.equal(row.querySelector('[data-contribution=goal]').dataset.count,'1');
 assert.equal(row.querySelector('[data-contribution=assist]').dataset.count,'1');
});

test('bench contributions appear during live refresh and follow final corrections without losing the selected team',async t=>{
 const intervals=[];let phase=0;
 const current=()=>{
  const result=bundle();
  result.fixture={...fixture(),kickoffUtc:new Date().toISOString(),status:{short:phase===2?'FT':'2H'},ingestionState:phase===2?'finalized':'live'};
  result.playerStats.push({teamId:away.id,playerId:'af:player:4',values:{minutes:30,goals:phase===0?0:phase===1?2:1,assists:phase===1?1:0}});
  result.events=[{type:'substitution',teamId:away.id,playerId:'af:player:2',relatedPlayerId:'af:player:4',elapsed:60}];
  return result;
 };
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',intervals,
  feed:async()=>({fixtures:[current().fixture]}),
  request:async url=>new URL(url).pathname.includes('/fixtures/')?{ok:true,status:200,json:async()=>current()}:null});
 await app.click('[data-lineup-team="af:team:2"]');
 const row=()=>app.doc.querySelector('[data-player-id="af:player:4"]').closest('.lineup-person');
 assert.equal(row().querySelector('.pitch-contributions'),null);
 phase=1;intervals.find(item=>item.ms===60000).callback();
 await until(()=>row().querySelector('[data-contribution=goal]')?.dataset.count==='2','live substitute goal');
 assert.equal(row().querySelector('[data-contribution=assist]').dataset.count,'1');
 await tick();phase=2;intervals.find(item=>item.ms===60000).callback();
 await until(()=>app.doc.querySelector('.status-pill')?.textContent==='FT','final substitute stats');
 assert.equal(row().querySelector('[data-contribution=goal]').dataset.count,'1');
 assert.equal(row().querySelector('[data-contribution=assist]'),null);
 assert.equal(row().querySelector('.substitution').textContent,'IN 60′');
 assert.equal(app.doc.querySelector('[data-lineup-team][aria-pressed=true]').dataset.lineupTeam,away.id);
});

test('formation overlays distinct stacked goal and assist badges without changing names or shirt numbers',async t=>{
 const detail=bundle();detail.playerStats[0].values={goals:2,assists:3};detail.playerStats[1].values={goals:0,assists:1};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const marker=app.doc.querySelector('.pitch-player');
 for(const [kind,count,label] of [['goal',2,'ゴール 2回'],['assist',3,'アシスト 3回']]){
  const stack=marker.querySelector(`[data-contribution="${kind}"]`);
  assert.equal(stack.dataset.count,String(count));assert.equal(stack.getAttribute('aria-label'),label);
  assert.equal(stack.querySelectorAll('.pitch-contribution-badge').length,count);
  assert.deepEqual([...stack.querySelectorAll('.pitch-contribution-badge')].map(el=>el.style.getPropertyValue('--stack-index')),Array.from({length:count},(_,i)=>String(i)));
 }
 assert.ok(marker.querySelector('[data-contribution=goal] svg'));
 assert.equal(marker.querySelector('[data-contribution=assist] .pitch-assist-symbol').textContent,'A');
 assert.equal(marker.querySelector('.pitch-disc').textContent,'9');assert.equal(marker.querySelector('.pitch-name').textContent,'Starter 1');
 assert.match(app.doc.querySelector('.pitch-contribution-legend').textContent,/ゴール.*アシスト/);
 await app.click('[data-lineup-team="af:team:2"]');
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=goal]'),null);
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=assist]').dataset.count,'1');
});

test('formation event fallback excludes own goals, missed penalties and cancelled goals and respects team identity',async t=>{
 const detail=bundle();detail.playerStats=[];
 detail.events=['Normal Goal','Penalty','Own Goal','Missed Penalty','Goal cancelled'].map((description,i)=>({type:'goal',detail:description,teamId:home.id,playerId:'af:player:1',relatedPlayerId:'af:player:3',elapsed:i+1}));
 detail.events.push({type:'goal',detail:'Normal Goal',teamId:away.id,playerId:'af:player:1',relatedPlayerId:'af:player:3'});
 detail.lineups[0].startXI.push({id:'af:player:3',name:'Assist Player',number:10,position:'F'});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const players=app.doc.querySelectorAll('.pitch-player');
 assert.equal(players[0].querySelector('[data-contribution=goal]').dataset.count,'2');
 assert.equal(players[0].querySelector('[data-contribution=assist]'),null);
 assert.equal(players[1].querySelector('[data-contribution=assist]').dataset.count,'2');
 assert.equal(players[1].querySelector('[data-contribution=goal]'),null);
});

test('formation uses acquired zero over old events and never fabricates badges from missing or conflicting stats',async t=>{
 const detail=bundle();detail.playerStats[0].values={goals:0,assists:2};detail.playerStats[0].fieldStates={assists:{presence:'conflict'}};
 detail.events=[{type:'goal',detail:'Normal Goal',teamId:home.id,playerId:'af:player:1',relatedPlayerId:'af:player:1'}];
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.equal(app.doc.querySelectorAll('.pitch-player .pitch-contribution-stack').length,0);
 await app.click('[data-lineup-team="af:team:2"]');
 assert.equal(app.doc.querySelectorAll('.pitch-player .pitch-contribution-stack').length,0);
});

test('exceptional contribution counts stay bounded while exposing the exact total',async t=>{
 const detail=bundle();detail.playerStats[0].values={goals:9,assists:0};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const stack=app.doc.querySelector('.pitch-player [data-contribution=goal]');
 assert.equal(stack.querySelectorAll('.pitch-contribution-badge').length,3);
 assert.equal(stack.getAttribute('aria-label'),'ゴール 9回');assert.equal(stack.querySelector('.pitch-contribution-total').textContent,'×9');
});

test('formation badges follow live goals and assists, retained-stat fallback, and final corrections',async t=>{
 const intervals=[];let phase=0;
 const current=()=>{
  const result=bundle();result.fixture={...fixture(),kickoffUtc:new Date().toISOString(),status:{short:phase===3?'FT':'2H'},ingestionState:phase===3?'finalized':'live'};
  result.playerStats[1].values={goals:phase===3?1:phase===0?0:2,assists:phase===3?0:1};
  if(phase===2){result.fixture.provenance={issues:['live_retained_playerStats']};result.playerStats[1].values={goals:0,assists:0};result.events=[{type:'goal',detail:'Normal Goal',teamId:away.id,playerId:'af:player:2'}];}
  return result;
 };
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',intervals,
  feed:async()=>({fixtures:[current().fixture]}),
  request:async url=>new URL(url).pathname.includes('/fixtures/')?{ok:true,status:200,json:async()=>current()}:null});
 await app.click('[data-lineup-team="af:team:2"]');
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=goal]'),null);
 phase=1;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.doc.querySelector('.pitch-player [data-contribution=goal]')?.dataset.count==='2','live scoring badge');
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=assist]').dataset.count,'1');
 await tick();phase=2;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.doc.querySelector('.pitch-player [data-contribution=goal]')?.dataset.count==='1','fresh event replaces retained stats');
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=assist]'),null);
 await tick();phase=3;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.doc.querySelector('.status-pill')?.textContent==='FT','final correction');
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=goal]').dataset.count,'1');
 assert.equal(app.doc.querySelector('.pitch-player [data-contribution=assist]'),null);
 assert.equal(app.doc.querySelector('[data-lineup-team][aria-pressed=true]').dataset.lineupTeam,away.id);
});
async function boot(t,{hash='#/matches?date=2026-09-01&filter=all',legacy={},detail=bundle(),feed,catalog={competitions:[]},seasonDetail={},standings={groups:[]},storage={},apiBase='https://api.test',publicConfig,search='',request,intervals}={}) {
 const dom = new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:`https://football.test/${search}${hash}`,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window, calls=[], scrollCalls=[];
 if(intervals) w.setInterval=(callback,ms)=>{intervals.push({callback,ms});return intervals.length;};
 for(const css of ['app-v2.css','app-v2-league.css','app-v2-wireframe.css']) {const style=w.document.createElement('style');style.textContent=fs.readFileSync(path.join(root,css),'utf8');w.document.head.append(style);}
 t.after(()=>w.close());
 w.matchMedia=()=>({matches:false});
 w.scrollTo=(arg)=>{scrollCalls.push({...arg});Object.defineProperty(w,'scrollY',{value:arg.top||0,configurable:true});};
 if(apiBase) w.FOOTBALL_V2_API_BASE=apiBase;
 for(const [k,v] of Object.entries(storage)) w.localStorage.setItem(k,typeof v === 'string' ? v : JSON.stringify(v));
 w.JFWV2BackfillData={loadCurrentMergedData:async()=>({players:[],topMatches:[],...legacy})};
 w.fetch=async (url,options)=>{calls.push(String(url));if(request){const response=await request(url,options);if(response)return response;}const p=new URL(url).pathname;let body=p==='/api/v2/competitions'?catalog:p.endsWith('/standings')?standings:p.includes('/seasons/')?seasonDetail:p.includes('/fixtures/')?detail:p.includes('/dates/')?(feed?await feed():{fixtures:[fixture()]}):{fixtures:[]};return {ok:true,status:200,json:async()=>structuredClone(body)};};
 for(const file of ['formation-view.js','jfw-rating.js','jfw-fixture-rating.js','app-v2-config.js','app-v2-data.js','tracked-player-stats.js','tracked-player-provider-ids.js','all-player-stats.js','app-v2-history.js','app-v2-router.js','player-name-data.js','player-names.js','jfw-analysis.js','app-v2.js']) if(fs.existsSync(path.join(root,file)))w.eval(file === 'app-v2-config.js' && publicConfig ? publicConfig : fs.readFileSync(path.join(root,file),'utf8'));
 await tick();
 const click=async selector=>{const el=w.document.querySelector(selector);assert.ok(el,`missing ${selector}`);el.click();await tick();};
 return {w,doc:w.document,calls,scrollCalls,click,text:()=>w.document.getElementById('appMain').textContent};
}

test('ChatGPT analysis copies the loaded match snapshot without fetching more data and uses a safe external link', async t => {
 const detail=bundle();detail.fixture.provenance={source:'api-football',fetchedAt:'2026-09-01T15:00:00Z'};
 detail.playerStats[0].values={minutes:90,goals:0,assists:0,penaltiesConceded:null};
 detail.playerStats[0].fieldStates={penaltiesConceded:{presence:'provider_missing'}};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=stats',detail,search:'?unused=private'});
 let copied;Object.defineProperty(app.w.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});
 const calls=app.calls.length;
 const link=app.doc.querySelector('[data-chatgpt-analysis]');
 assert.equal(link.href,'https://chatgpt.com/');assert.equal(link.target,'_blank');
 assert.match(link.rel,/noopener/);assert.match(link.rel,/noreferrer/);
 await app.click('[data-chatgpt-analysis]');
 assert.equal(app.calls.length,calls);
 const dialog=app.doc.getElementById('analysisHandoff');
 assert.equal(dialog.open,true);
 assert.match(dialog.textContent,/コピーしました/);
 assert.equal(dialog.querySelector('textarea').value,copied);
 const snapshot=JSON.parse(copied.split('JFWスナップショット（JSON）:\n')[1]);
 assert.equal(snapshot.fixtureUrl,'https://football.test/#/fixtures/af%3Afixture%3A10?tab=overview');
 assert.ok(snapshot.detailReceivedAt);
 assert.equal(snapshot.sections.playerStats.rows[0].values.goals,0);
 assert.equal(snapshot.sections.playerStats.rows[0].fieldStates.penaltiesConceded,'provider_missing');
 assert.doesNotMatch(copied,/unused=private/);
 await app.click('[data-analysis-close]');
 assert.equal(app.doc.getElementById('analysisHandoff'),null);
 assert.equal(app.doc.activeElement,link);
});

for(const mode of ['unavailable','denied']) test(`ChatGPT analysis supports manual copy when clipboard is ${mode}`,async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10'});
 if(mode==='denied')Object.defineProperty(app.w.navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied');}}});
 await app.click('[data-chatgpt-analysis]');
 const dialog=app.doc.getElementById('analysisHandoff'),text=dialog.querySelector('textarea');
 assert.match(dialog.textContent,/自動コピーできませんでした/);
 assert.equal(dialog.querySelector('details').open,true);
 assert.equal(app.doc.activeElement,text);
 assert.equal(text.selectionStart,0);assert.equal(text.selectionEnd,text.value.length);
 assert.equal(dialog.querySelector('a').href,'https://chatgpt.com/');
 dialog.dispatchEvent(new app.w.Event('cancel',{cancelable:true}));
 assert.equal(app.doc.getElementById('analysisHandoff'),null);
});

test('ChatGPT analysis keeps its snapshot during live repaint and uses the latest details on the next click',async t=>{
 const intervals=[];let phase=0;
 const current=()=>{
  const result=bundle();result.fixture={...fixture(),status:{short:'2H',elapsed:phase?66:60},kickoffUtc:new Date().toISOString()};
  result.playerStats[0].values={minutes:phase?66:60,goals:phase?1:0};return result;
 };
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10',intervals,feed:async()=>({fixtures:[current().fixture]}),
  request:async url=>new URL(url).pathname.includes('/fixtures/')?{ok:true,status:200,json:async()=>current()}:null});
 const copied=[];Object.defineProperty(app.w.navigator,'clipboard',{value:{writeText:async text=>{copied.push(text);}}});
 await app.click('[data-chatgpt-analysis]');
 const original=app.doc.getElementById('analysisHandoff'),text=original.querySelector('textarea').value;
 phase=1;intervals.find(item=>item.ms===60000).callback();await tick();await tick();
 assert.equal(app.doc.getElementById('analysisHandoff'),original);
 await app.click('[data-analysis-copy]');assert.equal(copied.at(-1),text);
 await app.click('[data-analysis-close]');await app.click('[data-chatgpt-analysis]');
 const snapshot=JSON.parse(copied.at(-1).split('JFWスナップショット（JSON）:\n')[1]);
 assert.equal(snapshot.detailFixture.status.elapsed,66);
 assert.equal(snapshot.sections.playerStats.rows[0].values.goals,1);
 assert.notEqual(copied.at(-1),text);
});

test('paused live keeps stored fixtures and explains the pause only on today',async t=>{
 const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
 const app=await boot(t,{
  hash:`#/matches?date=${today}&filter=all`,
  request:async url=>new URL(url).pathname==='/api/v2/live'
   ? {ok:true,status:200,json:async()=>({fixtures:[],liveUpdatesEnabled:false,reason:'temporarily_paused'})}:null,
 });
 await until(()=>app.text().includes('ライブ更新は一時停止中です。'),'live pause notice');
 assert.match(app.text(),/Home Club/);
 assert.match(app.text(),/Away Club/);
 await app.click('[data-date]');
 assert.doesNotMatch(app.text(),/ライブ更新は一時停止中/);
});

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
test('common search finds saved full names and verified Japanese aliases without extra requests',async t=>{
 const app=await boot(t,{legacy:{players:[
  {playerId:'af:player:16',name:'M. Götze',club:'Frankfurt'},
  {playerId:'af:player:106835',name:'K. Mitoma',club:'Brighton'},
 ]}});
 await app.click('#searchButton');
 const input=app.doc.getElementById('globalSearch'),calls=app.calls.length;
 for(const [query,id] of [['ＧＯＴＺＥ　ＭＡＲＩＯ','af:player:16'],['三笘 薫','af:player:106835'],['mitoma brighton','af:player:106835']]){
  input.value=query;input.dispatchEvent(new app.w.Event('input',{bubbles:true}));await tick();
  assert.equal(app.doc.getElementById('globalSearch'),input);
  assert.ok(app.doc.querySelector(`#searchResults [data-player-id="${id}"]`),query);
 }
 input.value='unrelated';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelector('#searchResults [data-player-id]'),null);
 assert.equal(app.calls.length,calls);
});
test('Japanese club discovery completes all pages before enabling the filter and preserves search input',async t=>{
 let release;const secondPage=new Promise(resolve=>release=resolve);
 const profile=(id,name,clubs)=>({id:`af:player:${id}`,providerId:id,name,nationality:'Japan',rosterObservedOn:'2026-10-27',rosterTeams:clubs});
 const monaco=team(91,'Monaco'),brighton=team(51,'Brighton');
 const app=await boot(t,{request:async url=>{
  const u=new URL(url);if(u.pathname!=='/api/v2/players'||u.searchParams.get('nationality')!=='Japan')return null;
  if(u.searchParams.get('after')==='0')return {ok:true,status:200,json:async()=>({players:[profile(990001,'First Japan',[monaco])],nextCursor:990001})};
  await secondPage;return {ok:true,status:200,json:async()=>({players:[profile(990002,'Second Japan',[monaco]),profile(990003,'Third Japan',[brighton])],nextCursor:null})};
 }});
 await app.click('#searchButton');
 const input=app.doc.getElementById('globalSearch');input.value='もなこ';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.getElementById('japaneseClubFilter').disabled,true);
 assert.equal(app.doc.querySelector('[data-japanese-club]'),null);
 release();await until(()=>!app.doc.getElementById('japaneseClubFilter').disabled,'complete Japanese club membership');
 assert.equal(app.doc.getElementById('globalSearch'),input);assert.equal(input.value,'もなこ');
 const row=app.doc.querySelector('#searchResults [data-team-id="af:team:91"]');
 assert.match(row.textContent,/日本人所属 2人/);assert.match(row.textContent,/First Japan・Second Japan/);
 assert.match(row.querySelector('[data-japanese-club]').getAttribute('aria-label'),/名簿確認 2026-10-27/);
 const checkbox=app.doc.getElementById('japaneseClubFilter');checkbox.checked=true;checkbox.dispatchEvent(new app.w.Event('change'));
 input.value='';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelectorAll('#searchResults [data-team-id]').length,2);
 assert.equal(app.doc.querySelector('#searchResults [data-team-id="af:team:1"]'),null);
 assert.ok(app.doc.querySelector('#searchResults [data-team-id="af:team:51"]'));
 assert.equal(app.doc.querySelector('#searchResults [data-player-id]'),null);
});

test('confirmed Japanese membership is marked in match lists, standings and club details',async t=>{
 const league={id:'af:competition:39',name:'Premier League',seasons:[{id:'af:season:39:2026',status:'active'}]};
 const app=await boot(t,{catalog:{competitions:[league]},
  standings:{competition:league,season:{id:'af:season:39:2026'},groups:[{table:[home,away].map((club,i)=>({rank:i+1,team:club,points:3-i}))}]},
  request:async url=>{
   const u=new URL(url);if(u.pathname!=='/api/v2/players'||u.searchParams.get('nationality')!=='Japan')return null;
   return {ok:true,status:200,json:async()=>({players:[{id:'af:player:990001',providerId:990001,name:'Current Japanese Player',nationality:'Japan',rosterObservedOn:'2026-10-27',rosterTeams:[home],rosterHistory:[away]}],nextCursor:null})};
  }});
 await until(()=>app.doc.querySelector('.fixture-row [data-japanese-club="af:team:1"]'),'match club badge');
 assert.equal(app.doc.querySelector('[data-japanese-club="af:team:2"]'),null);
 await app.click('[data-page="leagues"]');await app.click('[data-competition-id="af:competition:39"]');await app.click('[data-competition-tab="standings"]');
 assert.ok(app.doc.querySelector('.standings-club-link[data-team-id="af:team:1"] [data-japanese-club]'));
 assert.equal(app.doc.querySelector('.standings-club-link[data-team-id="af:team:2"] [data-japanese-club]'),null);
 await app.click('.standings-club-link[data-team-id="af:team:1"]');
 assert.ok(app.doc.querySelector('.entity-hero [data-japanese-club="af:team:1"]'));
 assert.match(app.doc.querySelector('.entity-hero').textContent,/Current Japanese Player.*名簿確認 2026-10-27/);
});

test('failed Japanese club pagination publishes no partial membership and supports explicit retry without loops',async t=>{
 let fail=true;let calls=0;
 const app=await boot(t,{request:async url=>{
  const u=new URL(url);if(u.pathname!=='/api/v2/players'||u.searchParams.get('nationality')!=='Japan')return null;
  calls++;const after=u.searchParams.get('after');
  if(after!=='0'&&fail)return {ok:false,status:503,json:async()=>({error:'temporarily unavailable'})};
  return {ok:true,status:200,json:async()=>({players:after==='0'?[{id:'af:player:990001',providerId:990001,name:'Japanese Player',nationality:'Japan',rosterTeams:[home]}]:[],nextCursor:after==='0'?990001:null})};
 }});
 await app.click('#searchButton');await until(()=>app.doc.querySelector('[data-retry-japanese-clubs]'),'membership failure status');
 assert.equal(app.doc.getElementById('japaneseClubFilter').disabled,true);assert.equal(app.doc.querySelector('[data-japanese-club]'),null);
 await app.click('#searchBack');await app.click('#searchButton');assert.equal(calls,2);
 const input=app.doc.getElementById('globalSearch');input.value='Home';input.dispatchEvent(new app.w.Event('input'));
 fail=false;await app.click('[data-retry-japanese-clubs]');
 await until(()=>app.doc.querySelector('#searchResults [data-japanese-club="af:team:1"]'),'retried membership');
 assert.equal(app.doc.getElementById('globalSearch'),input);assert.equal(calls,4);
 assert.equal(app.doc.getElementById('japaneseClubFilter').disabled,false);
});

test('late Japanese club membership cannot reopen a search page after navigation',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await boot(t,{request:async url=>{
  const u=new URL(url);if(u.pathname!=='/api/v2/players'||u.searchParams.get('nationality')!=='Japan')return null;
  await pending;return {ok:true,status:200,json:async()=>({players:[{id:'af:player:990001',providerId:990001,name:'Japanese Player',nationality:'Japan',rosterTeams:[home]}],nextCursor:null})};
 }});
 await app.click('#searchButton');await app.click('[data-page="more"]');release();await tick();
 assert.equal(app.doc.getElementById('pageTitle').textContent,'その他');assert.equal(app.doc.getElementById('globalSearch'),null);
});
test('common and competition searches share cup aliases, country terms and kana normalization',async t=>{
 const cup={id:'af:competition:48',name:'League Cup',country:'England',seasons:[]};
 const app=await boot(t,{hash:'#/competitions',catalog:{competitions:[cup]},feed:async()=>({fixtures:[]})});
 const input=app.doc.getElementById('leagueSearch');
 input.value='ｶﾗﾊﾞｵ';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelectorAll('#leagueDirectory [data-competition-id]').length,1);
 await app.click('#searchButton');
 const global=app.doc.getElementById('globalSearch');
 global.value='からばお ＥＮＧＬＡＮＤ';global.dispatchEvent(new app.w.Event('input'));
 assert.ok(app.doc.querySelector('#searchResults [data-competition-id="af:competition:48"]'));
 global.value='・';global.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelector('#searchResults [data-competition-id]'),null);
});
test('Japanese club aliases find teams from saved standings on a cold search and preserve typed input',async t=>{
 const competitions=[61,140].map(id=>({id:`af:competition:${id}`,name:`League ${id}`,seasons:[{id:`af:season:${id}:2026`,status:'active'}]}));
 let release;const ready=new Promise(resolve=>release=resolve);
 const app=await boot(t,{catalog:{competitions},request:async url=>{
  const p=new URL(url).pathname;
  if(!p.endsWith('/standings'))return null;
  await ready;const league=p.includes('competition%3A61')?61:140;
  return {ok:true,status:200,json:async()=>({competition:{id:`af:competition:${league}`},season:{id:`af:season:${league}:2026`},groups:[{table:[{team:league===61?team(91,'Monaco'):team(529,'Barcelona'),rank:1,points:3}]}]})};
 }});
 await app.click('#searchButton');
 const input=app.doc.getElementById('globalSearch');input.value='もなこ';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelector('#searchResults [data-team-id="af:team:91"]'),null);
 release();await until(()=>app.doc.querySelector('#searchResults [data-team-id="af:team:91"]'),'Monaco from saved standings');
 assert.equal(app.doc.getElementById('globalSearch'),input);assert.equal(input.value,'もなこ');
 for(const query of ['ばるさ','ﾊﾞﾙｻ','バルセロナ','Barça']){
  input.value=query;input.dispatchEvent(new app.w.Event('input'));await tick();
  assert.ok(app.doc.querySelector('#searchResults [data-team-id="af:team:529"]'),query);
  assert.equal(app.doc.querySelector('#searchResults [data-team-id="af:team:91"]'),null);
 }
 const count=app.calls.filter(url=>url.endsWith('/standings')).length;
 assert.equal(count,2);
 await app.click('#searchBack');await app.click('#searchButton');
 assert.equal(app.calls.filter(url=>url.endsWith('/standings')).length,count);
 assert.ok(app.calls.every(url=>new URL(url).origin==='https://api.test'));
});
test('club aliases also search player clubs and do not leak to similarly named youth clubs',async t=>{
 const app=await boot(t,{legacy:{players:[{playerId:'jp-minamino',name:'南野拓実',club:'AS Monaco'}]},feed:async()=>({fixtures:[{...fixture(),teams:{home:team(529,'Barcelona'),away:team(999,'Barcelona U19')}}]})});
 await app.click('#searchButton');const input=app.doc.getElementById('globalSearch');
 input.value='もなこ';input.dispatchEvent(new app.w.Event('input'));
 assert.ok(app.doc.querySelector('#searchResults [data-player-id="jp-minamino"]'));
 input.value='ばるさ';input.dispatchEvent(new app.w.Event('input'));
 assert.ok(app.doc.querySelector('#searchResults [data-team-id="af:team:529"]'));
 assert.equal(app.doc.querySelector('#searchResults [data-team-id="af:team:999"]'),null);
});
test('search keeps acquired clubs on partial failure and retries only after explicit action',async t=>{
 const competitions=[61,140].map(id=>({id:`af:competition:${id}`,name:`League ${id}`,seasons:[{id:`af:season:${id}:2026`,status:'active'}]}));
 let attempts=0;
 const app=await boot(t,{catalog:{competitions},request:async url=>{
  const p=new URL(url).pathname;if(!p.endsWith('/standings'))return null;
  const league=p.includes('competition%3A61')?61:140;
  if(league===140&&++attempts===1)return {ok:false,status:503,json:async()=>({code:'not_fetched'})};
  return {ok:true,status:200,json:async()=>({competition:{id:`af:competition:${league}`},season:{id:`af:season:${league}:2026`},groups:[{table:[{team:league===61?team(91,'Monaco'):team(529,'Barcelona')}]}]})};
 }});
 await app.click('#searchButton');await until(()=>app.doc.querySelector('[data-retry-search-teams]'),'partial failure status');
 const input=app.doc.getElementById('globalSearch');input.value='ばるさ';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelector('#searchResults [data-team-id="af:team:529"]'),null);
 assert.equal(attempts,1);
 input.value='もなこ';input.dispatchEvent(new app.w.Event('input'));
 assert.ok(app.doc.querySelector('#searchResults [data-team-id="af:team:91"]'));
 await app.click('[data-retry-search-teams]');
 await until(()=>!app.doc.querySelector('[data-retry-search-teams]'),'retry completed');
 input.value='ばるさ';input.dispatchEvent(new app.w.Event('input'));
 assert.ok(app.doc.querySelector('#searchResults [data-team-id="af:team:529"]'));
 assert.equal(attempts,2);
});
test('lineup switches between one team at a time with starters, bench and coach visible',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup'});
 assert.equal(app.doc.querySelectorAll('.lineup-card').length,1);
 assert.equal(app.doc.querySelectorAll('[data-lineup-team]').length,2);
 for(const [id,n,other] of [[home.id,1,2],[away.id,2,1],[home.id,1,2]]) {
  await app.click(`[data-lineup-team="${id}"]`);
  assert.equal(app.doc.querySelector('[data-lineup-team][aria-pressed=true]').dataset.lineupTeam,id);
  const card=app.doc.querySelector('.lineup-card');
  for(const name of [`Starter ${n}`,`Bench ${n}`,`Coach ${n}`])assert.ok(card.textContent.includes(name));
  assert.ok(!card.textContent.includes(`Starter ${other}`));
  assert.equal(card.querySelectorAll('.coach-row img').length,1);
  for(const el of card.querySelectorAll('.lineup-person,.coach-row'))assert.ok(visible(el,app.w));
 }
});
test('ratings are grouped under the corresponding home and away team',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings'});
 for(const [id,name] of [['af:team:1','Starter 1'],['af:team:2','Starter 2']]){
 const group=app.doc.querySelector(`[data-rating-team="${id}"]`);assert.ok(group);assert.ok(visible(group,app.w));assert.match(group.textContent,new RegExp(name));assert.equal(group.querySelectorAll('.rating-row').length,1);
 }
});
test('only pitch labels are short while starter, bench, ratings and detail names expand',async t=>{
 const detail=bundle();
 Object.assign(detail.lineups[0].startXI[0],{id:'af:player:278088',name:'C. Rushworth'});
 Object.assign(detail.lineups[0].substitutes[0],{id:'af:player:37961',name:'M. van Ewijk'});
 Object.assign(detail.playerStats[0],{playerId:'af:player:278088',playerName:'C. Rushworth'});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.equal(app.doc.querySelector('.pitch-name').textContent,'C. Rushworth');
 assert.equal(app.doc.querySelector('.pitch-name').title,'Carl Andrew Rushworth');
 assert.equal(app.doc.querySelector('.lineup-person strong').textContent,'Carl Andrew Rushworth');
 assert.equal(app.doc.querySelector('[data-player-id="af:player:37961"]').textContent,'Milan Fabrizio van Ewijk');
 await app.click('[data-detail-tab="ratings"]');
 assert.equal(app.doc.querySelector('[data-rating-player="af:player:278088"] strong').textContent,'Carl Andrew Rushworth');
 await app.click('[data-detail-tab="lineup"]');
 await app.click('[data-player-id="af:player:278088"]');
 assert.equal(app.doc.querySelector('.entity-hero h2').textContent,'Carl Andrew Rushworth');
 assert.equal(detail.lineups[0].startXI[0].name,'C. Rushworth');
});
test('pitch uses the saved short label while an existing full list name stays full',async t=>{
 const detail=bundle();
 Object.assign(detail.lineups[0].startXI[0],{id:'af:player:2937',name:'Declan Rice'});
 Object.assign(detail.playerStats[0],{playerId:'af:player:2937',playerName:'Declan Rice'});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.equal(app.doc.querySelector('.pitch-name').textContent,'D. Rice');
 assert.equal(app.doc.querySelector('.lineup-person strong').textContent,'Declan Rice');
 await app.click('[data-detail-tab="ratings"]');
 assert.equal(app.doc.querySelector('[data-rating-player="af:player:2937"] strong').textContent,'Declan Rice');
});
test('acquired stat photos are shared by pitch, lineup lists, ratings and player detail',async t=>{
 const detail=bundle();
 detail.playerStats[0].playerPhoto='https://photos.test/starter1.png';
 detail.playerStats.push({playerId:'af:player:3',playerName:'Bench 1',teamId:home.id,playerPhoto:'https://photos.test/bench1.png',values:{minutes:12}});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 const pitch=app.doc.querySelector('.pitch-player');
 assert.equal(pitch.querySelector('img').src,detail.playerStats[0].playerPhoto);
 assert.equal(pitch.querySelector('.pitch-disc').textContent,'9');
 assert.equal(pitch.querySelector('.pitch-name').textContent,'Starter 1');
 const rows=app.doc.querySelectorAll('.lineup-card .lineup-person');
 assert.equal(rows[0].querySelector('img').src,detail.playerStats[0].playerPhoto);
 assert.equal(rows[1].querySelector('img').src,'https://photos.test/bench1.png');
 const requests=app.calls.length;
 await app.click('[data-detail-tab="ratings"]');
 assert.equal(app.doc.querySelector('[data-rating-player="af:player:1"] img').src,detail.playerStats[0].playerPhoto);
 assert.equal(app.calls.length,requests,'photos reuse loaded data without extra API requests');
 await app.click('[data-detail-tab="lineup"]');
 await app.click('[data-player-id="af:player:1"]');
 assert.equal(app.doc.querySelector('.entity-hero .person-photo img').src,detail.playerStats[0].playerPhoto);
});
test('legacy photos match canonical IDs, while truly missing and failed photos keep a usable fallback',async t=>{
 const detail=bundle();detail.lineups[1].startXI[0].name='Starter 1';
 const legacy={players:[{playerId:'af:player:1',name:'Starter 1',photo:'https://photos.test/legacy.png'}]};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail,legacy});
 const player=app.doc.querySelector('.pitch-player');
 assert.equal(player.querySelector('img').src,legacy.players[0].photo);
 const image=player.querySelector('img');image.dispatchEvent(new app.w.Event('error'));
 assert.equal(image.hidden,true);assert.ok(image.closest('.person-avatar').classList.contains('is-fallback'));
 assert.equal(player.querySelector('.pitch-disc').textContent,'9');
 assert.ok(visible(player.querySelector('.person-initials'),app.w));
 assert.ok(visible(player.querySelector('.pitch-name'),app.w));
 await app.click('[data-lineup-team="af:team:2"]');
 const other=app.doc.querySelector('.pitch-player');
 assert.equal(other.querySelector('img'),null,'same name with another ID must not borrow a photo');
 assert.ok(other.querySelector('.person-fallback'));
 assert.ok(app.calls.every(url=>new URL(url).hostname==='api.test'));
});
test('missing photos in later fixture data cannot erase an acquired lineup photo in any view',async t=>{
 const detail=bundle();detail.lineups[0].startXI[0].photo='https://photos.test/acquired.png';
 detail.playerStats[0].playerPhoto=null;
 const legacy={players:[{playerId:'af:player:1',name:'Starter 1',photo:null}]};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail,legacy});
 assert.equal(app.doc.querySelector('.pitch-player img').src,'https://photos.test/acquired.png');
 await app.click('[data-detail-tab="ratings"]');
 assert.equal(app.doc.querySelector('[data-rating-player="af:player:1"] img').src,'https://photos.test/acquired.png');
 await app.click('[data-detail-tab="lineup"]');
 await app.click('[data-player-id="af:player:1"]');
 assert.equal(app.doc.querySelector('.entity-hero .person-photo img').src,'https://photos.test/acquired.png');
 await app.click('#searchButton');
 const input=app.doc.getElementById('globalSearch');input.value='Starter 1';input.dispatchEvent(new app.w.Event('input',{bubbles:true}));
 const image=app.doc.querySelector('#searchResults [data-player-id="af:player:1"] img');
 assert.equal(image.src,'https://photos.test/acquired.png');
 image.dispatchEvent(new app.w.Event('error'));assert.equal(image.hidden,true);
});
test('competition photos survive navigating into a fixture without photos',async t=>{
 const catalog={competitions:[{id:'af:competition:39',name:'Premier League',seasons:[{id:'af:season:39:2026',status:'active'}]}]};
 const seasonDetail={competition:catalog.competitions[0],season:catalog.competitions[0].seasons[0],playerStats:{presence:'present',rows:[{player:{id:'af:player:1',name:'Starter 1',photo:'https://photos.test/season.png'},team:home}]}};
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A39%3A2026&tab=players',catalog,seasonDetail});
 await until(()=>!!app.doc.querySelector('.player-stat-person img'),'season photos did not render');
 assert.equal(app.doc.querySelector('.player-stat-person img').src,'https://photos.test/season.png');
 app.w.location.hash='#/fixtures/af%3Afixture%3A10?tab=lineup';
 await until(()=>!!app.doc.querySelector('.pitch-player img'),'cached season photo was erased by missing fixture photos');
 assert.equal(app.doc.querySelector('.pitch-player img').src,'https://photos.test/season.png');
 await app.click('[data-detail-tab="ratings"]');
 assert.equal(app.doc.querySelector('[data-rating-player="af:player:1"] img').src,'https://photos.test/season.png');
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

test('JFW breakdown opens for both tracked and untracked players and closes in its URL',async t=>{
 const legacy={trackingPeriods:[{playerId:'af:player:1',teamId:'af:team:1',competitionId:'af:competition:39',tracked:true,from:'2026-08-01T00:00:00Z',to:null}]};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings',legacy});
 await app.click('[data-rating-mode="jfw"]');
 assert.match(app.w.location.hash,/ratingMode=jfw/);
 assert.equal(app.doc.querySelector('[data-rating-player="af:player:2"]').disabled,false);
 await app.click('[data-rating-player="af:player:2"]');assert.ok(app.doc.querySelector('.rating-breakdown'));
 await app.click('[data-rating-player="af:player:1"]');assert.match(app.w.location.hash,/player=af%3Aplayer%3A1/);assert.ok(app.doc.querySelector('.rating-breakdown'));
 await app.click('[data-close-rating]');assert.doesNotMatch(app.w.location.hash,/player=/);assert.equal(app.doc.querySelector('.rating-breakdown'),null);
});
test('JFW evaluates acquired statistics independently of attention competition scope',async t=>{
 const detail=bundle();detail.fixture.competitionId='af:competition:98';detail.fixture.score.goals={home:0,away:0};
 for(const row of detail.playerStats)Object.assign(row.values,{minutes:90,goals:0,assists:0,yellowCards:0,redCards:0,penaltiesConceded:0});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw',detail});
 assert.deepEqual([...app.doc.querySelectorAll('.rating-row b')].map(el=>el.textContent),['6.0','6.0']);
 assert.equal(app.doc.querySelectorAll('.rating-row [data-presence="not_applicable"]').length,0);
});
test('missing formation draws no overlapping players but keeps textual players and coach',async t=>{
 const detail=bundle();detail.lineups.forEach(l=>l.layoutConfidence='none');
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 for(const id of [home.id,away.id]){
  await app.click(`[data-lineup-team="${id}"]`);
  assert.equal(app.doc.querySelectorAll('.pitch-player').length,0);assert.equal(app.doc.querySelectorAll('.pitch-unavailable').length,1);
  assert.equal(app.doc.querySelectorAll('.lineup-person').length,2);assert.equal(app.doc.querySelectorAll('.coach-row').length,1);
 }
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
 assert.match(app.doc.querySelector('[data-fixture="af:fixture:4"]').textContent,/日程未定/);
});
test('old follows migrate to ID-only entries and absence from cache is not deletion',async t=>{
 const app=await boot(t,{hash:'#/following',storage:{'football-v2-follows':{teams:[{id:'af:team:999',name:'Old name',logo:'old.png'}],players:[],competitions:[]}}});
 assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,['af:team:999']);
 assert.match(app.text(),/参照先は未取得/);assert.doesNotMatch(app.text(),/Old name|削除済み/);
 await app.click('[data-follow-id="af:team:999"]');assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,[]);
});
test('legacy competition follows migrate to canonical IDs and out-of-scope J1 is discarded',async t=>{
 const catalog={competitions:[
  {id:'af:competition:39',name:'Premier League',seasons:[{id:'af:season:39:2026',status:'active'}]},
  {id:'af:competition:78',name:'Bundesliga',seasons:[{id:'af:season:78:2026',status:'active'}]},
 ]};
 const storage={'football-v2-follows':{teams:[],players:[],competitions:['legacy:competition:プレミアリーグ','legacy:competition:ブンデスリーガ','legacy:competition:J1']}};
 const app=await boot(t,{hash:'#/following',catalog,storage});
 await until(()=>/Premier League/.test(app.text()) && /Bundesliga/.test(app.text()),'canonical followed competitions did not render');
 assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).competitions,['af:competition:39','af:competition:78']);
 assert.doesNotMatch(app.text(),/J1/);
});
test('search closes to the full prior competition route across repeated excursions',async t=>{
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A39%3A2026&tab=standings'});
 const prior=app.w.location.hash;
 for(let i=0;i<2;i++){await app.click('#searchButton');await app.click('#searchBack');assert.equal(app.w.location.hash,prior);assert.ok(app.doc.querySelector('[data-competition-tab="standings"][aria-selected="true"]'));}
});
test('saved scroll belongs to each history entry and survives delayed list rendering',async t=>{
 let release, delay = false;
 const app=await boot(t,{feed:()=>delay ? new Promise(resolve=>{release=resolve;}) : {fixtures:[fixture()]}});
 await tick();await tick();
 app.w.dispatchEvent(new app.w.Event('wheel'));
 app.w.scrollTo({top:350});app.w.dispatchEvent(new app.w.Event('scroll'));
 assert.equal(app.w.history.state.footballV2.scrollY,350);
 await app.click('[data-fixture]');await tick();await tick();
 app.w.dispatchEvent(new app.w.Event('wheel'));
 app.w.scrollTo({top:80});app.w.dispatchEvent(new app.w.Event('scroll'));
 delay = true;app.scrollCalls.length=0;
 await app.click('#detailBack');
 await until(()=>app.scrollCalls.some(call=>call.top===350),'back must request the saved list position');
 assert.equal(app.w.scrollY,350);
 await until(()=>release,'return list request must be pending');
 await tick();await tick();app.scrollCalls.length=0;
 // Model a browser whose document height clamps the restored scroll before data arrives.
 Object.defineProperty(app.w,'scrollY',{value:0,configurable:true});
 release({fixtures:[fixture()]});
 await until(()=>app.scrollCalls.some(call=>call.top===350),'late list rendering must restore the saved position again');
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
test('Japanese list and tracked profile refresh from published stats while an unlinked player stays unknown',async t=>{
 const players=[
  {playerId:'jp-1',name:'Tracked Player',club:'Club A',league:'Premier League',trackingStatus:'active',rankingEligible:true,providerIds:{apiFootball:{player:42}},seasonStats:{apps:1,goals:9,assists:9}},
  {playerId:'jp-2',name:'Unlinked Player',club:'Club A',league:'Premier League',trackingStatus:'active',rankingEligible:true,seasonStats:{apps:1,goals:8,assists:8}},
 ];
 const app=await boot(t,{hash:'#/japanese?productSeason=jfw%3Aseason%3A2026-27',legacy:{_dataIntegrity:{season:'2026-27'},players,playerMatchStats:[{playerId:'jp-1',providerIds:{apiFootball:{player:42,team:50,league:39}}}]},
  request:async url=>{
   if(!String(url).includes('/seasons/')) return null;
   const id=Number(new URL(url).pathname.match(/competitions\/af%3Acompetition%3A(\d+)/)?.[1]);
   return {ok:true,status:200,json:async()=>({competition:{id:`af:competition:${id}`,providerId:id},playerStats:{presence:'present',rows:id===39?[{player:{providerId:42,name:'Tracked Player'},team:{id:'af:team:50'},appearances:4,goals:{value:2,presence:'present'},assists:{value:1,presence:'present'},minutes:{value:300,presence:'present'},redCards:{value:0,presence:'present'}}]:[]}})};
  }});
 await until(()=>app.doc.getElementById('japaneseList')?.textContent.includes('公開済み試合'),'published stats in list');
 const linked=app.doc.querySelector('[data-player-id="jp-1"]');
 assert.match(linked.textContent,/出場 4/);assert.match(linked.textContent,/G 2/);
 const unlinked=app.doc.querySelector('[data-player-id="jp-2"]');
 assert.match(unlinked.textContent,/選手ID未連携/);assert.doesNotMatch(unlinked.textContent,/G 8/);
 await app.click('[data-player-id="jp-1"]');
 assert.match(section(app,'今季スタッツ').textContent,/公開済み試合から更新/);
 assert.match(section(app,'今季スタッツ').textContent,/出場/);
 assert.match(app.text(),/海外日本人追跡/);
 assert.doesNotMatch(section(app,'直近試合').textContent,/以前の試合/);
});
test('player directory starts with all nationalities, labels countries and retains complete filter options across pages',async t=>{
 const profiles=[{id:'af:player:11',providerId:11,name:'Japanese Player',nationality:'Japan'},
  {id:'af:player:12',providerId:12,name:'国籍不明の選手',nationality:null},
  {id:'af:player:21',providerId:21,name:'French Player',nationality:'France'}];
 const app=await boot(t,{hash:'#/japanese',request:async url=>{
  const u=new URL(url);if(u.pathname!=='/api/v2/players')return null;
  const country=u.searchParams.get('nationality'),after=u.searchParams.get('after');
  const body={players:country==='all'?(after?[profiles[2]]:profiles.slice(0,2)):profiles.filter(p=>p.nationality===country),
   nextCursor:country==='all'&&!after?12:null,nationalities:['France','Japan']};
  return {ok:true,status:200,json:async()=>body};
 }});
 await until(()=>app.doc.querySelector('#japaneseList [data-player-id="af:player:12"]'),'all nationalities');
 assert.equal(app.doc.getElementById('pageTitle').textContent,'選手一覧');
 assert.equal(app.doc.getElementById('japaneseNationality').value,'all');
 assert.equal(app.doc.querySelector('[data-player-id="af:player:11"] .player-nationality').textContent,'日本');
 assert.equal(app.doc.querySelector('[data-player-id="af:player:12"] .player-nationality').textContent,'国籍未取得');
 assert.ok(app.doc.querySelector('#japaneseNationality option[value="France"]'),'country not on the first page');
 await app.click('#playerDirectoryMore');
 assert.ok(app.doc.querySelector('#japaneseList [data-player-id="af:player:11"]'));
 assert.equal(app.doc.querySelector('[data-player-id="af:player:21"] .player-nationality').textContent,'フランス');
 const select=app.doc.getElementById('japaneseNationality');select.value='France';select.dispatchEvent(new app.w.Event('change'));
 await until(()=>app.doc.querySelector('[data-player-id="af:player:21"]'),'France filter');
 assert.equal(app.doc.querySelector('[data-player-id="af:player:11"]'),null);
 assert.equal(app.doc.querySelector('[data-player-id="af:player:12"]'),null);
 assert.ok(app.doc.querySelector('#japaneseNationality option[value="Japan"]'));
 const first=new URL(app.calls.find(url=>new URL(url).pathname==='/api/v2/players'));
 assert.equal(first.searchParams.get('nationality'),'all');assert.equal(first.searchParams.get('includeNationalities'),'1');
});

test('an older nationality response cannot replace the currently selected country',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const app=await boot(t,{hash:'#/japanese',request:async url=>{
  const u=new URL(url);if(u.pathname!=='/api/v2/players')return null;
  const country=u.searchParams.get('nationality');if(country==='France')await pending;
  return {ok:true,status:200,json:async()=>({players:[{id:country==='France'?'af:player:21':'af:player:11',providerId:country==='France'?21:11,name:country,nationality:country==='France'?'France':'Japan'}],nextCursor:null,nationalities:['Japan','France']})};
 }});
 await until(()=>app.doc.querySelector('#japaneseNationality option[value="France"]'),'nationality options');
 let select=app.doc.getElementById('japaneseNationality');select.value='France';select.dispatchEvent(new app.w.Event('change'));
 select=app.doc.getElementById('japaneseNationality');select.value='Japan';select.dispatchEvent(new app.w.Event('change'));
 await until(()=>app.doc.querySelector('[data-player-id="af:player:11"]'),'Japanese filter');release();await tick();
 assert.equal(app.doc.getElementById('japaneseNationality').value,'Japan');
 assert.equal(app.doc.querySelector('[data-player-id="af:player:21"]'),null);
});

test('watch destinations are absent from match lists and detail while attention scores remain',async t=>{
 const row={...fixture(),watch:{label:'Sample service'},attention:{presence:'present',displayedScore:'12.00'}};
 const detail={...bundle(),fixture:row};
 const app=await boot(t,{detail,feed:async()=>({fixtures:[row]})});
 assert.doesNotMatch(app.text(),/配信:|Sample service/);assert.equal(app.doc.querySelector('.watch-label'),null);
 await app.click('[data-fixture]');
 assert.doesNotMatch(app.text(),/配信:|Sample service/);assert.equal(app.doc.querySelector('.watch-label'),null);
 assert.match(app.text(),/視聴価値 12.00/);
});

test('nationality directory links a Japanese profile and keeps transfer clubs separate',async t=>{
 const metric=value=>({presence:'present',value,observed:1,total:1});
 const row=(teamId,goals)=>({player:{id:'af:player:106835',providerId:106835,name:'K. Mitoma',nationality:'Japan'},
  team:{id:teamId,name:teamId==='af:team:71'?'Old Club':'New Club'},appearances:1,
  goals:metric(goals),assists:metric(0),minutes:metric(90),redCards:metric(0)});
 const profile={id:'af:player:106835',providerId:106835,name:'K. Mitoma',nationality:'Japan',
  birthDate:'1997-05-20',rosterObservedOn:'2026-10-17',rosterTeams:[{id:'af:team:72',name:'New Club'}]};
 const app=await boot(t,{hash:'#/japanese?productSeason=jfw%3Aseason%3A2026-27',
  legacy:{_dataIntegrity:{season:'2026-27'},players:[{playerId:'jp-1koq39p',name:'三笘薫',club:'Old Club',trackingStatus:'active'}]},
  request:async url=>{
   const pathname=new URL(url).pathname;
   if(pathname==='/api/v2/players')return {ok:true,status:200,json:async()=>({players:[profile],nextCursor:null})};
   if(pathname.includes('/seasons/'))return {ok:true,status:200,json:async()=>({competition:{id:'af:competition:39',providerId:39},playerStats:{presence:'present',rows:[],teamRows:pathname.includes('competition%3A39')?[row('af:team:71',1),row('af:team:72',0)]:[]}})};
   return null;
  }});
 await until(()=>app.doc.querySelector('[data-player-id="af:player:106835"]')?.textContent.includes('出場 2'),'Japanese directory stats');
 assert.match(app.doc.querySelector('[data-player-id="af:player:106835"]').textContent,/三笘薫/);
 assert.match(app.doc.querySelector('[data-player-id="af:player:106835"]').textContent,/New Club/);
 await app.click('[data-player-id="af:player:106835"]');
 assert.deepEqual([...section(app,'クラブ別成績').querySelectorAll('.history-row strong')].map(el=>el.textContent),['Old Club','New Club']);
});
test('a cold API-Football player link resolves to the tracked Japanese profile by explicit provider ID',async t=>{
 const app=await boot(t,{hash:'#/players/af%3Aplayer%3A42?productSeason=jfw%3Aseason%3A2026-27',
  legacy:{_dataIntegrity:{season:'2026-27'},players:[{playerId:'jp-1',name:'Tracked Player',league:'Premier League',trackingStatus:'active',providerIds:{apiFootball:{player:42}}}],playerMatchStats:[{playerId:'jp-1',providerIds:{apiFootball:{team:50,league:39}}}]},
  request:async url=>String(url).includes('/seasons/')?{ok:true,status:200,json:async()=>({competition:{id:'af:competition:39',providerId:39},playerStats:{presence:'present',rows:[{player:{providerId:42},team:{id:'af:team:50'},appearances:2,goals:{value:1,presence:'present'},assists:{value:0,presence:'present'},minutes:{value:150,presence:'present'},redCards:{value:0,presence:'present'}}]}})}:null});
 await until(()=>section(app,'今季スタッツ').textContent.includes('公開済み試合から更新'),'tracked player profile updated');
 assert.match(app.text(),/海外日本人追跡/);
 assert.match(section(app,'今季スタッツ').textContent,/得点/);
});
test('known competition seasons can change without losing the selected tab',async t=>{
 const app=await boot(t,{feed:()=>({fixtures:[{...fixture(),fixtureId:'af:fixture:11',seasonId:'af:season:39:2025'},fixture()]})});
 await app.click('[data-page="leagues"]');await app.click('[data-competition-id="af:competition:39"]');await app.click('[data-competition-tab="standings"]');
 const select=app.doc.getElementById('competitionSeason');assert.ok(select);
 assert.equal(select.value,'af:season:39:2026');
 assert.equal(new URLSearchParams(app.w.location.hash.split('?')[1]).get('competitionSeason'),'af:season:39:2026');
 select.value='af:season:39:2025';select.dispatchEvent(new app.w.Event('change'));await tick();
 const params=new URLSearchParams(app.w.location.hash.split('?')[1]);assert.equal(params.get('competitionSeason'),'af:season:39:2025');assert.equal(params.get('tab'),'standings');
 assert.equal(app.doc.getElementById('competitionSeason').value,'af:season:39:2025');
});
test('catalog identity survives a cold deep link and legacy aliases do not create duplicates',async t=>{
 const catalog={competitions:[
  {id:'af:competition:39',name:'Premier League',country:'England',logo:'https://logos.test/39.png',seasons:[{id:'af:season:39:2026',status:'active',summary:{fixtureCount:380}}]},
  {id:'af:competition:78',name:'Bundesliga',seasons:[{id:'af:season:78:2026',status:'active'}]},
  {id:'af:competition:135',name:'Serie A',seasons:[{id:'af:season:135:2026',status:'active'}]},
 ]};
 const players=['Premier League','プレミアリーグ','ブンデスリーガ','セリエA','J1'].map((league,index)=>({name:`Tracked ${index}`,league}));
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A39%3A2026&tab=overview',catalog,legacy:{players},feed:async()=>({fixtures:[]})});
 assert.match(app.text(),/Premier League/);assert.doesNotMatch(app.text(),/大会情報は未取得/);
 assert.equal(app.doc.querySelector('.competition-hero img').src,'https://logos.test/39.png');
 await app.click('#competitionBack');
 for(const id of ['39','78','135']) assert.equal(app.doc.querySelectorAll(`[data-competition-id="af:competition:${id}"]`).length,1);
 assert.equal(app.doc.querySelectorAll('[data-competition-id^="legacy:competition:"]').length,0);
 assert.doesNotMatch(app.text(),/J1/);
});
test('legacy date fallback canonicalizes known leagues and does not leak J1 into the directory',async t=>{
 const catalog={competitions:[{id:'af:competition:39',name:'Premier League',seasons:[{id:'af:season:39:2026',status:'active'}]}]};
 const legacy={topMatches:[
  {rank:1,league:'プレミアリーグ',match:'Home 1 - 0 Away',ko:'2026-09-01 12:00',status:'verified'},
  {rank:2,league:'J1',match:'J Home 2 - 1 J Away',ko:'2026-09-01 15:00',status:'verified'},
 ]};
 const request=async url=>new URL(url).pathname.includes('/dates/')?{ok:false,status:503,json:async()=>({error:'temporary'})}:null;
 const app=await boot(t,{catalog,legacy,request});
 await app.click('[data-page="leagues"]');
 assert.equal(app.doc.querySelectorAll('[data-competition-id="af:competition:39"]').length,1);
 assert.equal(app.doc.querySelectorAll('[data-competition-id^="legacy:competition:"]').length,0);
 assert.doesNotMatch(app.text(),/J1/);
});
test('overview, player stats, team stats and standings render stored D1 values without inventing missing values',async t=>{
 const catalog={competitions:[{id:'af:competition:39',name:'Premier League',country:'England',logo:'https://logos.test/39.png',seasons:[{id:'af:season:39:2026',status:'active'}]}]};
 const seasonDetail={competition:catalog.competitions[0],season:{id:'af:season:39:2026',startsOn:'2026-08-01',endsOn:'2027-05-31'},summary:{teamCount:20,fixtureCount:380,completedFixtureCount:30,publishedDetailCount:29,standingsUpdatedAt:'2026-09-08T02:15:09.068Z',detailUpdatedAt:'2026-09-08T02:00:00.000Z'},detailSections:{lineups:{present:29,presentEmpty:0,providerMissing:0,notFetched:0},events:{present:20,presentEmpty:2,providerMissing:7,notFetched:0},teamStats:{present:29,presentEmpty:0,providerMissing:0,notFetched:0},playerStats:{present:28,presentEmpty:0,providerMissing:0,notFetched:1}},playerStats:{presence:'present',rows:[{player:{id:'af:player:7',name:'Test Player',photo:null},team:{id:'af:team:1',name:'Home Club'},teamCount:1,appearances:3,starts:2,minutes:{value:180,presence:'present'},goals:{value:0,presence:'present'},assists:{value:null,presence:'not_fetched'},averageRating:{value:7.4,presence:'present'}}]}};
 const standings={competition:catalog.competitions[0],season:{id:'af:season:39:2026'},generatedAt:'2026-09-08T02:15:09.068Z',groups:[{name:'Premier League',table:[{rank:1,team:{id:'af:team:1',name:'Home Club',logo:null},overall:{played:3,wins:2,draws:1,losses:0,goalsFor:5,goalsAgainst:1},goalDifference:4,points:7,form:'WWD'}]}]};
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A39%3A2026&tab=overview',catalog,seasonDetail,standings,feed:async()=>({fixtures:[]})});
 await until(()=>/試合詳細の取得状況/.test(app.text()),'season overview did not load');
 assert.match(app.text(),/提供なし/);assert.match(app.text(),/順位表更新/);assert.doesNotMatch(app.text(),/準備中/);
 await app.click('[data-competition-tab="players"]');
 assert.match(app.text(),/Test Player/);assert.match(app.text(),/未取得/);assert.match(app.text(),/0/);
 await app.click('[data-competition-tab="teams"]');
 assert.match(app.text(),/Home Club/);assert.match(app.text(),/直近/);assert.doesNotMatch(app.text(),/準備中/);
 await app.click('[data-competition-tab="standings"]');
 const table=app.doc.querySelector('.standings-table');
 assert.deepEqual([...table.querySelectorAll('thead th')].map(el=>el.textContent),['順位','クラブ','試','勝','分','敗','得','失','差','勝点','直近成績']);
 assert.deepEqual([...table.querySelector('tbody tr').children].slice(0,10).map(el=>el.textContent),['1','Home Club','3','2','1','0','5','1','4','7']);
 assert.deepEqual([...table.querySelectorAll('.form-result')].map(el=>el.textContent),['勝','勝','分']);
 assert.match(app.doc.querySelector('.data-updated').textContent,/2026-09-08/);
 await app.click('.standings-club-link');
 assert.match(app.w.location.hash,/#\/teams\/af%3Ateam%3A1/);
 assert.ok(section(app,'順位表').querySelector('.standings-row'));
 standings.groups.push({name:'Another group',table:[{rank:2,team:{name:'Unknown Club'},overall:{played:0,wins:0,draws:null,losses:0,goalsFor:0,goalsAgainst:null},goalDifference:-2,points:0,form:null}]});
 app.w.history.back();
 await until(()=>app.doc.querySelectorAll('.standings-table').length===2,'return to grouped standings');
 const unknown=app.doc.querySelectorAll('.standings-table')[1].querySelector('tbody tr');
 assert.deepEqual([...unknown.children].map(el=>el.textContent),['2','Unknown Club','0','0','未取得','0','0','未取得','-2','0','未取得']);
 assert.equal(unknown.querySelector('[data-team-id]'),null);
});
test('failed competition logo switches to a stable placeholder',async t=>{
 const catalog={competitions:[{id:'af:competition:39',name:'Premier League',logo:'https://logos.test/missing.png',seasons:[{id:'af:season:39:2026',status:'active'}]}]};
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A39?competitionSeason=af%3Aseason%3A39%3A2026',catalog});
 const image=app.doc.querySelector('.competition-hero img');image.dispatchEvent(new app.w.Event('error'));
 assert.equal(image.hidden,true);assert.ok(app.doc.querySelector('.competition-hero .competition-placeholder'));
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
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10',detail});assert.match(app.text(),/視聴価値 12.00/);assert.doesNotMatch(app.text(),/配信:|Sample service/);assert.doesNotMatch(app.text(),/未算出/);
});

test('match filter buttons return exact all, live, followed and tracked fixture IDs',async t=>{
 const rows = [
  {...fixture(),fixtureId:'af:fixture:101',teams:{home:team(11,'Live Home'),away:team(12,'Live Away')},status:{short:'1H'}},
  {...fixture(),fixtureId:'af:fixture:102',teams:{home:team(21,'Followed Home'),away:team(22,'Followed Away')}},
  {...fixture(),fixtureId:'af:fixture:103',competitionId:'af:competition:88',teams:{home:team(31,'Tracked Home'),away:team(32,'Tracked Away')}},
  {...fixture(),fixtureId:'af:fixture:104',competitionId:'af:competition:98',teams:{home:team(31,'Tracked Home'),away:team(33,'J1 Away')}},
  {...fixture(),fixtureId:'af:fixture:105',teams:{home:team(41,'Other Home'),away:team(42,'Other Away')}},
 ];
 const legacy={trackingPeriods:[{playerId:'af:player:7',teamId:'af:team:31',competitionId:'af:competition:88',tracked:true,from:'2026-08-01T00:00:00Z',to:null}]};
 const app=await boot(t,{feed:()=>({fixtures:rows}),legacy,storage:{'football-v2-follows':{teams:['af:team:21']}}});
 for(const [filter,expected] of [['all',['101','102','103','104','105']],['live',['101']],['following',['102']],['japanese',['103']],['all',['101','102','103','104','105']]]) {
  await app.click(`[data-match-filter="${filter}"]`);
  assert.deepEqual([...app.doc.querySelectorAll('[data-fixture]')].map(el=>el.dataset.fixture).sort(),expected.map(id=>`af:fixture:${id}`).sort());
  assert.equal(new URLSearchParams(app.w.location.hash.split('?')[1]).get('filter'),filter);
  assert.equal(app.doc.querySelector(`[data-match-filter="${filter}"]`).getAttribute('aria-pressed'),'true');
 }
});

test('native back between same-hash entries restores via popstate without hashchange',async t=>{
 const app=await boot(t);await tick();await tick();
 app.w.dispatchEvent(new app.w.Event('wheel'));
 app.w.scrollTo({top:420});app.w.dispatchEvent(new app.w.Event('scroll'));
 const firstKey=app.w.history.state.footballV2.key, hash=app.w.location.hash;
 await app.click('[data-page="matches"]');await tick();await tick();
 assert.equal(app.w.location.hash,hash);
 assert.notEqual(app.w.history.state.footballV2.key,firstKey);
 app.w.dispatchEvent(new app.w.Event('wheel'));
 app.w.scrollTo({top:90});app.w.dispatchEvent(new app.w.Event('scroll'));
 let hashChanges=0,pops=0;
 app.w.addEventListener('hashchange',()=>hashChanges++);
 app.w.addEventListener('popstate',()=>pops++);
 app.scrollCalls.length=0;
 app.w.history.back();
 await until(()=>app.scrollCalls.some(call=>call.top===420),'same-hash back must restore the previous entry');
 assert.equal(app.w.history.state.footballV2.key,firstKey);
 assert.equal(pops,1);assert.equal(hashChanges,0);assert.equal(app.w.scrollY,420);
});

test('legacy query startup consumes old parameters and renders the migrated route once',async t=>{
 const legacy={_dataIntegrity:{season:'2026-27'},players:[{playerId:'af:player:9',name:'Unique Player'}]};
 for(const [search,expected,title] of [
  ['?player=Unique%20Player&season=2026-27','#/players/af%3Aplayer%3A9?productSeason=jfw%3Aseason%3A2026-27','Unique Player'],
  ['?player=Unknown','#/japanese','選手一覧'],
  ['?season=2026-27','#/japanese?productSeason=jfw%3Aseason%3A2026-27','選手一覧'],
  ['?club=Unknown','#/competitions','リーグ'],
 ]) {
  const app=await boot(t,{hash:'',search,legacy});
  assert.equal(app.w.location.search,'');assert.equal(app.w.location.hash,expected);
  assert.equal(app.doc.getElementById('pageTitle').textContent,title);
  assert.equal(app.w.history.length,1);
  await app.click('[data-page="more"]');app.w.history.back();
  await until(()=>app.doc.getElementById('pageTitle').textContent===title,'back must return to the migrated screen');
  assert.equal(app.w.location.search,'');assert.equal(app.w.location.hash,expected);
 }
 const app=await boot(t,{hash:'',search:'?player=Unique%20Player&source=share',legacy});
 assert.equal(app.w.location.search,'?source=share');
 assert.equal(app.w.location.hash,'#/players/af%3Aplayer%3A9');
});

test('player recent matches distinguish fetched empty from missing and explicit unavailable data',async t=>{
 const players=[{playerId:'af:player:9',name:'Player'}];
 for(const [extra,expectedPresence] of [
  [{playerMatchStats:[]},'present'],
  [{playerMatchStats:[{playerId:'af:player:10',match:'Other player match'}]},'present'],
  [{},'not_fetched'],
  [{playerMatchStats:null},'not_fetched'],
  [{playerMatchStats:[],sectionStates:{playerMatchStats:{presence:'not_fetched'}}},'not_fetched'],
  [{playerMatchStats:[],sectionStates:{playerMatchStats:{presence:'not_applicable'}}},'not_applicable'],
 ]) {
  const app=await boot(t,{hash:'#/players/af%3Aplayer%3A9',legacy:{players,...extra}});
  const recent=section(app,'直近試合');
  if(expectedPresence==='present') {
   assert.match(recent.textContent,/該当なし/);assert.doesNotMatch(recent.textContent,/未取得/);
   assert.equal(recent.querySelector('.meta').textContent,'0');
  } else {
   assert.ok(recent.querySelector(`[data-presence="${expectedPresence}"]`));
   assert.notEqual(recent.querySelector('.meta').textContent,'0');
   assert.doesNotMatch(recent.textContent,/該当なし/);
  }
 }
 const app=await boot(t,{hash:'#/players/af%3Aplayer%3A9',legacy:{players,playerMatchStats:[{playerId:'af:player:9',match:'Correct match'},{playerId:'af:player:10',match:'Other player match'}]}});
 const recent=section(app,'直近試合');
 assert.equal(recent.querySelector('.meta').textContent,'1');assert.match(recent.textContent,/Correct match/);assert.doesNotMatch(recent.textContent,/Other player match|該当なし|未取得/);
});

test('aggregate headings resolve only known competition and exact club identities',async t=>{
 const legacy={players:[{playerId:'af:player:9',name:'Player',club:'Current Club',currentTeamId:'af:team:50',membershipHistory:[{teamId:'t1',teamName:'Former Club'}],competitionStats:{'af:competition:39':{apps:1,goals:0},'af:competition:48':{apps:2},'Premier League':{apps:3},'af:competition:999999':{apps:4}},clubStats:{'af:team:1':{apps:5},t1:{apps:6},'af:team:50':{apps:7},'af:team:999999':{apps:8}}}]};
 const app=await boot(t,{legacy});await app.click('[data-page="japanese"]');await app.click('[data-player-id="af:player:9"]');
 const competitions=section(app,'大会別成績');
 assert.deepEqual([...competitions.querySelectorAll('.history-row strong')].map(el=>el.textContent),['Premier League','カラバオカップ','Premier League','大会名は未取得']);
 assert.deepEqual([...section(app,'クラブ別成績').querySelectorAll('.history-row strong')].map(el=>el.textContent),['Home Club','Former Club','Current Club','クラブ名は未取得']);
 assert.match(competitions.textContent,/出場 1 · 得点 0/);
 assert.doesNotMatch(competitions.textContent,/af:competition:/);
});

test('cold follow rows update after loading without inventing deleted identities',async t=>{
 let release;
 const pending=new Promise(resolve=>{release=resolve;});
 const app=await boot(t,{hash:'#/following',feed:()=>pending,storage:{'football-v2-follows':{teams:['af:team:1','af:team:999']}}});
 assert.match(app.text(),/読み込み中/);assert.doesNotMatch(app.text(),/削除済み|取得できないフォロー/);
 release({fixtures:[fixture()]});
 await until(()=>app.text().includes('Home Club'),'loaded follow must resolve on the same screen');
 assert.equal(app.w.location.hash,'#/following');
 assert.match(app.text(),/参照先は未取得/);assert.doesNotMatch(app.text(),/読み込み中|削除済み|取得できないフォロー/);
 assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,['af:team:1','af:team:999']);
 await app.click('[data-follow-id="af:team:999"]');
 assert.deepEqual(JSON.parse(app.w.localStorage.getItem('football-v2-follows')).teams,['af:team:1']);
});

test('legacy aggregate display-name keys retain their explicit player and membership labels',async t=>{
 const player={playerId:'jp-1',name:'Player',club:'Current Club',league:'Legacy League',membershipHistory:[{club:'Former Club',league:'Former League'}],clubStats:{'Current Club':{apps:1},'Former Club':{apps:2}},competitionStats:{'Legacy League':{apps:3},'Former League':{apps:4}}};
 const app=await boot(t,{hash:'#/players/jp-1',legacy:{players:[player]}});
 assert.deepEqual([...section(app,'クラブ別成績').querySelectorAll('.history-row strong')].map(el=>el.textContent),['Current Club','Former Club']);
 assert.deepEqual([...section(app,'大会別成績').querySelectorAll('.history-row strong')].map(el=>el.textContent),['Legacy League','Former League']);
});

test('follow icons inherit the state color and toggle outline and fill',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10'});
 const selector='[data-follow-type="teams"][data-follow-id="af:team:1"]';
 for(const theme of ['light','dark']) {
  app.doc.documentElement.dataset.theme=theme;
  for(const following of [false,true,false]) {
   if(app.doc.querySelector(selector).classList.contains('is-following')!==following)await app.click(selector);
   const button=app.doc.querySelector(selector),icon=button.querySelector('.icon-follow');
   assert.equal(app.w.getComputedStyle(button).color,following?'var(--accent2)':'var(--muted)');
   assert.equal(app.w.getComputedStyle(icon).color,'inherit');
   assert.equal(icon.getAttribute('fill'),following?'currentColor':'none');
   assert.equal(icon.getAttribute('stroke'),'currentColor');
  }
 }
});

 test('live polling refreshes stored scores while visible, and finalized core data takes priority',async t=>{
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
  const intervals=[];let score=2,finalized=false;
  const app=await boot(t,{hash:`#/matches?date=${today}&filter=all`,intervals,
    feed:async()=>({fixtures:[{...fixture(),dateJst:today,ingestionState:finalized?'finalized':'scheduled',status:{short:finalized?'FT':'NS'}}]}),
    request:async url=>new URL(url).pathname==='/api/v2/live'?{ok:true,status:200,json:async()=>({liveUpdatesEnabled:true,stale:false,fixtures:[{
      fixtureId:'af:fixture:10',competitionId:'af:competition:39',seasonId:'af:season:39:2026',dateJst:today,kickoffUtc:new Date().toISOString(),status:{short:'1H',elapsed:10},
      home:{teamId:home.id,name:home.name,score},away:{teamId:away.id,name:away.name,score:0},
    }]})}:null,
  });
  const scores=()=>[...app.doc.querySelectorAll('[data-fixture="af:fixture:10"] .team-score')].map(el=>el.textContent.trim()).join('-');
  await until(()=>scores()==='2-0','initial live score');
  assert.equal(intervals.find(value=>value.ms===60000)!==undefined,true);
  score=3;intervals.find(value=>value.ms===60000).callback();
  await until(()=>scores()==='3-0','updated score from stored live API');
  finalized=true;intervals.find(value=>value.ms===60000).callback();
  await until(()=>scores()==='0-1','finalized core score must win');
  const before=app.calls.filter(url=>url.endsWith('/api/v2/live')).length;
  Object.defineProperty(app.doc,'visibilityState',{configurable:true,value:'hidden'});
  intervals.find(value=>value.ms===60000).callback();await tick();
  assert.equal(app.calls.filter(url=>url.endsWith('/api/v2/live')).length,before);
 });
 test('stale live acquisition is explained without hiding saved fixtures',async t=>{
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
  const app=await boot(t,{hash:`#/matches?date=${today}&filter=all`,request:async url=>new URL(url).pathname==='/api/v2/live'?{ok:true,status:200,json:async()=>({fixtures:[],liveUpdatesEnabled:true,stale:true,reason:'acquisition_stale'})}:null});
  await until(()=>app.text().includes('ライブ更新が遅れています'),'stale notice');assert.match(app.text(),/Home Club/);
 });

test('today fixture detail refreshes stored live scores and explains stale data',async t=>{
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
 const intervals=[];let score=1,stale=false;
 const detail={...bundle(),fixture:{...fixture(),dateJst:today,ingestionState:'scheduled',status:{short:'NS'}}};
 const app=await boot(t,{hash:`#/matches?date=${today}&filter=all`,intervals,detail,
  feed:async()=>({fixtures:[detail.fixture]}),
  request:async url=>new URL(url).pathname==='/api/v2/live'?{ok:true,status:200,json:async()=>({liveUpdatesEnabled:true,stale,fixtures:[{
   fixtureId:'af:fixture:10',competitionId:'af:competition:39',seasonId:'af:season:39:2026',dateJst:today,kickoffUtc:new Date().toISOString(),status:{short:'1H',elapsed:20},
   home:{teamId:home.id,name:home.name,score},away:{teamId:away.id,name:away.name,score:0},
  }]})}:null,
 });
 await until(()=>app.doc.querySelector('[data-fixture]'),'today fixture');
 await app.click('[data-fixture]');
 await until(()=>app.doc.querySelector('.score-value')?.textContent.trim()==='1 - 0','live detail score');
 score=2;stale=true;intervals.find(value=>value.ms===60000).callback();
 await until(()=>app.doc.querySelector('.score-value')?.textContent.trim()==='2 - 0','refreshed live detail');
 assert.match(app.text(),/ライブ更新が遅れています/);
});

test('pre-match detail refreshes announced lineups, preserves the active tab on failure, and stops after final publication',async t=>{
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
 const intervals=[],cacheModes=[];let phase=0;
 const current=()=>{const value=bundle();value.fixture={...value.fixture,dateJst:today,kickoffUtc:new Date(Date.now()+30*60000).toISOString(),
  status:{short:phase===3?'FT':'NS'},ingestionState:phase===3?'finalized':'scheduled'};
  if(phase===0)value.lineups=[];
  if(phase===3)value.lineups[0].startXI[0].name='Confirmed Starter';
  return value;
 };
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',intervals,feed:async()=>({fixtures:[current().fixture]}),
  request:async (url,options)=>{
   if(new URL(url).pathname==='/api/v2/fixtures/af%3Afixture%3A10'){
    cacheModes.push(options.cache);
    return phase===2?{ok:false,status:503,json:async()=>({error:'temporary'})}:{ok:true,status:200,json:async()=>current()};
   }
   return null;
  }});
 await until(()=>app.text().includes('スタメンはまだ発表されていません'),'unannounced lineup');
 phase=1;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.text().includes('Starter 1'),'announced lineup after polling');
 assert.equal(app.doc.querySelector('[role=tab][aria-selected=true]').textContent,'ラインナップ');
 assert.match(app.w.location.hash,/tab=lineup/);
 await tick();phase=2;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.text().includes('試合詳細の更新が遅れています'),'detail fetch failure');
 assert.match(app.text(),/Starter 1/);
 await tick();phase=3;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.text().includes('Confirmed Starter'),'final fixture replaces provisional detail');
 assert.doesNotMatch(app.text(),/試合詳細の更新が遅れています/);
 await tick();const calls=app.calls.filter(url=>url.includes('/api/v2/fixtures/')).length;
 intervals.find(row=>row.ms===60000).callback();await tick();
 assert.equal(app.calls.filter(url=>url.includes('/api/v2/fixtures/')).length,calls);
 assert.deepEqual(cacheModes,['no-store','no-store','no-store','no-store']);
});

test('late background fixture details cannot repaint a page that was left',async t=>{
 const intervals=[];let pending=null;
 const live={...bundle(),fixture:{...fixture(),dateJst:'2026-10-17',status:{short:'1H'},ingestionState:'live'}};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=events',intervals,detail:live,
  request:async url=>new URL(url).pathname.includes('/fixtures/')&&pending?pending:null});
 await until(()=>app.doc.querySelector('[data-detail-tab="events"]'),'initial fixture');
 let resolve;pending=new Promise(done=>{resolve=done;});
 intervals.find(row=>row.ms===60000).callback();await tick();
 await app.click('[data-page="leagues"]');
 const returned={...live,events:[{type:'goal',detail:'Late response',elapsed:40}]};
 resolve({ok:true,status:200,json:async()=>returned});await tick();await tick();
 assert.doesNotMatch(app.text(),/Late response/);
 assert.equal(app.doc.getElementById('pageTitle').textContent,'リーグ');
});

test('an older score snapshot cannot replace a newer provisional final detail',async t=>{
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
 const stamp=Date.now();
 const detail={...bundle(),fixture:{...fixture(),dateJst:today,kickoffUtc:new Date(stamp-90*60000).toISOString(),
  status:{short:'FT'},ingestionState:'provisional_final',reconciledAt:new Date(stamp).toISOString(),score:{goals:{home:3,away:0}}}};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=overview',detail,feed:async()=>({fixtures:[detail.fixture]}),
  request:async url=>new URL(url).pathname==='/api/v2/live'?{ok:true,status:200,json:async()=>({liveUpdatesEnabled:true,fixtures:[{
   fixtureId:'af:fixture:10',competitionId:'af:competition:39',seasonId:'af:season:39:2026',dateJst:today,
   kickoffUtc:detail.fixture.kickoffUtc,updatedAt:new Date(stamp-120000).toISOString(),status:{short:'1H'},
   home:{teamId:home.id,name:home.name,score:1},away:{teamId:away.id,name:away.name,score:0},
  }]})}:null});
 await until(()=>app.calls.some(url=>url.endsWith('/api/v2/live')),'older score request');await tick();
 assert.equal(app.doc.querySelector('.score-value').textContent.trim(),'3 - 0');
 assert.equal(app.doc.querySelector('.status-pill').textContent,'FT');
});

test('a cold provider profile loads directory facts and published recent matches',async t=>{
 const profile={id:'af:player:777',providerId:777,name:'New Player',nationality:'Japan',pos:'Midfielder',
  rosterObservedOn:'2026-10-18',rosterTeams:[{id:'af:team:2',name:'New Club'}]};
 const app=await boot(t,{hash:'#/players/af%3Aplayer%3A777?productSeason=jfw%3Aseason%3A2026-27',
  legacy:{_dataIntegrity:{season:'2026-27'}},request:async url=>{
   if(new URL(url).pathname==='/api/v2/players/af%3Aplayer%3A777')return {ok:true,status:200,json:async()=>({player:profile,
    rosterHistory:[{id:'af:team:2',name:'New Club',firstSeen:'2026-10-18',lastSeen:'2026-10-18',current:true}],
    recentMatches:[{fixtureId:'af:fixture:10',dateJst:'2026-10-17',homeName:'Home Club',awayName:'Away Club',teamName:'New Club',minutes:30,goals:0,assists:null}]})};
   return null;
  }});
 await until(()=>app.text().includes('New Club')&&section(app,'直近試合').textContent.includes('2026-10-17'),'cold provider profile');
 assert.match(app.text(),/Midfielder/);
 assert.match(section(app,'直近試合').textContent,/出場 30分 · 得点 0/);
 assert.ok(section(app,'直近試合').querySelector('[data-fixture="af:fixture:10"]'));
 const matchRow=section(app,'直近試合').querySelector('[data-fixture="af:fixture:10"]');
 assert.equal(app.w.getComputedStyle(matchRow).gridTemplateColumns,'minmax(0,1fr) auto');
 assert.equal(app.calls.filter(url=>url.includes('/api/v2/players/af%3Aplayer%3A777')).length,1);
 await app.click('[data-fixture="af:fixture:10"]');
 assert.match(app.w.location.hash,/fixtures\/af%3Afixture%3A10/);
 assert.ok(app.calls.some(url=>url.includes('/api/v2/fixtures/af%3Afixture%3A10')));
});

test('an empty nationality result does not reinsert the old fixed tracking list',async t=>{
 const app=await boot(t,{hash:'#/japanese',legacy:{players:[{playerId:'jp-old',name:'Former Player',nationality:'Japan'}]},
  request:async url=>new URL(url).pathname==='/api/v2/players'?{ok:true,status:200,json:async()=>({players:[],nextCursor:null})}:null});
 await until(()=>app.doc.getElementById('japaneseList')&&!app.doc.querySelector('[data-player-id="jp-old"]'),'empty completed nationality directory');
 assert.doesNotMatch(app.doc.getElementById('japaneseList').textContent,/Former Player/);
});

test('event icons distinguish cards, goals, substitutions and VAR with readable labels and added time',async t=>{
 const detail=bundle();
 const definitions=[
  ['goal','Normal Goal','goal','ゴール'],['goal','Own Goal','own-goal','オウンゴール'],
  ['goal','Penalty','goal','PKゴール'],['goal','Missed Penalty','missed','PK失敗'],
  ['goal','Goal cancelled','cancelled','ゴール取り消し'],
  ['card','Yellow Card','yellow','イエローカード'],['card','Red Card','red','レッドカード'],
  ['card','Second Yellow card','second-yellow','2枚目の警告・退場'],
  ['substitution','Substitution 1','substitution','選手交代'],
  ['var','Goal cancelled','var','VAR・判定取り消し'],
  ['other','<img src=x onerror=alert(1)>','other','other'],
 ];
 detail.events=definitions.map(([type,description],i)=>({type,detail:description,elapsed:90,extra:4,teamId:home.id,playerId:'af:player:1',relatedPlayerId:i===8?'af:player:3':null}));
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=events',detail});
 const rows=[...app.doc.querySelectorAll('.event-list .event-row')];
 assert.equal(rows.length,definitions.length);
 for(const [i,row] of rows.entries()){
  assert.equal(row.dataset.eventKind,definitions[i][2]);
  assert.equal(row.querySelector('.event-copy strong').textContent,definitions[i][3]);
  assert.equal(row.querySelector('svg').getAttribute('aria-hidden'),'true');
  assert.equal(row.querySelector('.event-minute').textContent,'90+4′');
  assert.match(row.textContent,/Home Club/);
 }
 assert.match(rows[8].textContent,/OUT Starter 1/);assert.match(rows[8].textContent,/IN Bench 1/);
 assert.equal(rows[10].querySelector('img'),null,'provider text is escaped');
});

test('a single acquired lineup remains selectable without inventing the missing team lineup',async t=>{
 const detail=bundle();detail.lineups=[detail.lineups[1]];
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.equal(app.doc.querySelectorAll('[data-lineup-team]').length,1);
 assert.equal(app.doc.querySelector('[data-lineup-team]').dataset.lineupTeam,away.id);
 assert.match(app.doc.querySelector('.lineup-card').textContent,/Starter 2/);
 assert.doesNotMatch(app.doc.querySelector('.lineup-card').textContent,/Starter 1/);
});

test('individual match stats preserve zero, missing and nonapplicable values in provider and JFW modes',async t=>{
 const detail=bundle();Object.assign(detail.playerStats[0],{
  values:{rating:7,minutes:90,goals:0,passes:31,passesAccurate:25,keyPasses:2,duels:8,duelsWon:5},
  fieldStates:{assists:{presence:'not_fetched'},penaltiesWon:{presence:'not_applicable'}}
 });
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings',detail});
 const select='[data-player-stats="af:player:1"]';
 const requests=app.calls.length;
 await app.click(select);
 let panel=app.doc.getElementById(app.doc.querySelector(select).getAttribute('aria-controls'));
 assert.ok(visible(panel,app.w));
 assert.equal(panel.querySelector('[data-player-stat=goals] dd').textContent,'0');
 assert.equal(panel.querySelector('[data-player-stat=minutes] dd').textContent,'90分');
 assert.equal(panel.querySelector('[data-player-stat=assists] [data-presence]').dataset.presence,'not_fetched');
 assert.equal(panel.querySelector('[data-player-stat=penaltiesWon] [data-presence]').textContent,'非該当');
 assert.equal(panel.querySelector('[data-player-stat=passes] dd').textContent,'31');
 assert.equal(panel.querySelector('[data-player-stat=passesAccurate] dd').textContent,'25');
 assert.equal(app.calls.length,requests,'stat panels reuse the acquired fixture');
 await app.click('[data-rating-mode=jfw]');
 assert.equal(app.doc.querySelector(select).getAttribute('aria-expanded'),'true');
 assert.match(app.doc.querySelector('.player-match-stats:not([hidden])').textContent,/パス/);
 await app.click(select);assert.equal(app.doc.querySelector(select).getAttribute('aria-expanded'),'false');
});

test('goalkeeper stats show acquired saves and penalty saves',async t=>{
 const detail=bundle();detail.fixture.ingestionState='finalized';
 Object.assign(detail.playerStats[0],{position:'G',values:{minutes:90,saves:4,goalsConceded:1,penaltiesSaved:0}});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings',detail});
 await app.click('[data-player-stats="af:player:1"]');
 const panel=app.doc.querySelector('.player-match-stats:not([hidden])');
 assert.equal(panel.querySelector('[data-player-stat=saves] dd').textContent,'4');
 assert.equal(panel.querySelector('[data-player-stat=penaltiesSaved] dd').textContent,'0');
 assert.match(panel.textContent,/試合後の確定データ/);
});

test('live team selection and expanded player stats survive refresh and adopt final stats',async t=>{
 const intervals=[];let phase=0;
 const current=()=>{
  const result=bundle();
  result.fixture={...fixture(),dateJst:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date()),
   kickoffUtc:new Date().toISOString(),status:{short:phase===2?'FT':'2H'},ingestionState:phase===2?'finalized':'live'};
  result.playerStats[1].values={minutes:phase===2?90:60+phase,goals:phase,passes:20+phase};
  return result;
 };
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',intervals,
  feed:async()=>({fixtures:[current().fixture]}),
  request:async url=>new URL(url).pathname.includes('/fixtures/')?{ok:true,status:200,json:async()=>current()}:null});
 await app.click('[data-lineup-team="af:team:2"]');
 phase=1;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.doc.querySelector('.lineup-person')?.textContent.includes('61'),'lineup refresh');
 assert.equal(app.doc.querySelector('[data-lineup-team][aria-pressed=true]').dataset.lineupTeam,away.id);
 await app.click('[data-detail-tab=ratings]');
 await app.click('[data-player-stats="af:player:2"]');
 assert.match(app.doc.querySelector('.player-match-stats:not([hidden])').textContent,/速報・自動更新/);
 await tick();phase=2;intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.doc.querySelector('.player-match-stats:not([hidden])')?.textContent.includes('試合後の確定データ'),'final individual stats');
 const panel=app.doc.querySelector('.player-match-stats:not([hidden])');
 assert.equal(panel.querySelector('[data-player-stat=goals] dd').textContent,'2');
 assert.equal(panel.querySelector('[data-player-stat=minutes] dd').textContent,'90分');
 assert.equal(app.doc.querySelector('[data-player-stats="af:player:2"]').getAttribute('aria-expanded'),'true');
 await tick();const calls=app.calls.filter(url=>url.includes('/fixtures/')).length;
 intervals.find(row=>row.ms===60000).callback();await tick();
 assert.equal(app.calls.filter(url=>url.includes('/fixtures/')).length,calls);
});

test('a completed provisional match explains final publication waiting without a live-age warning',async t=>{
 const detail=bundle();detail.fixture.ingestionState='provisional_final';
 detail.fixture.provenance={issues:['live_provisional','live_detail_stale']};
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.match(app.text(),/試合終了時の速報データ/);
 assert.match(app.text(),/試合後の確定データの反映を待っています/);
 assert.doesNotMatch(app.text(),/試合詳細の更新が遅れています/);
 assert.doesNotMatch(app.text(),/試合前・試合中/);
 assert.match(app.text(),/Starter 1/);
});

test('final waiting still reports retained sections and live matches still report stale updates',async t=>{
 const detail=bundle();detail.fixture.ingestionState='provisional_final';
 detail.fixture.provenance={issues:['live_provisional','live_detail_stale','live_retained_events']};
 const final=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.match(final.text(),/試合詳細の更新が遅れています/);
 assert.match(final.text(),/試合後の確定データの反映を待っています/);
 detail.fixture.status={short:'2H'};detail.fixture.ingestionState='live';
 detail.fixture.provenance.issues=['live_provisional','live_detail_stale'];
 const live=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',detail});
 assert.match(live.text(),/試合詳細の更新が遅れています/);
 assert.match(live.text(),/試合前・試合中/);
 assert.doesNotMatch(live.text(),/確定データの反映を待っています/);
});


test('UEFA and domestic cups have separate searchable entries and acquired rounds without fabricating knockout tables',async t=>{
 const league={id:'af:competition:39',name:'Premier League',seasons:[{id:'af:season:39:2026',status:'active'}]};
 const cl={id:'af:competition:2',name:'UEFA Champions League',country:'World',seasons:[{id:'af:season:2:2026',status:'active'}]};
 const cup={id:'af:competition:48',name:'League Cup',country:'England',seasons:[{id:'af:season:48:2026',status:'active'}]};
 const match={...fixture(),competitionId:cup.id,seasonId:cup.seasons[0].id,round:'Quarter-finals'};
 const app=await boot(t,{hash:'#/competitions',catalog:{competitions:[league,cl,cup]},
  seasonDetail:{competition:cup,season:cup.seasons[0],fixtures:[match],cupSnapshot:{generatedAt:'2026-10-21T04:00:00.000Z',automaticUpdates:false,standingsAvailable:false}},feed:async()=>({fixtures:[]})});
 assert.ok(section(app,'欧州カップ').querySelector('[data-competition-id="af:competition:2"]'));
 assert.ok(section(app,'国内カップ').querySelector('[data-competition-id="af:competition:48"]'));
 const input=app.doc.getElementById('leagueSearch');input.value='カラバオ';input.dispatchEvent(new app.w.Event('input'));
 assert.equal(app.doc.querySelectorAll('[data-competition-id]').length,1);
 await app.click('[data-competition-id="af:competition:48"]');
 await until(()=>app.text().includes('Quarter-finals'),'cup season rounds');
 assert.match(app.text(),/日程・結果の取得分/);assert.match(app.text(),/Home Club/);
 await app.click('[data-cup-filter="upcoming"]');assert.equal(app.doc.querySelector('[data-fixture]'),null);
 await app.click('[data-cup-filter="final"]');assert.ok(app.doc.querySelector('[data-fixture]'));
 await app.click('[data-competition-tab="standings"]');assert.match(app.text(),/順位表はAPIで提供されていません/);
 assert.ok(!app.calls.some(url=>url.includes('competition%3A48')&&url.endsWith('/standings')));
});

test('a cup competition polls stored live scores every minute and keeps the selected round filter',async t=>{
 const intervals=[];let phase=0;
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
 const cup={id:'af:competition:2',name:'UEFA Champions League',seasons:[{id:'af:season:2:2026',status:'active'}]};
 const match={...fixture(),dateJst:today,kickoffUtc:new Date().toISOString(),competitionId:cup.id,seasonId:cup.seasons[0].id,round:'League stage',status:{short:'NS'},ingestionState:'scheduled'};
 const app=await boot(t,{hash:'#/competitions/af%3Acompetition%3A2?season=af%3Aseason%3A2%3A2026',intervals,catalog:{competitions:[cup]},
  seasonDetail:{competition:cup,season:cup.seasons[0],fixtures:[match],cupSnapshot:{generatedAt:new Date().toISOString(),automaticUpdates:true,standingsAvailable:true}},
  feed:async()=>({fixtures:[match]}),request:async url=>new URL(url).pathname==='/api/v2/live'?{ok:true,status:200,json:async()=>({liveUpdatesEnabled:true,fixtures:phase?[{fixtureId:match.fixtureId,competitionId:cup.id,seasonId:match.seasonId,dateJst:today,kickoffUtc:match.kickoffUtc,status:{short:'1H',elapsed:12},home:{teamId:home.id,name:home.name,score:3},away:{teamId:away.id,name:away.name,score:0},updatedAt:new Date().toISOString()}]:[]})}:null});
 await until(()=>app.text().includes('League stage'),'cup rounds');
 await app.click('[data-cup-filter="upcoming"]');
 phase=1;const before=app.calls.filter(url=>url.endsWith('/api/v2/live')).length;
 intervals.find(row=>row.ms===60000).callback();
 await until(()=>app.doc.querySelector('.status-pill.is-live'),'cup live score');
 assert.ok(app.calls.filter(url=>url.endsWith('/api/v2/live')).length>before);
 assert.equal(app.doc.querySelector('[data-cup-filter="upcoming"]').getAttribute('aria-pressed'),'true');
 assert.match(app.text(),/3/);
});

test('outfield zero saves never creates a goalkeeper panel and acquired offsides stay numeric',async t=>{
 const detail=bundle();detail.playerStats[0].values={minutes:90,saves:0,offsides:0};
 detail.playerStats[0].fieldStates={goals:{presence:'provider_missing'}};
 detail.events=[{type:'goal',detail:'Normal Goal',teamId:home.id,playerId:'af:player:1',elapsed:45}];
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings',detail});
 await app.click('[data-player-stats="af:player:1"]');
 assert.equal(app.doc.querySelector('[data-player-stat="offsides"] dd').textContent,'0');
 assert.equal(app.doc.querySelector('[data-player-stat="saves"]'),null);
 assert.match(app.doc.querySelector('[data-player-stat-evidence="goals"]').textContent,/1ゴール/);
 assert.equal(app.doc.querySelector('[data-player-stat="goals"] [data-presence]').title,'ゴール：提供元にデータなし');
});

test('explicit goalkeeper aliases show the goalkeeper panel even when saves are missing',async t=>{
 for(const position of ['G','GK','GOALKEEPER']){
  const detail=bundle();detail.playerStats[0].position=position;
  const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings',detail});
  await app.click('[data-player-stats="af:player:1"]');
  assert.ok(app.doc.querySelector('[data-player-stat="saves"]'));
 }
});

test('match nationality uses paginated team profiles by canonical ID and late metadata preserves the active view',async t=>{
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=lineup',request:async url=>{
  const u=new URL(url);if(u.pathname!=='/api/v2/players')return null;
  const homeTeam=u.searchParams.get('team')===home.id,second=u.searchParams.get('after')==='1';
  const body={players:homeTeam?[{id:second?'af:player:3':'af:player:1',providerId:second?3:1,name:second?'Bench 1':'Starter 1',nationality:second?'France':'Japan'}]:[],nextCursor:homeTeam&&!second?1:null};
  return {ok:true,status:200,json:async()=>body};
 }});
 await until(()=>app.doc.querySelector('.lineup-list')?.textContent.includes('Japan'),'roster nationality');
 assert.match(app.doc.querySelector('.lineup-card').textContent,/France/);
 await app.click('[data-detail-tab="ratings"]');
 assert.match(app.doc.querySelector('[data-rating-player="af:player:1"]').textContent,/Japan/);
 const directoryCalls=app.calls.filter(url=>url.includes('/api/v2/players?')&&new URL(url).searchParams.has('team'));
 assert.equal(directoryCalls.length,3);
 assert.equal(app.calls.filter(url=>/\/api\/v2\/players\/af/.test(url)).length,0);
 await app.click('[data-detail-tab="lineup"]');assert.match(app.doc.querySelector('.lineup-list').textContent,/Japan/);
});

test('fresh JFW mode explains the missing required inputs without inventing a rating',async t=>{
 const detail=bundle();for(const row of detail.playerStats)delete row.jfwRating;
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw',detail});
 assert.match(app.text(),/独自評価は未算出/);assert.match(app.text(),/オウンゴール・退場区分/);
 assert.equal(app.doc.querySelectorAll('.rating-row b [data-presence="provider_missing"]').length,2);
 assert.deepEqual([...app.doc.querySelectorAll('.rating-row b')].map(el=>el.textContent),['未算出','未算出']);
});

test('French, Japanese and unknown-nationality players receive the same JFW score without tracking metadata',async t=>{
 const detail=bundle();detail.fixture.score.goals={home:0,away:0};
 detail.playerStats.push({playerId:'af:player:3',teamId:home.id,playerName:'Unknown Nationality',position:'F',values:{rating:9}});
 detail.playerStats[0].nationality='France';detail.playerStats[1].nationality='Japan';
 for(const row of detail.playerStats)Object.assign(row.values,{minutes:90,goals:0,assists:0,yellowCards:0,redCards:0,penaltiesConceded:0});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw',legacy:{trackingPeriods:[]},detail});
 const ratings=()=>[...app.doc.querySelectorAll('.rating-row b')].map(el=>el.textContent);
 assert.deepEqual(ratings(),['6.0','6.0','6.0']);
 for(const id of ['af:player:1','af:player:2','af:player:3']){
  await app.click(`[data-rating-player="${id}"]`);assert.match(app.doc.querySelector('.rating-breakdown').textContent,/JFW 評価6\.0/);
 }
 await app.click('[data-rating-mode="provider"]');assert.deepEqual(ratings(),['7','9','8']);
});

test('saved match statistics produce a JFW rating and Japanese factor breakdown without extra fixture fetches',async t=>{
 const detail=bundle();detail.fixture.score.goals={home:0,away:0};detail.fixture.ingestionState='finalized';
 const row=detail.playerStats[0];row.playerId='af:player:106835';delete row.jfwRating;
 Object.assign(row.values,{minutes:90,goals:0,assists:0,yellowCards:0,redCards:0,penaltiesConceded:0,shots:3});
 detail.lineups[0].startXI[0].id=row.playerId;
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw',detail});
 const rating=app.doc.querySelector('[data-rating-player="af:player:106835"]');
 assert.match(rating.textContent,/6\.1/);assert.equal(rating.disabled,false);
 const requests=app.calls.filter(url=>url.includes('/fixtures/')).length;
 await app.click('[data-rating-player="af:player:106835"]');
 const breakdown=app.doc.querySelector('.rating-breakdown').textContent;
 assert.match(breakdown,/基本|6\.00/);assert.match(breakdown,/シュート \(3\).*\+0\.12/);
 assert.match(breakdown,/データ充足率/);assert.match(breakdown,/未取得.*決定機逸/);
 assert.equal(app.calls.filter(url=>url.includes('/fixtures/')).length,requests);
 assert.equal(app.doc.querySelector('script[data-jfw-backfill]'),null);
});

test('eligible unrated player opens the exact missing input reason',async t=>{
 const detail=bundle();detail.fixture.score.goals={home:0,away:0};
 const row=detail.playerStats[0];row.nationality='Japan';delete row.jfwRating;
 Object.assign(row.values,{minutes:90,goals:0,assists:0,yellowCards:0,redCards:0});
 const app=await boot(t,{hash:'#/fixtures/af%3Afixture%3A10?tab=ratings&ratingMode=jfw',detail});
 await app.click('[data-rating-player="af:player:1"]');
 assert.match(app.doc.querySelector('.rating-breakdown').textContent,/不足する必須項目: PK献上/);
 assert.ok(app.doc.querySelector('[data-rating-player="af:player:1"] [data-presence="provider_missing"]'));
});
