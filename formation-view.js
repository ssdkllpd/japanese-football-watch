(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JFWFormation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const BAND_Y = Object.freeze({ GK: 88, DEF: 70, DM: 57, CM: 47, AM: 35, FW: 17 });
  const POSITION_BANDS = Object.freeze({
    G: 'GK', GK: 'GK',
    D: 'DEF', DF: 'DEF',
    M: 'CM', MF: 'CM',
    F: 'FW', FW: 'FW',
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function safeImageUrl(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function personInitials(value) {
    const text = String(value || '').trim();
    if (!text) return '—';
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every(part => /^[A-Za-z]/.test(part))) {
      return parts.slice(0, 2).map(part => part[0].toUpperCase()).join('');
    }
    return Array.from(text).slice(0, 2).join('');
  }

  function parseGrid(value) {
    const match = String(value || '').trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match) return null;
    const row = Number(match[1]);
    const column = Number(match[2]);
    if (!(row > 0) || !(column > 0)) return null;
    return { row, column };
  }

  function parseFormation(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const parts = text.split('-');
    if (parts.length < 3 || parts.length > 5) return null;
    const counts = parts.map(Number);
    if (counts.some(count => !Number.isInteger(count) || count <= 0)) return null;
    if (counts.reduce((sum, count) => sum + count, 0) !== 10) return null;
    return { text: counts.join('-'), counts };
  }

  function bandsForLineCount(lineCount) {
    if (lineCount === 3) return ['DEF', 'CM', 'FW'];
    if (lineCount === 4) return ['DEF', 'DM', 'AM', 'FW'];
    if (lineCount === 5) return ['DEF', 'DM', 'CM', 'AM', 'FW'];
    if (lineCount === 2) return ['DEF', 'FW'];
    if (lineCount === 1) return ['CM'];
    return null;
  }

  function formationPlan(value) {
    const parsed = parseFormation(value);
    if (!parsed) return null;
    const bands = bandsForLineCount(parsed.counts.length);
    if (!bands) return null;
    const rows = [{ row: 1, band: 'GK', slots: 1 }];
    parsed.counts.forEach((slots, index) => rows.push({ row: index + 2, band: bands[index], slots }));
    return { source: 'formation', confidence: 'high', formation: parsed.text, rows };
  }

  function positionBand(player) {
    const position = String(player?.position || player?.pos || '').trim().toUpperCase();
    return POSITION_BANDS[position] || null;
  }

  function gridPlan(players = []) {
    const valid = players
      .map(player => parseGrid(player?.grid))
      .filter(Boolean);
    if (!valid.length) return null;
    const rowNumbers = [...new Set(valid.map(grid => grid.row))].sort((a, b) => a - b);
    const outfieldRows = rowNumbers.filter(row => row !== 1);
    const bands = bandsForLineCount(outfieldRows.length);
    if (!bands) return null;
    const rows = [];
    if (rowNumbers.includes(1)) rows.push({ row: 1, band: 'GK', slots: 1 });
    outfieldRows.forEach((row, index) => {
      const rowPlayers = players.filter(player => parseGrid(player?.grid)?.row === row);
      const explicitMax = Math.max(0, ...rowPlayers.map(player => parseGrid(player?.grid)?.column || 0));
      rows.push({ row, band: bands[index], slots: Math.max(explicitMax, rowPlayers.length, 1) });
    });
    return { source: 'grid', confidence: 'medium', formation: null, rows };
  }

  function rowForGrid(plan, grid) {
    if (!plan || !grid) return null;
    return plan.rows.find(row => row.row === grid.row) || null;
  }

  function rowForBand(plan, band) {
    if (!plan || !band) return null;
    return plan.rows.find(row => row.band === band) || null;
  }

  function midfieldFallbackRow(plan, occupancy) {
    const candidates = ['CM', 'DM', 'AM']
      .map(band => rowForBand(plan, band))
      .filter(Boolean);
    if (!candidates.length) return null;
    return candidates.sort((left, right) => {
      const leftRemaining = left.slots - (occupancy.get(left.band) || 0);
      const rightRemaining = right.slots - (occupancy.get(right.band) || 0);
      return rightRemaining - leftRemaining;
    })[0];
  }

  function fallbackRowForPosition(plan, player, occupancy) {
    const band = positionBand(player);
    if (!band) return null;
    if (band === 'CM') return rowForBand(plan, 'CM') || midfieldFallbackRow(plan, occupancy);
    return rowForBand(plan, band);
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function nearestFreeSlot(preferred, slots, occupied) {
    const safePreferred = Math.max(1, Math.min(slots, preferred || 1));
    if (!occupied.has(safePreferred)) return safePreferred;
    for (let distance = 1; distance < slots; distance += 1) {
      const left = safePreferred - distance;
      const right = safePreferred + distance;
      if (left >= 1 && !occupied.has(left)) return left;
      if (right <= slots && !occupied.has(right)) return right;
    }
    return null;
  }

  function assignBandColumns(items, expectedSlots = null) {
    const explicitMax = Math.max(0, ...items.map(item => item.grid?.column || 0));
    const slots = Math.max(Number(expectedSlots) || 0, explicitMax, items.length, 1);
    const occupied = new Set();
    const columns = new Map();

    for (const item of items.filter(entry => entry.grid?.column)) {
      const column = nearestFreeSlot(item.grid.column, slots, occupied);
      if (column !== null) {
        occupied.add(column);
        columns.set(item.index, column);
      }
    }
    for (const item of items.filter(entry => !columns.has(entry.index))) {
      const column = nearestFreeSlot(1, slots, occupied);
      if (column !== null) {
        occupied.add(column);
        columns.set(item.index, column);
      }
    }
    return { slots, columns };
  }

  function evenFallback(players = []) {
    if (!players.length) return { players: [], confidence: 'none', source: 'even', formation: null };
    const bands = ['GK', 'DEF', 'CM', 'FW'];
    const outfield = Math.max(0, players.length - 1);
    const rows = [1, 0, 0, 0];
    for (let index = 0; index < outfield; index += 1) rows[1 + (index % 3)] += 1;
    const offsets = [0, 1, 1 + rows[1], 1 + rows[1] + rows[2]];
    const laidOut = players.map((player, index) => {
      const bandIndex = index === 0 ? 0 : (index <= rows[1] ? 1 : index <= rows[1] + rows[2] ? 2 : 3);
      const band = bands[bandIndex];
      const slots = Math.max(rows[bandIndex], 1);
      const column = index - offsets[bandIndex] + 1;
      return {
        ...player,
        x: round1(Math.max(7, Math.min(93, column / (slots + 1) * 100))),
        y: BAND_Y[band],
        layoutBand: band,
        layoutConfidence: 'none',
        layoutSource: 'even',
      };
    });
    return { players: laidOut, confidence: 'none', source: 'even', formation: null };
  }

  function layoutFormation(players = [], formation = null) {
    const list = Array.isArray(players) ? players : [];
    if (!list.length) return { players: [], confidence: 'none', source: 'empty', formation: null };

    const hintedFormation = formation || list.find(player => player?.formation)?.formation || null;
    const parsedFormationPlan = formationPlan(hintedFormation);
    const parsedGridPlan = gridPlan(list);
    const plan = parsedFormationPlan || parsedGridPlan;

    if (!plan) {
      const hasPositions = list.some(player => positionBand(player));
      if (!hasPositions) return evenFallback(list);
      const groups = new Map();
      list.forEach((player, index) => {
        const band = positionBand(player) || 'CM';
        if (!groups.has(band)) groups.set(band, []);
        groups.get(band).push({ player, index, grid: null, band, expectedSlots: null });
      });
      const output = new Array(list.length);
      for (const [band, items] of groups) {
        const { slots, columns } = assignBandColumns(items);
        items.forEach(item => {
          const column = columns.get(item.index) || 1;
          output[item.index] = {
            ...item.player,
            x: round1(Math.max(7, Math.min(93, column / (slots + 1) * 100))),
            y: BAND_Y[band] ?? BAND_Y.CM,
            layoutBand: band,
            layoutConfidence: 'low',
            layoutSource: 'position',
          };
        });
      }
      return { players: output, confidence: 'low', source: 'position', formation: null };
    }

    const occupancy = new Map();
    const prepared = list.map((player, index) => {
      const grid = parseGrid(player?.grid);
      let row = rowForGrid(plan, grid);
      if (!row) row = fallbackRowForPosition(plan, player, occupancy);
      if (!row) row = plan.rows.find(candidate => candidate.band !== 'GK') || plan.rows[0];
      occupancy.set(row.band, (occupancy.get(row.band) || 0) + 1);
      return { player, index, grid, row, band: row.band, expectedSlots: row.slots };
    });

    const groups = new Map();
    for (const item of prepared) {
      if (!groups.has(item.band)) groups.set(item.band, []);
      groups.get(item.band).push(item);
    }

    let confidence = plan.confidence;
    if (parsedFormationPlan && prepared.some(item => !item.grid || !rowForGrid(parsedFormationPlan, item.grid))) {
      confidence = 'medium';
    }

    const output = new Array(list.length);
    for (const [band, items] of groups) {
      const expectedSlots = Math.max(...items.map(item => item.expectedSlots || 0), 0) || null;
      const { slots, columns } = assignBandColumns(items, expectedSlots);
      items.forEach(item => {
        const column = columns.get(item.index) || 1;
        output[item.index] = {
          ...item.player,
          x: round1(Math.max(7, Math.min(93, column / (slots + 1) * 100))),
          y: BAND_Y[band] ?? BAND_Y.CM,
          layoutBand: band,
          layoutConfidence: confidence,
          layoutSource: parsedFormationPlan ? 'formation' : 'grid',
        };
      });
    }

    return {
      players: output,
      confidence,
      source: parsedFormationPlan ? 'formation' : 'grid',
      formation: parsedFormationPlan?.formation || null,
    };
  }

  function layoutPlayers(players = [], formation = null) {
    const result = layoutFormation(players, formation);
    const output = result.players;
    try {
      Object.defineProperty(output, 'layoutMeta', {
        value: { confidence: result.confidence, source: result.source, formation: result.formation },
        enumerable: false,
        configurable: true,
      });
    } catch {}
    return output;
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

  function installBrowserLayoutUi() {
    if (typeof document === 'undefined') return;
    const install = () => {
      if (!document.getElementById('jfw-formation-layout-style')) {
        const style = document.createElement('style');
        style.id = 'jfw-formation-layout-style';
        style.textContent = `
          .mdPitch{width:min(calc(100% - 20px),420px)!important;height:auto!important;aspect-ratio:2/3!important;margin:0 auto 10px!important}
          .mdPitchPlayer{width:55px!important}
          .mdPitchName{font-size:9px!important}
          .mdFormationEstimate{display:inline-block;margin-left:6px;border:1px solid #fbbf2466;border-radius:999px;padding:2px 5px;color:#fbbf24;font-size:8px;font-weight:800;vertical-align:middle}
        `;
        document.head?.appendChild(style);
      }
      const annotate = root => {
        root?.querySelectorAll?.('.mdFormationName').forEach(label => {
          const textNode = Array.from(label.childNodes || []).find(node => node.nodeType === 3 && String(node.textContent || '').trim());
          const raw = String(textNode?.textContent || '').trim();
          const existing = label.querySelector?.('.mdFormationEstimate');
          if (parseFormation(raw)) {
            existing?.remove?.();
            return;
          }
          if (!existing) {
            const badge = document.createElement('span');
            badge.className = 'mdFormationEstimate';
            badge.textContent = '配置は推定';
            label.insertBefore(badge, label.querySelector?.('small') || null);
          }
        });
      };
      annotate(document);
      if (typeof MutationObserver !== 'undefined' && !globalThis.__jfwFormationLayoutObserver) {
        const observer = new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes || []) {
              if (node?.nodeType === 1) annotate(node);
            }
          }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        globalThis.__jfwFormationLayoutObserver = observer;
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
  }

  installBrowserLayoutUi();

  return {
    BAND_Y,
    apiFootballRating,
    finiteNumber,
    formatMinute,
    formationPlan,
    jfwRating,
    layoutFormation,
    layoutPlayers,
    parseFormation,
    parseGrid,
    personInitials,
    ratingForPlayer,
    recordForPlayer,
    safeImageUrl,
  };
});
