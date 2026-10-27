'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const data=require('../app-v2-data.js');
const scope=require('../config/competition-scope-v1.json');
const {buildConfig}=require('../scripts/v2/build-ui-config.js');
const vm=require('node:vm');
test('Japanese club membership uses canonical IDs and current roster teams, without inferring nationality or old clubs',()=>{
 const current={id:'af:team:91',name:'Monaco'},other={id:'af:team:92',name:'Monaco'};
 const japanese={id:'af:player:7',name:'Japanese Player',nationality:'Japan',rosterTeams:[current,current],rosterHistory:[other]};
 const result=data.japaneseClubMemberships([japanese,japanese,
  {...japanese,id:'af:player:8',rosterTeams:[current,other]},
  {...japanese,id:'af:player:9',nationality:null,name:'日本語の名前'},
  {...japanese,id:'af:player:10',nationality:'France'},
  {...japanese,id:'legacy:player:7'},
 ]);
 assert.deepEqual([...result.keys()],['af:team:91','af:team:92']);
 assert.deepEqual(result.get(current.id).players.map(player=>player.id),['af:player:7','af:player:8']);
 assert.deepEqual(result.get(other.id).players.map(player=>player.id),['af:player:8']);
 assert.equal(data.japaneseClubMemberships([{...japanese,rosterTeams:[]}]).size,0);
});
test('search accepts width, kana, Latin accents and separators while retaining Japanese voicing',()=>{
 for(const [query,fields] of [
  ['ＭＡＲＩＯ　ＧＯＴＺＥ',['Mario Götze']],
  ['三笘 薫',['三笘薫']],
  ['ｶﾗﾊﾞｵ',['カラバオカップ']],
  ['からばお',['カラバオカップ']],
  ['キリアンエムバペ',['キリアン・エムバペ']],
  ['Jean Pierre',['Jean-Pierre']],
  ['mitoma brighton',['K. Mitoma','Brighton']],
  ['Götze Mario',['Mario Götze']],
 ]) assert.equal(data.matchesSearch(query,fields),true,query);
 assert.equal(data.matchesSearch('は',['バ']),false);
 assert.equal(data.matchesSearch('ガ',['カ']),false);
 assert.equal(data.matchesSearch('missing',[null,undefined]),false);
 assert.equal(data.matchesSearch('null',[null]),false);
 assert.equal(data.matchesSearch('club absent',['Club']),false);
 assert.equal(data.matchesSearch('homeaway',['Home','Away']),false);
 assert.equal(data.matchesSearch('・',['Anything']),false);
 assert.equal(data.matchesSearch('　 ',['Anything']),true);
});
test('tracking uses canonical team IDs and the fixture date inside an explicit tracked period',()=>{
 const f={competitionId:'af:competition:39',kickoffUtc:'2026-09-01T12:00:00Z',teams:{home:{id:'af:team:1',name:'English Name'},away:{id:'af:team:2'}}};
 const periods=[{playerId:'af:player:1',teamId:'af:team:1',competitionId:'af:competition:39',from:'2026-08-01T00:00:00Z',to:'2026-09-02T00:00:00Z',tracked:true}];
 assert.equal(data.trackedFixture(f,periods,scope),true);
 assert.equal(data.trackedFixture({...f,kickoffUtc:'2026-09-02T00:00:00Z'},periods,scope),false);
 assert.equal(data.trackedFixture({...f,competitionId:'af:competition:98'},periods,scope),false);
 assert.equal(data.trackedFixture(f,undefined,scope),null);
 assert.equal(data.trackedFixture(f,[{...periods[0],teamId:'af:team:3',club:'English Name'}],scope),false);
});
const c=(id,score='16.00',base='30.00')=>({fixtureId:id,displayedScore:score,baseScore:base,kickoffUtc:'2026-09-01T12:00:00Z',involvedPlayerIds:['af:player:1'],homeTeamId:'af:team:1',awayTeamId:'af:team:2'});
test('attention uses exact HALF_UP cents and IDs; threshold, base, kickoff and ID ties are stable',()=>{
 const follows={players:['af:player:1'],teams:['af:team:1']};
 const ranked=data.rankCandidates([c('b'),c('a'),c('z','15.99'),c('half','16.02')],follows);
 assert.deepEqual(ranked.map(x=>[x.fixtureId,x.personalScore]),[['half','20.03'],['a','20.00'],['b','20.00']]);
 assert.equal(data.rankCandidates([c('a')],{players:['name'],teams:[]}).length,0);
 const ties=data.rankCandidates([c('b','20.00','25.00'),c('a','20.00','26.00'),{...c('c','20.00','26.00'),kickoffUtc:'2026-09-02T00:00:00Z'}],{players:[],teams:[]});
 assert.deepEqual(ties.map(x=>x.fixtureId),['c','a','b']);
});
const page=(candidates,nextCursor=null,rev='one')=>({candidates,nextCursor,asOfUtc:'2026-09-07T00:00:00Z',candidateRevision:rev,attentionVersion:'1.0',scopeVersion:'1.0'});
test('attention waits for every page and discards the whole expired generation before retry',async()=>{
 let calls=0,release;
 const result=data.loadAttention(async(season,cursor)=>{calls++;assert.equal(season,'jfw:season:2026-27');
 if(calls===1)return page([c('old')],'next');
 if(calls===2)throw Object.assign(new Error('expired'),{status:409,code:'attention_cursor_expired'});
 if(calls===3){assert.equal(cursor,null);return page([c('new1')],'next','two');}
 return new Promise(resolve=>release=()=>resolve(page([c('new2')],null,'two')));
 },'jfw:season:2026-27');
 await new Promise(r=>setImmediate(r));let done=false;result.then(()=>done=true);assert.equal(done,false);release();
 assert.deepEqual((await result).candidates.map(x=>x.fixtureId),['new1','new2']);
});
test('attention never combines incompatible times or loops a cursor',async()=>{
 let calls=0;
 await assert.rejects(data.loadAttention(async()=>{calls++;return calls%2 ? page([c('first')],'next') : {...page([c('second')]),asOfUtc:'2026-09-08T00:00:00Z'};},'season'),/attention_cursor_expired/);
 await assert.rejects(data.loadAttention(async()=>page([c('same')],'next'),'season'),/invalid_attention_snapshot/);
});
test('build injects a fixed public origin and leaves tracking and attention gates off',()=>{
 const context={window:{}};vm.runInNewContext(buildConfig('https://public-api.test'),context);
 assert.equal(context.window.FOOTBALL_V2_CONFIG.apiBase,'https://public-api.test');
 assert.equal(context.window.FOOTBALL_V2_CONFIG.attentionEnabled,false);
 assert.equal(context.window.FOOTBALL_V2_CONFIG.trackingEnabled,false);
 assert.throws(()=>buildConfig('https://user:secret@public-api.test'));
 assert.throws(()=>buildConfig('https://public-api.test/api'));
});

test('confirmed goals reveal absent or understated stats without treating incomplete events as zero',()=>{
 const row={playerId:'af:player:1',teamId:'af:team:1',values:{}};
 const b={fixture:{status:{short:'FT'}},sectionStates:{events:{presence:'present'}},events:[{type:'goal',detail:'Normal Goal',elapsed:45,playerId:row.playerId,teamId:row.teamId}]};
 assert.deepEqual(data.goalStatEvidence(row,b),{count:1,value:null});
 assert.deepEqual(data.goalStatEvidence({...row,values:{goals:0}},b),{count:1,value:0});
 for(const goals of [1,2])assert.equal(data.goalStatEvidence({...row,values:{goals}},b),null);
 for(const detail of ['Own Goal','Missed Penalty','Goal cancelled'])assert.equal(data.goalStatEvidence(row,{...b,events:[{...b.events[0],detail}]}),null);
 assert.equal(data.goalStatEvidence(row,{...b,events:[]}),null);
 assert.equal(data.goalStatEvidence(row,{...b,sectionStates:{events:{presence:'not_fetched'}}}),null);
 assert.equal(data.goalStatEvidence(row,{...b,fixture:{status:{short:'PEN'}},events:[{...b.events[0],detail:'Penalty'}]}),null);
 assert.equal(data.goalStatEvidence(row,{...b,events:[{...b.events[0],teamId:'af:team:2'}]}),null);
 assert.equal(data.goalStatEvidence(row,{...b,events:[...b.events,{type:'var',detail:'Goal cancelled'}]}),null);
});
