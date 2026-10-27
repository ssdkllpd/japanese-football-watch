'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {calculate} = require('../jfw-fixture-rating.js');

function sample(position = 'F') {
  const row = {playerId:'af:player:1',teamId:'af:team:1',position,values:{minutes:90,goals:0,assists:0,yellowCards:0,redCards:0,penaltiesConceded:0}};
  const bundle = {fixture:{id:'af:fixture:10',status:{short:'FT'},ingestionState:'finalized',
    teams:{home:{id:row.teamId},away:{id:'af:team:2'}},score:{goals:{home:0,away:0}}},
    sectionStates:{events:{presence:'present'}},events:[],lineups:[{teamId:row.teamId,startXI:[{id:row.playerId,position}]}]};
  return {row,bundle};
}
function goal(teamId,playerId,elapsed,detail='Normal Goal',relatedPlayerId=null) {
  return {type:'goal',teamId,playerId,elapsed,detail,relatedPlayerId};
}
test('v1 reference FW case is computed from raw statistics, independently of provider rating',()=>{
  const {row,bundle}=sample();
  Object.assign(row.values,{goals:1,assists:1,shots:3,shotsOnTarget:2,rating:2});
  bundle.fixture.score.goals.home=2;
  bundle.events=[goal(row.teamId,row.playerId,10),goal(row.teamId,'af:player:2',20,'Normal Goal',row.playerId)];
  const before=JSON.stringify({row,bundle});
  const result=calculate(row,bundle);
  assert.equal(result.value,7.93);assert.equal(result.ratingCoverage,0.661);assert.equal(result.ratingConfidence,'medium');
  assert.equal(result.ratingInputs.ownGoals.value,0);assert.equal(result.ratingVersion,'1.0');
  assert.equal(JSON.stringify({row,bundle}),before);
});
test('zero goals and assists can be derived only from complete final goal evidence',()=>{
  const {row,bundle}=sample();delete row.values.goals;delete row.values.assists;
  assert.equal(calculate(row,bundle).value,6);
  bundle.fixture.score.goals.away=1;
  const result=calculate(row,bundle);
  assert.equal(result.value,null);assert.equal(result.ratingInputs.goals.state,'missing');
  assert.equal(result.ratingInputs.ownGoals.state,'missing');
});
test('missing PK concessions, red cards and non-covered performance fields remain missing',()=>{
  const {row,bundle}=sample();delete row.values.penaltiesConceded;
  let result=calculate(row,bundle);
  assert.equal(result.reason,'discipline_inputs_missing');assert.ok(result.missingRequired.includes('penaltiesConceded'));
  row.values.penaltiesConceded=0;delete row.values.redCards;
  result=calculate(row,bundle);assert.equal(result.value,null);assert.equal(result.ratingInputs.straightRed.state,'missing');
  assert.equal(result.ratingInputs.bigChancesMissed.state,'missing');
});
test('provider missing state overrides a numeric value, including zero',()=>{
  const {row,bundle}=sample();row.fieldStates={penaltiesConceded:{presence:'provider_missing'}};
  assert.equal(calculate(row,bundle).value,null);
});
test('goals disagreeing with complete event evidence are not scored',()=>{
  const {row,bundle}=sample();row.values.goals=1;
  const result=calculate(row,bundle);assert.equal(result.value,null);assert.equal(result.ratingInputs.goals.state,'missing');
});
test('own goals are separate from goals and discipline is never scaled by minutes',()=>{
  const {row,bundle}=sample();row.values.minutes=10;
  bundle.fixture.score.goals.away=1;bundle.events=[goal('af:team:2',row.playerId,88,'Own Goal')];
  const result=calculate(row,bundle);assert.equal(result.value,5.2);assert.equal(result.deltaDiscipline,-0.8);
  assert.equal(result.ratingInputs.goals.value,0);assert.equal(result.ratingInputs.ownGoals.value,1);
});
test('second-yellow dismissal is distinguished from a straight red without assuming omitted events',()=>{
  const {row,bundle}=sample();row.values.redCards=1;row.values.yellowCards=1;
  assert.equal(calculate(row,bundle).value,null);
  bundle.events=[{type:'card',teamId:row.teamId,playerId:row.playerId,elapsed:80,detail:'Second Yellow card'}];
  const result=calculate(row,bundle);assert.equal(result.ratingInputs.yellowCards.value,2);
  assert.equal(result.ratingInputs.straightRed.value,0);assert.equal(result.deltaDiscipline,-1.1);
});
test('a red-card event conflicting with a reported zero blocks the rating',()=>{
  const {row,bundle}=sample();bundle.events=[{type:'card',teamId:row.teamId,playerId:row.playerId,elapsed:80,detail:'Red Card'}];
  assert.equal(calculate(row,bundle).value,null);
});
test('observed yellow cards cannot be hidden by a conflicting provider zero',()=>{
  const {row,bundle}=sample();bundle.events=[{type:'card',teamId:row.teamId,playerId:row.playerId,elapsed:80,detail:'Yellow Card'}];
  assert.equal(calculate(row,bundle).value,null);
});
test('DF conceded goals use the documented on-pitch interval, including same-minute ambiguity',()=>{
  const {row,bundle}=sample('D');row.values.minutes=64;
  bundle.fixture.score.goals.away=2;
  bundle.events=[goal('af:team:2','af:player:5',64),goal('af:team:2','af:player:5',80),
    {type:'substitution',teamId:row.teamId,playerId:row.playerId,relatedPlayerId:'af:player:3',elapsed:64}];
  const result=calculate(row,bundle);assert.equal(result.ratingInputs.gaOnPitch.value,1);assert.equal(result.gaOnPitchAmbiguous,true);
  bundle.events.pop();assert.equal(calculate(row,bundle).ratingInputs.gaOnPitch.state,'missing');
});
test('GK does not invent shots on target faced from total goals including own goals',()=>{
  const {row,bundle}=sample('G');row.values.saves=4;
  const result=calculate(row,bundle);assert.equal(result.ratingInputs.gaOnPitch.value,0);
  assert.equal(result.ratingInputs.shotsOnTargetFaced.state,'missing');
});
test('known stoppage-time ordering excludes goals after a substitution',()=>{
  const {row,bundle}=sample('D');bundle.fixture.score.goals.away=1;
  bundle.events=[{...goal('af:team:2','af:player:5',90),extra:5},
    {type:'substitution',teamId:row.teamId,playerId:row.playerId,relatedPlayerId:'af:player:3',elapsed:90,extra:3}];
  assert.equal(calculate(row,bundle).ratingInputs.gaOnPitch.value,0);
});
test('rate denominators and position priority follow v1 without importing the provider rating',()=>{
  const {row,bundle}=sample('M');row.position='F';
  Object.assign(row.values,{passes:29,passesAccurate:25,duels:4,duelsWon:2});
  const result=calculate(row,bundle);assert.equal(result.ratingPosition,'MF');
  assert.ok(!result.ratingBreakdown.some(item=>['passCompletionRate','duelWinRate'].includes(item.key)));
});
test('live, shootout-ambiguous, absent events and unknown position never fabricate final scores',()=>{
  const {row,bundle}=sample();bundle.fixture.status.short='2H';
  let result=calculate(row,bundle);assert.equal(result.value,null);assert.equal(result.jfwRating,null);assert.equal(result.reason,'match_not_final');
  bundle.fixture.status.short='PEN';assert.equal(calculate(row,bundle).value,null);
  bundle.fixture.status.short='FT';bundle.sectionStates.events.presence='not_fetched';assert.equal(calculate(row,bundle).value,null);
  bundle.sectionStates.events.presence='present';bundle.lineups=[];row.position=null;
  assert.equal(calculate(row,bundle).reason,'unknown_position');
});
