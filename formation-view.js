(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JFWFormation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const POSITION_ROWS = { G: 1, GK: 1, D: 2, DF: 2, M: 3, MF: 3, F: 4, FW: 4 };

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseGrid(value) {
    const match = String(value || '').trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match) return null;
    const row = Number(match[1]);
    const column = Number(match[2]);
    if (!(row > 0) || !(column > 0)) return null;
    return { row, column };
  }

  function fallbackRow(player) {
    const position = String(player?.position || player?.pos || '').trim().toUpperCase();
    return POSITION_ROWS[position] || 3;
  }

  function layoutPlayers(players = []) {
    const prepared = players.map((player, index) => ({
      player,
      index,
      grid: parseGrid(player?.grid),
      row: parseGrid(player?.grid)?.row || fallbackRow(player),
    }));
    const rowGroups = new Map();
    for (const item of prepared) {
      if (!rowGroups.has(item.row)) rowGroups.set(item.row, []);
      rowGroups.get(item.row).push(item);
    }
    const maxRow = Math.max(4, ...prepared.map(item => item.row));

    return prepared.map(item => {
      const group = rowGroups.get(item.row) || [item];
      const explicitMax = Math.max(0, ...group.map(entry => entry.grid?.column || 0));
      const columns = Math.max(group.length, explicitMax, 1);
      const fallbackColumn = group.indexOf(item) + 1;
      const column = item.grid?.column || fallbackColumn;
      const x = Math.max(7, Math.min(93, column / (columns + 1) * 100));
      const y = Math.max(8, Math.min(91, 88 - (item.row - 1) / (maxRow - 1) * 78));
      return { ...item.player, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    });
  }

  function recordForPlayer(player, records = []) {
    const playerId = player?.playerId;
    const providerId = player?.providerPlayerId;
    return records.find(record => {
      if (playerId !== null && playerId !== undefined && record?.playerId !== null && record?.playerId !== undefined) {
        if (String(playerId) === String(record.playerId)) return true;
      }
      const recordProviderId = record?.providerIds?.apiFootball?.player ??
        record?.providerIds?.apiFootball?.playerId;
      return providerId !== null && providerId !== undefined &&
        recordProviderId !== null && recordProviderId !== undefined &&
        String(providerId) === String(recordProviderId);
    }) || null;
  }

  function apiFootballRating(player, record = null) {
    return finiteNumber(
      player?.apiFootballRating ??
      record?.providerRatings?.apiFootball?.value ??
      record?.apiFootballRating
    );
  }

  function jfwRating(record) {
    const value = finiteNumber(record?.jfwRating);
    return value !== null && value >= 3 && value <= 10 ? value : null;
  }

  function ratingForPlayer(player, mode = 'apiFootball', records = []) {
    const record = recordForPlayer(player, records);
    return mode === 'jfw' ? jfwRating(record) : apiFootballRating(player, record);
  }

  function formatMinute(value) {
    const elapsed = finiteNumber(value?.elapsed ?? value?.minute);
    const extra = finiteNumber(value?.extra);
    if (elapsed === null) return '時刻未取得';
    return `${Math.trunc(elapsed)}${extra !== null && extra > 0 ? `+${Math.trunc(extra)}` : ''}′`;
  }

  return {
    apiFootballRating,
    finiteNumber,
    formatMinute,
    jfwRating,
    layoutPlayers,
    parseGrid,
    ratingForPlayer,
    recordForPlayer,
  };
});
