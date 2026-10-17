(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JFWTrackedPlayerStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const metric = value => value?.presence === 'present' && Number.isFinite(value.value) ? value.value : null;

  function identity(player, records) {
    const related = records.filter(record => record.playerId === player.playerId);
    const ids = new Set([player, ...related].map(row => positive(row.providerIds?.apiFootball?.player)).filter(Boolean));
    if (ids.size !== 1) return null;
    const teams = new Set(related.map(row => positive(row.providerIds?.apiFootball?.team)).filter(Boolean));
    const leagues = new Set(related.map(row => positive(row.providerIds?.apiFootball?.league)).filter(Boolean));
    return { playerId: [...ids][0], teams, leagues };
  }

  function sum(rows, key) {
    const values = rows.map(row => metric(row[key]));
    return values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
  }

  function stats(rows) {
    return {
      apps: rows.reduce((total, row) => total + (Number.isSafeInteger(row.appearances) ? row.appearances : 0), 0),
      goals: sum(rows, 'goals'), assists: sum(rows, 'assists'),
      minutes: sum(rows, 'minutes'), redCards: sum(rows, 'redCards'),
      partial: rows.some(row => ['goals', 'assists', 'minutes'].some(key =>
        Number.isSafeInteger(row[key]?.observed) && Number.isSafeInteger(row[key]?.total)
        && row[key].observed < row[key].total)),
    };
  }

  // The published competition totals are used only when an existing explicit
  // provider player ID agrees with the recorded team and competition evidence.
  // Name matches never create a player identity or a tracking period.
  function build(players, records, payloads, competitionAliases = {}) {
    const result = new Map();
    for (const player of players) {
      const link = identity(player, records);
      if (!link) continue;
      const matched = [];
      let covered = false;
      for (const payload of payloads) {
        const competitionId = payload?.competition?.id;
        const providerLeague = positive(payload?.competition?.providerId);
        if (payload?.playerStats?.presence !== 'present' || !providerLeague || !Array.isArray(payload.playerStats.rows)) continue;
        const listedLeague = [player.league, ...(player.membershipHistory || []).map(item => item.league)]
          .some(label => competitionAliases[label] === competitionId || label === competitionId);
        if (!link.leagues.has(providerLeague) && !listedLeague) continue;
        covered = true;
        for (const row of payload.playerStats.rows || []) {
          if (positive(row?.player?.providerId) !== link.playerId) continue;
          if (link.teams.size && !link.teams.has(positive(row?.team?.id?.split(':').at(-1)))) continue;
          if (!row?.team?.id) continue;
          matched.push({ row, competitionId });
        }
      }
      if (!covered) continue;
      const byCompetition = {}, byTeam = {};
      for (const { row, competitionId } of matched) {
        (byCompetition[competitionId] ||= []).push(row);
        (byTeam[row.team.id] ||= []).push(row);
      }
      result.set(player.playerId, {
        providerId: link.playerId,
        seasonStats: matched.length ? stats(matched.map(item => item.row)) : null,
        competitionStats: Object.fromEntries(Object.entries(byCompetition).map(([key, value]) => [key, stats(value)])),
        clubStats: Object.fromEntries(Object.entries(byTeam).map(([key, value]) => [key, stats(value)])),
        photo: matched.find(item => item.row.player?.photo)?.row.player.photo || null,
      });
    }
    return result;
  }
  return { build, identity };
});
