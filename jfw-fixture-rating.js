(function(root, factory) {
  const engine = typeof module === 'object' && module.exports ? require('./jfw-rating.js') : root.JFWRating;
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JFWFixtureRating = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, engine => {
  'use strict';
  const fields = ['minutes','goals','assists','shots','shotsOnTarget','keyPasses','dribbles',
    'duelsWon','duelsTotal','passesCompleted','passesAttempted','tackles','interceptions',
    'clearances','blocks','aerialDuelsWon','aerialDuelsTotal','dribbledPast','bigChancesMissed',
    'possessionsLost','gaOnPitch','saves','shotsOnTargetFaced','penaltiesSaved','highClaims',
    'errorsLeadingToGoal','yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals'];
  const aliases = {duelsTotal:'duels', passesAttempted:'passes', passesCompleted:'passesAccurate'};
  const discipline = ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals'];
  const missing = () => ({state:'missing'});
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function position(value) {
    const pos = String(value || '').toUpperCase();
    if (['G','GK','GOALKEEPER'].includes(pos)) return 'GK';
    if (['D','DF','DEFENDER','CB','LCB','RCB','LB','RB','LWB','RWB'].includes(pos)) return 'DF';
    if (['M','MF','MIDFIELDER','DM','CDM','CM','AM','CAM','LM','RM'].includes(pos)) return 'MF';
    if (['F','FW','ATTACKER','FORWARD','LW','RW','SS','CF','ST'].includes(pos)) return 'FW';
    return null;
  }
  function calculate(row, bundle) {
    const fixture = bundle.fixture || {};
    const sourceId = `api-football:${fixture.id}:${row.playerId}`;
    const value = n => ({state:'value',value:n,sourceId});
    const inputs = Object.fromEntries(fields.map(key => {
      const field = aliases[key] || key;
      const presence = row.fieldStates?.[field]?.presence;
      const n = row.values?.[field];
      return [key, (!presence || presence === 'present') && valid(n) ? value(n) : missing()];
    }));
    const lineup = (bundle.lineups || []).find(item => item.teamId === row.teamId);
    const starter = (lineup?.startXI || []).find(item => item.id === row.playerId);
    const substitute = (lineup?.substitutes || []).find(item => item.id === row.playerId);
    const matchPosition = position(starter?.position || substitute?.position);
    const pos = matchPosition || position(row.position);
    const final = ['FT','AET','PEN'].includes(fixture.status?.short) && fixture.ingestionState !== 'needs_review';
    const presentEvents = bundle.sectionStates?.events?.presence === 'present' && Array.isArray(bundle.events);
    const events = presentEvents ? bundle.events : [];
    const goals = events.filter(event => event.type === 'goal');
    const teamIds = [fixture.teams?.home?.id, fixture.teams?.away?.id];
    // Score parity only establishes goal coverage, never card/substitution coverage.
    // PEN is excluded because shootout penalties can share the same event shape.
    const completeGoals = final && fixture.status.short !== 'PEN' && presentEvents
      && teamIds.every(Boolean) && row.playerId && teamIds.includes(row.teamId)
      && goals.every(event => teamIds.includes(event.teamId) && event.playerId
        && ['Normal Goal','Penalty','Own Goal'].includes(event.detail)
        && Number.isInteger(event.elapsed) && event.elapsed >= 0 && event.elapsed <= (fixture.status.short === 'FT' ? 90 : 120)
        && !/cancel|disallow|shoot.?out/i.test(event.comments || ''))
      && !events.some(event => event.type === 'var' && /goal/i.test(event.detail || ''))
      && ['home','away'].every(side => Number.isSafeInteger(fixture.score?.goals?.[side])
        && fixture.score.goals[side] >= 0
        && goals.filter(event => event.teamId === fixture.teams[side].id).length === fixture.score.goals[side]);
    if (completeGoals) {
      const counts = {
        goals:goals.filter(e => e.playerId === row.playerId && e.teamId === row.teamId && e.detail !== 'Own Goal').length,
        assists:goals.filter(e => e.relatedPlayerId === row.playerId && e.teamId === row.teamId && e.detail !== 'Own Goal').length,
        ownGoals:goals.filter(e => e.playerId === row.playerId && e.detail === 'Own Goal').length,
      };
      for (const [key,count] of Object.entries(counts)) {
        // A disagreement must not silently prefer one source.
        if (inputs[key].state === 'value' && inputs[key].value !== count) inputs[key] = missing();
        else inputs[key] = value(count);
      }
    }
    const red = row.values?.redCards;
    const redState = row.fieldStates?.redCards?.presence;
    const redKnown = (!redState || redState === 'present') && Number.isInteger(red) && red >= 0;
    const redConflict = events.some(e => e.type === 'card' && e.playerId === row.playerId && e.teamId === row.teamId
      && /red|second yellow/i.test(e.detail || '')) && red === 0;
    if (redConflict) {
      inputs.secondYellowRed = missing();
      inputs.straightRed = missing();
    } else if (redKnown && red === 0) {
      inputs.secondYellowRed = value(0);
      inputs.straightRed = value(0);
    } else if (redKnown && red > 0 && final && presentEvents) {
      const cards = events.filter(e => e.type === 'card' && e.playerId === row.playerId && e.teamId === row.teamId);
      const second = cards.filter(e => /second yellow/i.test(e.detail || '')).length;
      const straight = cards.filter(e => /^red card$/i.test(e.detail || '')).length;
      if (second + straight === red) {
        inputs.secondYellowRed = value(second);
        inputs.straightRed = value(straight);
        // The provider may report only the first yellow separately.
        if (second && inputs.yellowCards.state === 'value') inputs.yellowCards = value(Math.max(inputs.yellowCards.value, 2 * second));
      }
    }
    const observedYellow = events.filter(e => e.type === 'card' && e.playerId === row.playerId && e.teamId === row.teamId
      && /yellow/i.test(e.detail || '')).length;
    if (inputs.yellowCards.state === 'value' && observedYellow > inputs.yellowCards.value) inputs.yellowCards = missing();
    let gaOnPitchAmbiguous = false;
    if (completeGoals && ['DF','GK'].includes(pos)) {
      const incoming = events.filter(e => e.type === 'substitution' && e.relatedPlayerId === row.playerId && e.teamId === row.teamId);
      const outgoing = events.filter(e => (e.type === 'substitution' || (e.type === 'card' && /red|second yellow/i.test(e.detail || '')))
        && e.playerId === row.playerId && e.teamId === row.teamId);
      const duration = fixture.status.short === 'FT' ? 90 : 120;
      const start = starter ? 0 : incoming.length === 1 ? incoming[0].elapsed : null;
      const end = outgoing.length === 1 ? outgoing[0].elapsed
        : outgoing.length === 0 && inputs.minutes.state === 'value' && start !== null && inputs.minutes.value === duration - start ? duration : null;
      if (Number.isInteger(start) && Number.isInteger(end) && end >= start
        && inputs.minutes.state === 'value' && inputs.minutes.value > 0
        && inputs.minutes.value === end - start) {
        // Same-minute goal precedes substitution (ops-v1.0). Extra-time clocks
        // are not converted into duration estimates.
        const conceded = goals.filter(e => e.teamId !== row.teamId);
        const beforeExit = e => {
          if (e.elapsed !== end || !outgoing.length) return e.elapsed <= end;
          const extra = outgoing[0].extra;
          return !Number.isInteger(extra) || !Number.isInteger(e.extra) || e.extra <= extra;
        };
        const afterEntry = e => {
          if (start === 0 || e.elapsed !== start) return start === 0 || e.elapsed > start;
          const extra = incoming[0]?.extra;
          return Number.isInteger(extra) && Number.isInteger(e.extra) && e.extra > extra;
        };
        inputs.gaOnPitch = value(conceded.filter(e => afterEntry(e) && beforeExit(e)).length);
        gaOnPitchAmbiguous = conceded.some(e => e.elapsed === end || (start > 0 && e.elapsed === start));
      }
    }
    const result = engine.compute(inputs, pos);
    const reason = !final ? 'match_not_final' : result.reason;
    const performanceStates = engine.inputStates(inputs,pos);
    const unavailable = [...new Set([...['minutes','goals','assists',...discipline].filter(key => inputs[key].state === 'missing'),
      ...Object.keys(performanceStates).filter(key => performanceStates[key].state === 'missing')])];
    return {
      ...result,
      jfwRating:reason ? null : result.jfwRating,
      value:reason ? null : result.jfwRating,
      presence:reason ? 'provider_missing' : 'present',
      reason:reason || null,
      ratingInputs:inputs,
      ratingPositionSource:matchPosition ? 'match_official' : pos ? 'match_secondary' : 'unknown',
      ratingOpsVersion:'ops-v1.0',
      gaOnPitchAmbiguous,
      ratingSources:[{id:sourceId,name:'API-Football',type:'provider',url:`https://www.api-football.com/`,
        fixtureId:fixture.id,fetchedAt:row.provenance?.fetchedAt || fixture.provenance?.fetchedAt || null}],
      missingFields:unavailable,
      notApplicableFields:Object.keys(performanceStates).filter(key => performanceStates[key].state === 'notApplicable'),
      missingRequired:['minutes','goals','assists',...discipline].filter(key => inputs[key].state === 'missing'),
      factors:result.ratingFactors || {},
    };
  }
  return {calculate, position};
});
