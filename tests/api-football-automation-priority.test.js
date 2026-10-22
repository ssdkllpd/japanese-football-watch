'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  planAutomation, advanceAutomationState, discoveryDates, emptyAutomationState, validatePolicy,
} = require('../scripts/v2/api-football-automation-plan');
const policy = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config/api-football-automation.json'), 'utf8'));
function retained(id, kickoffUtc, completedStages = [], lastDetailFetchedAt = null) {
  return {providerFixtureId:id, fixtureId:`af:fixture:${id}`, competitionId:'af:competition:39',
    seasonId:'af:season:39:2026', league:39, season:2026, kickoffUtc, lastStatus:'FT', completedStages, lastDetailFetchedAt};
}
function args(rows, now = '2026-10-20T00:00:00Z') {
  const value = {policy:policy(), now, preview:false, state:emptyAutomationState(), quota:{dailyRemaining:6500},
    dailyBudget:{dateUtc:now.slice(0,10),fixtureIds:[],automationFixtureIds:[],manualFixtureIds:[],remaining:240}};
  for (const row of rows) value.state.fixtures[row.fixtureId] = row;
  value.fixturesByDate = Object.fromEntries(discoveryDates(value.policy, now).map(date => [date, []]));
  return value;
}
function moveDay(value, now) {
  value.now=now;
  value.fixturesByDate=Object.fromEntries(discoveryDates(value.policy, now).map(date=>[date,[]]));
  value.dailyBudget={dateUtc:now.slice(0,10),fixtureIds:[],automationFixtureIds:[],manualFixtureIds:[],remaining:240};
}
const completedToday = (id, stage='initial', stamp='2026-10-20T00:00:00Z') =>
  retained(id,'2026-10-10T00:00:00Z',
    stage==='initial'?['initial']:['initial','correction_6h'],stamp);
const correction = id => retained(id,'2026-10-14T00:00:00Z',['initial'],'2026-10-18T00:00:00Z');

test('the last shared slot goes to an unacquired fixture ahead of an older correction',()=>{
  const value=args([...Array.from({length:39},(_,i)=>completedToday(1000+i)),
    correction(1),retained(2,'2026-10-19T19:00:00Z')]);
  const plan=planAutomation(value);
  assert.deepEqual(plan.detailFetches.map(row=>[row.fixtureId,row.recheckStage]),[['af:fixture:2','initial']]);
  assert.equal(plan.quota.automaticFixturesUsedToday,39);
  assert.equal(plan.quota.fixturePublishesRemaining,0);
});

test('the October multi-date backlog is drained before corrections and later initial arrivals keep reserved capacity',()=>{
  const initial=Array.from({length:28},(_,i)=>retained(200+i,
    i<11?'2026-10-18T12:00:00Z':i<23?'2026-10-18T15:15:00Z':'2026-10-19T19:00:00Z'));
  const value=args([...Array.from({length:20},(_,i)=>correction(100+i)),...initial]);
  const before=JSON.stringify(value.state);
  const first=planAutomation(value);
  assert.equal(JSON.stringify(value.state),before,'planning cannot modify durable state');
  assert.deepEqual(first.initialBacklogByDate,[{dateJst:'2026-10-18',count:11},{dateJst:'2026-10-19',count:12},{dateJst:'2026-10-20',count:5}]);
  assert.equal(first.pendingInitialFixtures.length,28);
  assert.equal(first.dueInitialFixtureCount,28);
  assert.equal(first.selectedInitialFixtureCount,20);
  assert.equal(first.deferredInitialFixtureCount,8);
  assert.equal(first.selectedCorrectionFixtureCount,0);
  assert.deepEqual(first.detailFetches.map(row=>row.fixtureId),initial.slice(0,20).map(row=>row.fixtureId));
  value.state=advanceAutomationState(value.state,first,'2026-10-20T00:01:00Z');
  const second=planAutomation(value);
  assert.deepEqual(second.detailFetches.filter(row=>row.recheckStage==='initial').map(row=>row.fixtureId),
    initial.slice(20).map(row=>row.fixtureId));
  assert.equal(second.selectedInitialFixtureCount,8);
  assert.equal(second.selectedCorrectionFixtureCount,8);
  value.state=advanceAutomationState(value.state,second,'2026-10-20T00:02:00Z');
  const third=planAutomation(value);
  assert.equal(third.detailFetches.length,0);
  assert.equal(third.quota.fixturePublishesRemaining,4);
  assert.equal(third.quota.correctionFixturesUsedToday,8);
  assert.equal(third.quota.correctionFixtureSlotsRemaining,0);
  moveDay(value,'2026-10-20T04:00:00Z');
  for(let i=0;i<4;i++){const row=retained(700+i,'2026-10-20T00:00:00Z');value.state.fixtures[row.fixtureId]=row;}
  const later=planAutomation(value);
  assert.deepEqual(later.detailFetches.map(row=>row.fixtureId),['af:fixture:700','af:fixture:701','af:fixture:702','af:fixture:703']);
  assert.equal(later.selectedCorrectionFixtureCount,0);
  assert.equal(later.quota.fixturePublishesRemaining,0);
});

test('initial demand may use all forty slots rather than being capped at the thirty-two-slot reservation',()=>{
  const value=args([...Array.from({length:50},(_,i)=>retained(200+i,'2026-10-19T19:00:00Z')),
    ...Array.from({length:20},(_,i)=>correction(100+i))]);
  const first=planAutomation(value);
  value.state=advanceAutomationState(value.state,first,'2026-10-20T00:01:00Z');
  const second=planAutomation(value);
  assert.equal(first.selectedInitialFixtureCount,20);assert.equal(second.selectedInitialFixtureCount,20);
  assert.equal(first.selectedCorrectionFixtureCount+second.selectedCorrectionFixtureCount,0);
  value.state=advanceAutomationState(value.state,second,'2026-10-20T00:02:00Z');
  const third=planAutomation(value);
  assert.equal(third.detailFetches.length,0);
  assert.equal(third.deferredInitialFixtureCount,10);
});

test('unchanged corrections count through durable state and the correction sub-limit resets only at UTC midnight',()=>{
  const value=args(Array.from({length:20},(_,i)=>correction(100+i)),'2026-10-20T14:59:00Z');
  const first=planAutomation(value);
  assert.equal(first.detailFetches.length,8);
  value.state=advanceAutomationState(value.state,first,'2026-10-20T14:59:10Z');
  assert.equal(value.dailyBudget.fixtureIds.length,0,'simulate unchanged rechecks with no D1 receipt');
  assert.equal(planAutomation(value).detailFetches.length,0);
  moveDay(value,'2026-10-20T15:01:00Z');
  assert.equal(planAutomation(value).detailFetches.length,0,'JST midnight does not reset the UTC budget');
  moveDay(value,'2026-10-21T00:00:00Z');
  assert.equal(planAutomation(value).detailFetches.length,8);
});

test('unknown-stage receipts reserve correction capacity while already-published corrections can recover',()=>{
  const rows=[...Array.from({length:9},(_,i)=>correction(100+i)),retained(999,'2026-10-19T19:00:00Z')];
  const value=args(rows);
  const receipts=rows.slice(0,8).map(row=>row.fixtureId);
  value.dailyBudget={dateUtc:'2026-10-20',fixtureIds:receipts,automationFixtureIds:receipts,manualFixtureIds:[],remaining:232};
  const plan=planAutomation(value);
  assert.equal(plan.quota.correctionFixturesUsedToday,8);
  assert.equal(plan.selectedInitialFixtureCount,1);
  assert.equal(plan.selectedCorrectionFixtureCount,8,'repair the receipts without charging new correction slots');
  assert.ok(!plan.detailFetches.some(row=>row.fixtureId==='af:fixture:108'));
  assert.equal(plan.quota.correctionFixtureSlotsRemaining,0);
  assert.equal(plan.quota.fixturePublishesRemaining,31);
});

test('receipt recovery works with both daily budgets exhausted and never admits a new fixture',()=>{
  const value=args([correction(1),retained(999,'2026-10-19T19:00:00Z')]);
  const ids=Array.from({length:40},(_,i)=>`af:fixture:${i+1}`);
  value.dailyBudget={dateUtc:'2026-10-20',fixtureIds:ids,automationFixtureIds:ids,manualFixtureIds:[],remaining:200};
  const plan=planAutomation(value);
  assert.deepEqual(plan.detailFetches.map(row=>row.fixtureId),['af:fixture:1']);
  assert.equal(plan.quota.fixturePublishesRemaining,0);
  assert.equal(plan.quota.correctionFixtureSlotsRemaining,0);
});

test('existing pre-upgrade states above the correction allowance are accepted and cannot charge more corrections',()=>{
  const value=args([...Array.from({length:9},(_,i)=>completedToday(100+i,'correction_6h')),
    correction(1),retained(999,'2026-10-19T19:00:00Z')]);
  const plan=planAutomation(value);
  assert.deepEqual(plan.detailFetches.map(row=>row.fixtureId),['af:fixture:999']);
  assert.equal(plan.quota.correctionFixturesUsedToday,9);
  assert.equal(plan.quota.correctionFixtureSlotsRemaining,0);
});

test('initial priority cannot bypass provider reserve or the independent global publication cap',()=>{
  const value=args([retained(999,'2026-10-19T19:00:00Z')]);
  value.quota.dailyRemaining=104;
  assert.equal(planAutomation(value).detailFetches.length,0);
  value.quota.dailyRemaining=6500;
  const ids=Array.from({length:240},(_,i)=>`af:fixture:${i+1}`);
  value.dailyBudget={dateUtc:'2026-10-20',fixtureIds:ids,automationFixtureIds:[],manualFixtureIds:ids,remaining:0};
  assert.equal(planAutomation(value).detailFetches.length,0);
});

test('the correction allowance can be reduced to zero but cannot expand beyond eight',()=>{
  const p=policy();p.limits.maxCorrectionFixturesPerDay=0;
  assert.doesNotThrow(()=>validatePolicy(p));
  const value=args([correction(1),retained(999,'2026-10-19T19:00:00Z')]);value.policy=p;
  assert.deepEqual(planAutomation(value).detailFetches.map(row=>row.fixtureId),['af:fixture:999']);
  for(const count of [-1,1.5,9]){p.limits.maxCorrectionFixturesPerDay=count;assert.throws(()=>validatePolicy(p));}
});

test('an overdue correction covers elapsed checkpoints in one verified fetch without increasing any budget',()=>{
 const value=args([correction(1)]);
 const first=planAutomation(value);
 assert.equal(first.detailFetches[0].recheckStage,'correction_72h');
 const next=advanceAutomationState(value.state,first,'2026-10-20T00:01:00Z');
 assert.deepEqual(next.fixtures['af:fixture:1'].completedStages,['initial','correction_6h','correction_24h','correction_72h']);
 value.state=next;moveDay(value,'2026-10-21T00:00:00Z');
 assert.equal(planAutomation(value).detailFetches.length,0);
 assert.equal(first.selectedCorrectionFixtureCount,1);
});

test('a late initial publication retains initial priority and a failed correction remains due',()=>{
 const value=args([retained(2,'2026-10-10T00:00:00Z')]);
 const first=planAutomation(value);
 assert.equal(first.detailFetches[0].recheckStage,'initial');
 value.state=advanceAutomationState(value.state,first,'2026-10-20T00:01:00Z');
 moveDay(value,'2026-10-21T00:00:00Z');
 const retry=planAutomation(value);
 assert.equal(retry.detailFetches[0].recheckStage,'correction_72h');
 const failed=advanceAutomationState(value.state,{...retry,detailFetches:[]},'2026-10-21T00:01:00Z');
 assert.deepEqual(failed.fixtures['af:fixture:2'].completedStages,['initial']);
 assert.equal(planAutomation({...value,state:failed}).detailFetches[0].recheckStage,'correction_72h');
});
