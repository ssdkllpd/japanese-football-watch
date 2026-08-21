(() => {
  'use strict';

  const DISC = ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals'];
  const AGG_FIELDS = [
    'apps','starts','minutes','goals','assists','cleanSheets','yellowCards','secondYellowRed','straightRed',
    'shots','shotsOnTarget','keyPasses','tackles','interceptions','clearances','blocks','saves',
    'duelsWon','duelsTotal','aerialDuelsWon','aerialDuelsTotal','dribbles','dribbledPast',
    'bigChancesMissed','possessionsLost','passesCompleted','passesAttempted','shotsOnTargetFaced',
    'penaltiesSaved','penaltiesConceded','ownGoals','highClaims','errorsLeadingToGoal','gaOnPitch'
  ];
  const NON_OFFICIAL_RE = /friendly|pre[- ]?season|親善|プレシーズン/i;
  const OUT_OF_SCOPE_BUCKET = '無所属・追跡対象外';
  const TRACKED_LEAGUES = new Set([
    'Premier League','プレミアリーグ',
    'EFL Championship','Championship','チャンピオンシップ',
    'Bundesliga','ブンデスリーガ',
    'Belgian Pro League','ベルギー・プロ・リーグ','ベルギー',
    'Eredivisie','エールディヴィジ',
    'La Liga','ラ・リーガ',
    'Ligue 1','リーグ・アン',
    'Serie A','セリエA',
    'Scottish Premiership','スコティッシュ・プレミアシップ','スコットランド',
    'Primeira Liga','ポルトガル1部','ポルトガル'
  ]);

  let loading = null;
  let uiPolicyInstalled = false;

  async function getJson(path) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(path + sep + 'v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }

  function matchKeyOf(m) { return [m?.league, m?.ko, m?.match].join('|'); }
  function cleanMatchUpdate(u) {
    const { matchKey, addIfMissing, addToTopMatches, ...rest } = u || {};
    return rest;
  }
  function matchFinder(list, u) {
    return list.find(x =>
      (u.matchId && x.matchId === u.matchId) ||
      (u.matchKey && matchKeyOf(x) === u.matchKey)
    );
  }
  function mergeMatchUpdates(rows) {
    D.matches = D.matches || [];
    D.topMatches = D.topMatches || [];
    for (const u of rows || []) {
      const clean = cleanMatchUpdate(u);
      let m = matchFinder(D.matches, u);
      if (m) Object.assign(m, clean);
      else if (u.addIfMissing !== false) D.matches.push({ ...clean });

      let top = matchFinder(D.topMatches, u);
      if (top) Object.assign(top, clean);
      else if (u.addToTopMatches) D.topMatches.push({ ...clean });
    }
  }

  function textKey(value) {
    return String(value ?? '').normalize('NFKC').trim();
  }
  function stableHash(value) {
    let h = 2166136261;
    for (const ch of textKey(value)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  function stablePlayerId(name) { return `jp-${stableHash(name)}`; }
  function isTrackedLeague(league) {
    const value = textKey(league);
    return !!value && value !== 'J1' && TRACKED_LEAGUES.has(value);
  }
  function timeKey(value) {
    const m = String(value || '').match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/);
    return m ? m[0].replace('T', ' ') : '';
  }
  function dateKey(value) {
    const t = timeKey(value);
    return t ? t.slice(0, 10) : null;
  }
  function hasNumericStats(stats) {
    return !!stats && Object.values(stats).some(v => v != null && Number.isFinite(Number(v)));
  }
  function baselineKey(club, competition) {
    return `${String(club || '')}|||${String(competition || '')}`;
  }
  function ensurePlayerIdentity(p) {
    if (!p || !p.name) return p;
    if (!p.playerId) p.playerId = stablePlayerId(p.name);
    p.membershipHistory = Array.isArray(p.membershipHistory) ? p.membershipHistory : [];
    p.membershipCorrections = Array.isArray(p.membershipCorrections) ? p.membershipCorrections : [];
    p._aggregateBaselines = p._aggregateBaselines || {};
    if (!p._initialStatsCaptured) {
      p._initialStats = { ...(p.stats || {}) };
      p._initialClub = p.club || null;
      p._initialLeague = p.league || null;
      p._initialStatsUpdated = D?.updated || null;
      p._initialStatsCaptured = true;
    }
    if (!p.membershipHistory.length && (p.club || p.league)) {
      p.membershipHistory.push({
        club: p.club || null,
        league: p.league || null,
        from: p.joinedAt || null,
        to: null,
        tracked: isTrackedLeague(p.league),
        changeType: 'initial'
      });
    }
    setTrackingState(p);
    return p;
  }
  function initializePlayers() {
    D.players = D.players || [];
    for (const p of D.players) ensurePlayerIdentity(p);
  }
  function playerByIncoming(u) {
    if (!u) return null;
    if (u.playerId) {
      const byId = (D.players || []).find(p => String(p.playerId || '') === String(u.playerId));
      if (byId) return byId;
    }
    return (D.players || []).find(p => p.name === u.name) || null;
  }
  function setTrackingState(p) {
    const tracked = isTrackedLeague(p.league);
    p.currentClub = p.club || null;
    p.currentLeague = p.league || null;
    p.trackedClub = tracked;
    p.trackingStatus = tracked ? 'active' : (p.club ? 'out_of_scope' : 'unattached');
    p.trackingBucket = tracked ? (p.league || '') : OUT_OF_SCOPE_BUCKET;
    if (p.rankingEligible == null) p.rankingEligible = true;
    p.statsTrackingState = tracked ? 'active' : 'frozen_out_of_scope';
  }
  function openMembership(p) {
    return [...(p.membershipHistory || [])].reverse().find(x => !x.to) || null;
  }
  function membershipAt(p, when) {
    const day = dateKey(when);
    const rows = p?.membershipHistory || [];
    if (!rows.length) return null;
    if (!day) return openMembership(p) || rows.at(-1);
    const matches = rows.filter(x => {
      const from = dateKey(x.from);
      const to = dateKey(x.to);
      return (!from || day >= from) && (!to || day < to);
    });
    if (matches.length) return matches.sort((a, b) => String(b.from || '').localeCompare(String(a.from || '')))[0];
    return openMembership(p) || rows.at(-1) || null;
  }
  function recordsForIdentity(p) {
    return (D.playerMatchStats || []).filter(r =>
      (r.playerId && String(r.playerId) === String(p.playerId)) ||
      r.player === p.name || r.playerName === p.name
    );
  }
  function inferMembershipChangeType(p, u) {
    if (u.membershipChangeType) return u.membershipChangeType;
    if (u.transferDate || u.effectiveDate) return 'transfer';
    const oldClub = p.club;
    if (!oldClub || oldClub === u.club) return 'update';
    const hasOldClubRecords = recordsForIdentity(p).some(r => r.club === oldClub);
    return hasOldClubRecords ? 'transfer' : 'correction';
  }
  function saveBaseline(p, club, competition, stats, updated, statsAsOf) {
    if (!club || !competition || !hasNumericStats(stats)) return;
    p._aggregateBaselines = p._aggregateBaselines || {};
    p._aggregateBaselines[baselineKey(club, competition)] = {
      club,
      competition,
      stats: { ...stats },
      updated: updated || null,
      statsAsOf: statsAsOf || null
    };
  }
  function ensureInitialBaseline(p, club = p.club, competition = p.league, updated = D.updated) {
    if (!hasNumericStats(p._initialStats)) return;
    if (p._initialClub && club !== p._initialClub) return;
    if (p._initialLeague && competition !== p._initialLeague) return;
    const key = baselineKey(club, competition);
    if (!p._aggregateBaselines?.[key]) saveBaseline(p, club, competition, p._initialStats, p._initialStatsUpdated || updated, p.statsAsOf);
  }
  function applyMembershipChange(p, u, fragmentUpdated) {
    const nextClub = u.club !== undefined ? u.club : p.club;
    const nextLeague = u.league !== undefined ? u.league : p.league;
    const changed = nextClub !== p.club || nextLeague !== p.league;
    if (!changed) return;

    const type = inferMembershipChangeType(p, u);
    const effective = u.transferDate || u.effectiveDate || u.joinedAt || dateKey(fragmentUpdated) || null;
    const oldClub = p.club || null;
    const oldLeague = p.league || null;

    if (type === 'correction') {
      const current = openMembership(p);
      if (current) {
        p.membershipCorrections.push({
          at: effective,
          fromClub: current.club || oldClub,
          fromLeague: current.league || oldLeague,
          toClub: nextClub || null,
          toLeague: nextLeague || null,
          sourceIds: u.sourceIds || []
        });
        current.club = nextClub || null;
        current.league = nextLeague || null;
        current.tracked = isTrackedLeague(nextLeague);
        current.changeType = 'corrected_initial';
      }
    } else {
      ensureInitialBaseline(p, oldClub, oldLeague, fragmentUpdated);
      const current = openMembership(p);
      if (current) current.to = effective;
      p.membershipHistory.push({
        club: nextClub || null,
        league: nextLeague || null,
        from: effective,
        to: null,
        tracked: isTrackedLeague(nextLeague),
        changeType: type,
        sourceIds: u.sourceIds || []
      });
      if (oldClub && oldClub !== nextClub) p.previousClub = u.previousClub || oldClub;
      if (oldLeague && oldLeague !== nextLeague) p.previousLeague = u.previousLeague || oldLeague;
    }
  }
  function mergeProviderIds(current, incoming) {
    const out = { ...(current || {}) };
    for (const [provider, ids] of Object.entries(incoming || {})) {
      out[provider] = {
        ...(out[provider] || {}),
        ...(ids || {})
      };
    }
    return out;
  }
  function mergePlayerUpdates(rows, fragmentUpdated) {
    D.players = D.players || [];
    for (const u of rows || []) {
      let p = playerByIncoming(u);
      const incomingStats = u.stats ? { ...u.stats } : null;
      const incomingProviderIds = u.providerIds ? { ...u.providerIds } : null;
      const { stats, providerIds, ...meta } = u;
      if (!p) {
        p = { ...meta, stats: {} };
        if (incomingProviderIds) p.providerIds = mergeProviderIds(null, incomingProviderIds);
        ensurePlayerIdentity(p);
        D.players.push(p);
      } else {
        ensurePlayerIdentity(p);
        applyMembershipChange(p, u, fragmentUpdated);
        Object.assign(p, meta);
        if (incomingProviderIds) p.providerIds = mergeProviderIds(p.providerIds, incomingProviderIds);
      }
      ensurePlayerIdentity(p);
      if (incomingStats) saveBaseline(p, p.club, p.league, incomingStats, u.statsAsOfDate || u.aggregateAsOf || fragmentUpdated, u.statsAsOf);
      setTrackingState(p);
    }
  }

  function normalizeRecord(r, sources) {
    const out = { ...r };
    const sourceIds = r.sourceIds || [];
    const defaultSource = sourceIds[0];
    out.ratingSources = sourceIds.map(id => sources[id]).filter(Boolean);
    const inputs = {};
    for (const [field, value] of Object.entries(r.values || {})) {
      inputs[field] = {
        state: 'value',
        value,
        sourceId: (r.fieldSources || {})[field] || defaultSource
      };
    }
    if (r.disciplineClean) {
      for (const field of DISC) if (!inputs[field]) {
        inputs[field] = { state: 'value', value: 0, sourceId: defaultSource };
      }
    }
    for (const field of r.missingFields || []) {
      if (!inputs[field]) inputs[field] = { state: 'missing' };
    }
    out.ratingInputs = inputs;
    for (const field of ['minutes','goals','assists']) {
      if (inputs[field]?.state === 'value') out[field] = inputs[field].value;
    }
    delete out.values;
    delete out.sourceIds;
    delete out.fieldSources;
    delete out.disciplineClean;
    return out;
  }
  function ratingInputsSignature(record) {
    try { return JSON.stringify(record?.ratingInputs || {}); } catch { return ''; }
  }
  function mergeRatingInputs(current, incoming) {
    const out = { ...(current || {}) };
    for (const [field, next] of Object.entries(incoming || {})) {
      const previous = out[field];
      if (next?.state === 'missing' && previous?.state === 'value') continue;
      out[field] = next;
    }
    return out;
  }
  function clearCachedRating(record) {
    const out = { ...record };
    for (const key of ['jfwRating','ratingVersion','ratingCoverage','ratingBreakdown','ratingStatus','ratingReason','ratingOpsVersion']) {
      delete out[key];
    }
    return out;
  }
  function playerForRecord(r) {
    const name = r?.playerName || r?.player || null;
    return (D.players || []).find(p =>
      (r?.playerId && String(p.playerId) === String(r.playerId)) ||
      (!!name && p.name === name)
    ) || null;
  }
  function matchForRecord(r) {
    return (D.matches || []).find(m =>
      (r.matchId && m.matchId === r.matchId) ||
      (r.match && r.ko && m.match === r.match && m.ko === r.ko)
    ) || null;
  }
  function competitionOfRecord(r) {
    const m = matchForRecord(r);
    return String(r?.competition || r?.league || m?.league || '');
  }
  function clubForRecord(r, p = playerForRecord(r)) {
    if (r?.club) return r.club;
    return membershipAt(p, r?.ko)?.club || p?.club || null;
  }
  function isOfficialRecord(r) {
    const m = matchForRecord(r);
    const competition = competitionOfRecord(r);
    return !!competition &&
      !NON_OFFICIAL_RE.test(competition) &&
      !NON_OFFICIAL_RE.test(String(m?.round || ''));
  }
  function recordWasTracked(r, p = playerForRecord(r)) {
    const membership = membershipAt(p, r?.ko);
    if (membership) return membership.tracked !== false;
    return isTrackedLeague(p?.league);
  }
  function upsertPlayerMatchStats(rows, sources) {
    D.playerMatchStats = D.playerMatchStats || [];
    for (const raw of rows || []) {
      let r = normalizeRecord(raw, sources);
      const p = playerForRecord(r);
      if (p) {
        ensurePlayerIdentity(p);
        const m = matchForRecord(r);
        r.playerId = p.playerId;
        r.playerName = r.playerName || p.name;
        r.player = r.player || p.name;
        r.match = r.match || m?.match || null;
        r.ko = r.ko || m?.ko || null;
        r.round = r.round || m?.round || null;
        r.club = clubForRecord(r, p);
        r.competition = competitionOfRecord(r);
        r.trackedAtMatch = recordWasTracked(r, p);
      }
      const i = D.playerMatchStats.findIndex(x =>
        (r.recordId && x.recordId === r.recordId) ||
        (x.matchId === r.matchId &&
          (x.playerId || x.player || x.playerName) === (r.playerId || r.player || r.playerName))
      );
      if (i >= 0) {
        const prev = D.playerMatchStats[i];
        const ratingInputs = mergeRatingInputs(prev.ratingInputs, r.ratingInputs);
        const missingFields = [...new Set([...(prev.missingFields || []), ...(r.missingFields || [])])]
          .filter(field => ratingInputs[field]?.state !== 'value');
        const merged = {
          ...prev,
          ...r,
          ratingInputs,
          missingFields,
          priorityFields: missingFields,
          priorityUpdate: missingFields.length > 0,
          providerIds: mergeProviderIds(prev.providerIds, r.providerIds),
          providerRatings: {
            ...(prev.providerRatings || {}),
            ...(r.providerRatings || {}),
          },
        };
        r = ratingInputsSignature(prev) !== ratingInputsSignature(merged)
          ? clearCachedRating(merged)
          : merged;
        D.playerMatchStats[i] = r;
      } else {
        D.playerMatchStats.push(r);
      }
    }
  }

  function mergeGA(rows) {
    D.gaResults = D.gaResults || [];
    for (const raw of rows || []) {
      const x = { ...raw };
      const p = (D.players || []).find(p =>
        (x.playerId && String(p.playerId) === String(x.playerId)) ||
        p.name === x.player
      );
      if (p) x.playerId = p.playerId;
      const i = D.gaResults.findIndex(y =>
        (x.matchId && y.matchId === x.matchId &&
          ((x.playerId && y.playerId === x.playerId) || y.player === x.player)) ||
        (y.player === x.player && y.ko === x.ko && y.match === x.match)
      );
      if (i < 0) D.gaResults.push(x);
      else D.gaResults[i] = { ...D.gaResults[i], ...x };
    }
  }
  function removeGA(rows) {
    if (!rows?.length || !D.gaResults) return;
    D.gaResults = D.gaResults.filter(y => !(rows || []).some(x =>
      (x.matchId && y.matchId === x.matchId && (!x.player || y.player === x.player)) ||
      (!x.matchId && x.player === y.player && x.ko === y.ko && (!x.match || x.match === y.match))
    ));
  }

  function valueOfRecord(r, field) {
    if (field === 'apps') {
      if (r?.appearance === true || String(r?.appearance || '').startsWith('starter') || String(r?.appearance || '').startsWith('sub_')) return 1;
      if (r?.appearance === false || String(r?.appearance || '').includes('bench_unused') || String(r?.appearance || '').includes('absent')) return 0;
      return null;
    }
    if (field === 'starts') {
      if (r?.start === true || String(r?.appearance || '').startsWith('starter')) return 1;
      if (r?.start === false || String(r?.appearance || '').startsWith('sub_') || String(r?.appearance || '').includes('bench_unused')) return 0;
      return null;
    }
    if (r?.ratingInputs?.[field]?.state === 'value') return Number(r.ratingInputs[field].value);
    if (r?.[field] !== undefined && r?.[field] !== null && Number.isFinite(Number(r[field]))) return Number(r[field]);
    return null;
  }
  function recordPlayerName(r) { return r?.playerName || r?.player || r?.name || null; }
  function recordBelongsToPlayer(r, p) {
    return (r.playerId && String(r.playerId) === String(p.playerId)) || recordPlayerName(r) === p.name;
  }
  function bucket() {
    return { values: {}, known: {}, hasData: false };
  }
  function addSegment(bucketValue, stats) {
    bucketValue.hasData = true;
    for (const field of AGG_FIELDS) {
      const value = stats?.[field];
      if (value != null && Number.isFinite(Number(value))) {
        if (bucketValue.known[field] !== false) {
          bucketValue.known[field] = true;
          bucketValue.values[field] = Number(bucketValue.values[field] || 0) + Number(value);
        }
      } else {
        bucketValue.known[field] = false;
      }
    }
  }
  function addRecord(bucketValue, r) {
    bucketValue.hasData = true;
    for (const field of AGG_FIELDS) {
      const value = valueOfRecord(r, field);
      if (value == null) {
        bucketValue.known[field] = false;
      } else if (bucketValue.known[field] !== false) {
        bucketValue.known[field] = true;
        bucketValue.values[field] = Number(bucketValue.values[field] || 0) + value;
      }
    }
  }
  function finalizeBucket(bucketValue) {
    if (!bucketValue?.hasData) return {};
    const out = {};
    for (const field of AGG_FIELDS) {
      if (bucketValue.known[field] === false) out[field] = null;
      else if (bucketValue.known[field] === true) out[field] = Number(bucketValue.values[field] || 0);
    }
    return out;
  }
  function ensureMapBucket(map, key) {
    if (!map.has(key)) map.set(key, bucket());
    return map.get(key);
  }
  function recordCoveredByBaseline(r, baseline) {
    if (!baseline) return false;
    const recordTime = timeKey(r.ko || matchForRecord(r)?.ko);
    const baselineTime = timeKey(baseline.updated);
    return !!recordTime && !!baselineTime && recordTime <= baselineTime;
  }

  function rebuildPlayerSeasonAggregates() {
    D.players = D.players || [];
    const records = D.playerMatchStats || [];

    for (const p of D.players) {
      ensurePlayerIdentity(p);

      if (!Object.keys(p._aggregateBaselines || {}).length && hasNumericStats(p._initialStats)) {
        ensureInitialBaseline(p, p.club, p.league, D.updated);
      }

      const seasonBucket = bucket();
      const competitionBuckets = new Map();
      const clubBuckets = new Map();
      const clubCompetitionBuckets = new Map();
      const baselineMap = new Map();

      for (const b of Object.values(p._aggregateBaselines || {})) {
        if (!b?.club || !b?.competition) continue;
        baselineMap.set(baselineKey(b.club, b.competition), b);
        addSegment(seasonBucket, b.stats || {});
        addSegment(ensureMapBucket(competitionBuckets, b.competition), b.stats || {});
        addSegment(ensureMapBucket(clubBuckets, b.club), b.stats || {});
        addSegment(ensureMapBucket(clubCompetitionBuckets, baselineKey(b.club, b.competition)), b.stats || {});
      }

      const mine = records
        .filter(r => recordBelongsToPlayer(r, p) && isOfficialRecord(r) && recordWasTracked(r, p))
        .sort((a, b) => String(a.ko || '').localeCompare(String(b.ko || '')));

      for (const r of mine) {
        const competition = competitionOfRecord(r) || 'その他公式戦';
        const club = clubForRecord(r, p) || '所属クラブ未取得';
        const baseline = baselineMap.get(baselineKey(club, competition));
        if (recordCoveredByBaseline(r, baseline)) continue;

        addRecord(seasonBucket, r);
        addRecord(ensureMapBucket(competitionBuckets, competition), r);
        addRecord(ensureMapBucket(clubBuckets, club), r);
        addRecord(ensureMapBucket(clubCompetitionBuckets, baselineKey(club, competition)), r);
      }

      p.seasonStats = finalizeBucket(seasonBucket);
      p.allCompetitionsStats = p.seasonStats;
      p.competitionStats = {};
      for (const [name, b] of competitionBuckets) p.competitionStats[name] = finalizeBucket(b);

      p.clubStats = {};
      for (const [club, b] of clubBuckets) p.clubStats[club] = finalizeBucket(b);

      p.clubCompetitionStats = {};
      for (const [key, b] of clubCompetitionBuckets) {
        const [club, competition] = key.split('|||');
        p.clubCompetitionStats[club] = p.clubCompetitionStats[club] || {};
        p.clubCompetitionStats[club][competition] = finalizeBucket(b);
      }

      p.stats = p.seasonStats;
      p.statsScope = 'tracked_official_season_total';
      p.statsTrackingState = p.trackingStatus === 'active' ? 'active' : 'frozen_out_of_scope';
      if (mine.length || Object.keys(p._aggregateBaselines || {}).length) {
        p.statsAsOf = `${p.statsAsOf || selectedSeason} / シーズン通算（クラブ別保持）`;
      }
    }
  }

  function competitionScopes() {
    const out = ['すべて'];
    for (const p of D.players || []) {
      for (const c of Object.keys(p.competitionStats || {})) if (c && !out.includes(c)) out.push(c);
    }
    return out;
  }
  function statsForScope(p, s) {
    if (s === 'すべて') return p.seasonStats || p.allCompetitionsStats || p.stats || {};
    return p.competitionStats?.[s] || {};
  }
  function statsForClub(p, club) {
    return p?.clubStats?.[club] || {};
  }
  function currentLeagueBucket(p) {
    return p?.trackingStatus === 'active' ? (p.league || 'リーグ未取得') : OUT_OF_SCOPE_BUCKET;
  }
  function currentTrackedPlayers() {
    return (D.players || []).filter(p => p.trackingStatus === 'active');
  }
  function matchesForClub(club) {
    const matchIds = new Set((D.playerMatchStats || [])
      .filter(r => clubForRecord(r, playerForRecord(r)) === club)
      .map(r => r.matchId)
      .filter(Boolean));
    return (D.matches || []).filter(m =>
      (m.matchId && matchIds.has(m.matchId)) ||
      String(m.match || '').includes(club)
    ).sort((a, b) => String(a.ko || '').localeCompare(String(b.ko || '')));
  }

  function installUiScopePolicy() {
    if (uiPolicyInstalled) return;
    uiPolicyInstalled = true;

    try {
      const i = order.indexOf('J1');
      if (i >= 0) order.splice(i, 1);
      if (!order.includes(OUT_OF_SCOPE_BUCKET)) order.push(OUT_OF_SCOPE_BUCKET);
    } catch {}

    try {
      clubPlayers = function(club) {
        return (D.players || []).filter(p => p.club === club && p.trackingStatus === 'active');
      };
      relevantClubMatches = matchesForClub;
      clubMatchCard = function(m, club) {
        const recs = (D.playerMatchStats || [])
          .filter(r => {
            const same = (r.matchId && m.matchId && r.matchId === m.matchId) ||
              (r.match === m.match) || (r.ko && r.ko === m.ko);
            return same && clubForRecord(r, playerForRecord(r)) === club;
          })
          .map(r => window.JFWRating ? JFWRating.withComputedRating(r) : r);
        const extra = recs.length
          ? `<div class="stats">${recs.map(r => `${E(r.player || r.playerName || '選手')}: ${Number.isFinite(Number(r.jfwRating)) ? 'JFW ' + Number(r.jfwRating).toFixed(1) : 'Rating未算出'} / ${fmt(r.minutes ?? r.ratingInputs?.minutes?.value)}分 / G ${fmt(r.goals ?? r.ratingInputs?.goals?.value)} A ${fmt(r.assists ?? r.ratingInputs?.assists?.value)}`).join('<br>')}</div>`
          : '';
        return mcard(m) + extra;
      };
    } catch (e) {
      console.warn('club transfer-safe patch failed', e);
    }

    try {
      leagues = function() {
        const present = [];
        for (const p of D.players || []) {
          const bucket = currentLeagueBucket(p);
          if (bucket && !present.includes(bucket)) present.push(bucket);
        }
        const out = ['すべて'];
        for (const x of order || []) if (x !== 'すべて' && present.includes(x) && !out.includes(x)) out.push(x);
        for (const x of present) if (!out.includes(x)) out.push(x);
        return out;
      };
      renderAttention = function() {
        btns(R.leagueBtns, leagues(), attLeague, x => { attLeague = x; renderAttention(); });
        const rows = (D.players || [])
          .filter(p => attLeague === 'すべて' || currentLeagueBucket(p) === attLeague)
          .sort((a, b) => (a.rank || 99) - (b.rank || 99));
        R.leagueTitle.textContent = attLeague === 'すべて' ? 'リーグ別 注目度ランキング' : attLeague + ' 注目度ランキング';
        R.players.innerHTML = rows.map(pcard).join('') || '<div class="empty">該当なし</div>';
        bindEntities(R.players);
      };
    } catch (e) {
      console.warn('tracking bucket patch failed', e);
    }

    try {
      playerRecordCard = function(r) {
        const rating = Number.isFinite(Number(r.jfwRating)) ? Number(r.jfwRating) : null;
        const mins = r.minutes ?? r.ratingInputs?.minutes?.value;
        const goals = r.goals ?? r.ratingInputs?.goals?.value;
        const assists = r.assists ?? r.ratingInputs?.assists?.value;
        const cov = r.ratingCoverage;
        const meta = [r.club, r.competition || r.league, r.round, r.ko].filter(Boolean).join(' ・ ');
        return `<div class="card">
          <div class="ratingRow"><div><div class="match">${E(r.match || r.opponent || '試合')}</div><div class="sub">${E(meta)}</div></div><div class="metricValue">${rating == null ? '—' : rating.toFixed(1)}</div></div>
          <div class="stats">${fmt(mins)}分 / G ${fmt(goals)} / A ${fmt(assists)}${cov != null ? ` / 充足率 ${Math.round(cov * 100)}%` : ''}</div>
          ${r.gaOnPitchAmbiguous ? '<span class="pill part">在場中失点の時系列に曖昧さあり</span>' : ''}
        </div>`;
      };
    } catch (e) {
      console.warn('player match provenance patch failed', e);
    }

    try {
      renderStats = function() {
        const scopes = competitionScopes();
        if (!scopes.includes(scope)) scope = 'すべて';
        btns(R.scopeBtns, scopes, scope, x => { scope = x; renderStats(); });
        R.metricBtns.innerHTML = Object.entries(metrics)
          .map(([k, v]) => `<button class="btn ${k === metric ? 'on' : ''}" data-k="${k}">${v}</button>`)
          .join('');
        R.metricBtns.querySelectorAll('button').forEach(b => b.onclick = () => {
          metric = b.dataset.k;
          renderStats();
        });
        const val = (p, k) => {
          const s = statsForScope(p, scope);
          if (k === 'ga') return s.goals == null || s.assists == null ? null : s.goals + s.assists;
          return s[k] ?? null;
        };
        const rows = (D.players || [])
          .filter(p => p.rankingEligible !== false)
          .filter(p => scope === 'すべて' || p.competitionStats?.[scope])
          .filter(p => eligible(p, metric))
          .map(p => [p, val(p, metric)])
          .filter(x => x[1] != null)
          .sort((a, b) => b[1] - a[1] || (b[0].rating || 0) - (a[0].rating || 0));

        R.statRank.innerHTML = rows.map(([p, v], i) =>
          `<div class="card clickable" data-open-player="${E(playerRef(p))}">
            <div class="row">
              <div class="rank">${i + 1}</div>
              <div class="grow">
                <div class="name">${E(p.name)}</div>
                <div class="sub"><span class="entityLink" data-open-club="${E(p.club)}">${E(p.club || '所属なし')}</span> ・ ${E(scope === 'すべて' ? 'シーズン通算' : scope)} ・ ${E(p.statsAsOf || '')}</div>
                ${p.trackingStatus !== 'active' ? `<span class="pill part">${E(OUT_OF_SCOPE_BUCKET)}・移籍時点まで</span>` : ''}
              </div>
              <div class="metricValue">${E(v)}</div>
            </div>
          </div>`
        ).join('') || '<div class="empty">この指標は現在取得できていません。</div>';
        bindEntities(R.statRank);
      };
    } catch (e) {
      console.warn('competition stats filter patch failed', e);
    }

    try {
      const baseRenderPlayerDetail = renderPlayerDetail;
      renderPlayerDetail = function() {
        baseRenderPlayerDetail();
        const p = playerByRef(activePlayer);
        if (!p || !R.playerDetail) return;

        const detailHead = R.playerDetail.querySelector('.detailHead');
        const identity = detailHead?.firstElementChild;
        if (identity && !identity.dataset?.playerProfilePhoto && typeof profilePhotoHtml === 'function') {
          identity.className = 'mdPlayerHero';
          identity.dataset.playerProfilePhoto = '1';
          identity.innerHTML = `${profilePhotoHtml(p)}<div>${identity.innerHTML}</div>`;
          try { window.bindJFWPhotos?.(identity); } catch {}
        }

        if (p.trackingStatus !== 'active' && !R.playerDetail.querySelector('[data-tracking-state-note]')) {
          const note = document.createElement('section');
          note.dataset.trackingStateNote = '1';
          note.innerHTML = `<div class="card part"><div class="name">${E(OUT_OF_SCOPE_BUCKET)}</div><div class="reason">現在の移籍先は追跡対象外です。選手レコードと今季の追跡済み個人成績は保持し、ランキングにも残します。移籍後の追跡対象外リーグの新規試合成績は自動加算しません。</div></div>`;
          const first = R.playerDetail.querySelector('section');
          first?.insertAdjacentElement('afterend', note);
        }

        if (!R.playerDetail.querySelector('[data-competition-breakdown]')) {
          const entries = Object.entries(p.competitionStats || {});
          if (entries.length) {
            const cards = entries.map(([name, s]) =>
              `<div class="card"><div class="name">${E(name)}</div><div class="stats">出場 ${fmt(s.apps)} / 先発 ${fmt(s.starts)} / G ${fmt(s.goals)} / A ${fmt(s.assists)} / 分 ${fmt(s.minutes)}</div></div>`
            ).join('');
            const sec = document.createElement('section');
            sec.dataset.competitionBreakdown = '1';
            sec.innerHTML = `<h2>大会別成績</h2><div class="lead">シーズン通算と大会別を分離。各記録は playerMatchStats の試合IDとの紐付けを維持します。</div><div class="grid">${cards}</div>`;
            const sections = R.playerDetail.querySelectorAll('section');
            if (sections[1]) sections[1].insertAdjacentElement('afterend', sec);
            else R.playerDetail.appendChild(sec);
          }
        }

        if (!R.playerDetail.querySelector('[data-club-breakdown]')) {
          const memberships = p.membershipHistory || [];
          if (memberships.length) {
            const cards = memberships.map((m, i) => {
              const s = statsForClub(p, m.club);
              const period = `${m.from || 'シーズン開始'} 〜 ${m.to || '現在'}`;
              const state = m.tracked === false ? '追跡対象外' : '追跡対象';
              return `<div class="card">
                <div class="name">${E(m.club || '所属なし')}</div>
                <div class="sub">${E(m.league || 'リーグ未取得')} ・ ${E(period)} ・ ${E(state)}</div>
                <div class="stats">出場 ${fmt(s.apps)} / 先発 ${fmt(s.starts)} / G ${fmt(s.goals)} / A ${fmt(s.assists)} / 分 ${fmt(s.minutes)}</div>
                ${i === memberships.length - 1 && p.previousClub ? `<div class="sourceNote">前所属: ${E(p.previousClub)}</div>` : ''}
              </div>`;
            }).join('');
            const sec = document.createElement('section');
            sec.dataset.clubBreakdown = '1';
            sec.innerHTML = `<h2>所属履歴・クラブ別成績</h2><div class="lead">移籍しても同じ playerId を継続し、旧所属クラブの成績を新所属クラブへ付け替えません。</div><div class="grid">${cards}</div>`;
            R.playerDetail.appendChild(sec);
          }
        }
      };
    } catch (e) {
      console.warn('player transfer history patch failed', e);
    }

    try {
      renderClubDetail = function() {
        const club = activeClub;
        const ps = clubPlayers(club);
        if (!ps.length) {
          R.clubDetail.innerHTML = '<section><div class="empty">現在このクラブに追跡対象の日本人選手はいません。</div></section>';
          return;
        }
        const matches = relevantClubMatches(club);
        const rounds = [...new Set(matches.map(m => roundNo(m.round)).filter(Number.isFinite))].sort((a, b) => a - b);
        if (clubRoundFrom == null) clubRoundFrom = rounds[0] ?? null;
        if (clubRoundTo == null) clubRoundTo = rounds.at(-1) ?? null;
        const filtered = matches.filter(m => {
          const r = roundNo(m.round);
          return r == null || (r >= clubRoundFrom && r <= clubRoundTo);
        });
        const knownSum = key => {
          const values = ps.map(p => statsForClub(p, club)?.[key]).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
          return values.length ? values.reduce((a, b) => a + b, 0) : null;
        };
        const g = knownSum('goals');
        const a = knownSum('assists');
        const league = ps[0]?.league || '';
        const opts = rounds.map(r => `<option value="${r}">第${r}節</option>`).join('');
        const playerCards = ps.map(p => {
          const clone = { ...p, stats: statsForClub(p, club), statsAsOf: `${club}在籍時` };
          return pcard(clone);
        }).join('');

        R.clubDetail.innerHTML = `<section>
          <div class="backRow"><button class="linkbtn" data-back>← 一覧へ戻る</button></div>
          <div class="detailHead"><div><div class="crumb">${E(league)} / ${E(selectedSeason)}</div><div class="detailTitle">${E(club)}</div><div class="sub">現在所属の追跡日本人 ${ps.length}人</div></div></div>
        </section>
        <section><h2>日本人選手サマリー</h2>
          <div class="summary">
            <div class="sum"><div class="num">${ps.length}</div><div class="muted">現在所属</div></div>
            <div class="sum"><div class="num">${g == null ? '—' : g}</div><div class="muted">このクラブでの今季得点</div></div>
            <div class="sum"><div class="num">${a == null ? '—' : a}</div><div class="muted">このクラブでの今季アシスト</div></div>
          </div>
          <div class="grid" style="margin-top:10px">${playerCards}</div>
        </section>
        <section>
          <div class="sectionTitleRow">
            <div><h2>節ごとの試合</h2><div class="lead">このクラブ所属時の playerMatchStats とクラブ名で紐付け。</div></div>
            ${rounds.length ? `<div class="rangeBox"><select id="clubRoundFrom" class="rangeSelect">${opts}</select><span class="muted">〜</span><select id="clubRoundTo" class="rangeSelect">${opts}</select></div>` : ''}
          </div>
          <div id="clubMatches" class="grid">${filtered.map(m => clubMatchCard(m, club)).join('') || '<div class="empty">該当する試合がありません。</div>'}</div>
        </section>`;

        const back = R.clubDetail.querySelector('[data-back]');
        if (back) back.onclick = () => { activeClub = null; clearDetailParams(); showPage(lastPage); };
        const f = $('clubRoundFrom'), t = $('clubRoundTo');
        if (f && t) {
          f.value = clubRoundFrom;
          t.value = clubRoundTo;
          const change = () => {
            clubRoundFrom = Number(f.value);
            clubRoundTo = Number(t.value);
            if (clubRoundFrom > clubRoundTo) [clubRoundFrom, clubRoundTo] = [clubRoundTo, clubRoundFrom];
            renderClubDetail();
          };
          f.onchange = change;
          t.onchange = change;
        }
        bindEntities(R.clubDetail);
        bindWatch(R.clubDetail, D.matches || []);
      };
    } catch (e) {
      console.warn('club detail stats patch failed', e);
    }
  }

  function applyFragments(parts) {
    initializePlayers();
    const sources = {};
    for (const p of parts) Object.assign(sources, p.sources || {});
    for (const p of parts) {
      mergeMatchUpdates(p.matchUpdates);
      mergePlayerUpdates(p.playerUpdates, p.updated);
      upsertPlayerMatchStats(p.playerMatchStats, sources);
      mergeGA(p.gaResultsAdd);
      removeGA(p.gaResultsRemove);
    }
    rebuildPlayerSeasonAggregates();
    installUiScopePolicy();
    const newest = parts.map(x => x.updated).filter(Boolean).sort().at(-1);
    if (newest) D.updated = newest;
    D._playerMatchBackfill = {
      season: selectedSeason,
      updated: newest,
      fragments: parts.length,
      records: (D.playerMatchStats || []).length,
      trackingModelVersion: '1.0'
    };
  }

  async function applyCurrentBackfill() {
    const season = String(selectedSeason || '');
    if (!season) return false;
    try {
      const base = `data/${encodeURIComponent(season)}/backfill/`;
      const manifest = await getJson(base + 'index.json');
      const parts = await Promise.all((manifest.fragments || []).map(f => getJson(base + f)));
      applyFragments(parts);
      try { R.updated.textContent = `${season} ・ 最終更新: ${D.updated || '未取得'}`; } catch {}
      return true;
    } catch (e) {
      if (!String(e).includes('404')) console.warn('player match backfill load failed', e);
      return false;
    }
  }

  async function refreshViews() {
    try { renderAll(); } catch {}
    try {
      if (page === 'player') renderPlayerDetail();
      if (page === 'club') renderClubDetail();
    } catch {}
    try {
      if (page === 'match' && window.renderMatchDetail) window.renderMatchDetail();
    } catch {}
  }

  async function boot() {
    if (loading) return loading;
    loading = (async () => {
      await applyCurrentBackfill();
      await refreshViews();
    })();
    await loading;
    loading = null;
  }

  const baseLoad = loadSeason;
  loadSeason = async function(id, opts = {}) {
    await baseLoad(id, opts);
    await applyCurrentBackfill();
    await refreshViews();
  };

  window.JFWTracking = {
    VERSION: '1.0',
    OUT_OF_SCOPE_BUCKET,
    stablePlayerId,
    isTrackedLeague,
    membershipAt,
    clubForRecord,
    competitionOfRecord,
    statsForScope,
    statsForClub,
    currentTrackedPlayers,
    matchesForClub,
    currentLeagueBucket,
    rebuildPlayerSeasonAggregates
  };
  window.JFWBackfill = {
    applyCurrentBackfill,
    boot,
    rebuildPlayerSeasonAggregates,
    competitionScopes,
    statsForScope
  };

  boot().finally(() => {
    if (document.querySelector('script[data-jfw-match-detail]')) return;
    const s = document.createElement('script');
    s.src = `match-detail.js?v=${Date.now()}`;
    s.dataset.jfwMatchDetail = '1';
    document.body.appendChild(s);
  });
})();
