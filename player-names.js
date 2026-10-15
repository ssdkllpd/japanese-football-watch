(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JFWPlayerNames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  function entry(player, registry) {
    const id = player?.playerId || player?.jfwPlayerId || player?.id;
    if (!/^af:player:[1-9]\d*$/.test(String(id || ''))) return null;
    const row = registry?.players?.[id];
    return Array.isArray(row) ? row : null;
  }
  function fullName(player, registry) {
    const current = String(player?.name || '').trim();
    const full = entry(player, registry)?.[1];
    // Expand provider initials only; preserve existing full names, local names and mononyms.
    return full && (!current || /(?:^|\s)\p{L}\./u.test(current)) ? full : current;
  }
  function pitchName(player, registry) {
    return entry(player, registry)?.[0] || String(player?.name || '').trim();
  }
  return { fullName, pitchName };
});
