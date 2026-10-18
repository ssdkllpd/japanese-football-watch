(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JFWAllPlayerStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const metric = (row, key) => row[key]?.presence === 'present' ? row[key].value : null;
  function sum(rows, key) {
    const values = rows.map(row => metric(row, key));
    return values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;
  }
  function summarize(rows) {
    return { apps: rows.reduce((n, row) => n + row.appearances, 0),
      goals: sum(rows, 'goals'), assists: sum(rows, 'assists'),
      minutes: sum(rows, 'minutes'), redCards: sum(rows, 'redCards'),
      partial: rows.some(row => ['goals', 'assists', 'minutes'].some(key =>
        row[key]?.observed < row[key]?.total)),
    };
  }
  function build(payloads) {
    const groups = new Map();
    for (const payload of payloads) {
      if (payload?.playerStats?.presence !== 'present') continue;
      for (const row of payload.playerStats.teamRows || []) {
        if (!row.player?.id || !row.team?.id) continue;
        const value = groups.get(row.player.id) || [];
        value.push({ row, competitionId: payload.competition.id });
        groups.set(row.player.id, value);
      }
    }
    return new Map([...groups].map(([id, matches]) => {
      const byCompetition = new Map(), byClub = new Map();
      for (const { row, competitionId } of matches) {
        byCompetition.set(competitionId, [...byCompetition.get(competitionId) || [], row]);
        byClub.set(row.team.id, [...byClub.get(row.team.id) || [], row]);
      }
      const last = matches.at(-1).row;
      return [id, {
        playerId: id, providerId: last.player.providerId, name: last.player.name,
        nationality: last.player.nationality, photo: last.player.photo,
        seasonStats: summarize(matches.map(item => item.row)),
        competitionStats: Object.fromEntries([...byCompetition].map(([key, rows]) => [key, summarize(rows)])),
        clubStats: Object.fromEntries([...byClub].map(([key, rows]) => [key, summarize(rows)])),
        clubNames: Object.fromEntries(matches.filter(item => item.row.team.name).map(item => [item.row.team.id, item.row.team.name])),
        statsSource: 'published',
      }];
    }));
  }
  return { build, summarize };
});
