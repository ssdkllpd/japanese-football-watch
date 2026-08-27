(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.JFWBackfillMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
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

  function openMembership(p) {
    return [...(p?.membershipHistory || [])].reverse().find(x => !x.to) || null;
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

  function statsForScope(p, scope) {
    if (scope === 'すべて') return p?.seasonStats || p?.allCompetitionsStats || p?.stats || {};
    return p?.competitionStats?.[scope] || {};
  }

  function statsForClub(p, club) {
    return p?.clubStats?.[club] || {};
  }

  function currentLeagueBucket(p) {
    return p?.trackingStatus === 'active' ? (p.league || 'リーグ未取得') : OUT_OF_SCOPE_BUCKET;
  }

  // The merge contract accepts JSON-loaded data only. JSON cloning deliberately
  // rejects circular values and does not preserve Date, undefined, NaN or Infinity.
  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createRuntime(D, selectedSeason) {
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
        const match = matchFinder(D.matches, u);
        if (match) Object.assign(match, clean);
        else if (u.addIfMissing !== false) D.matches.push({ ...clean });

        const top = matchFinder(D.topMatches, u);
        if (top) Object.assign(top, clean);
        else if (u.addToTopMatches) D.topMatches.push({ ...clean });
      }
    }

    function hasNumericStats(stats) {
      return !!stats && Object.values(stats).some(v => v != null && Number.isFinite(Number(v)));
    }

    function baselineKey(club, competition) {
      return `${String(club || '')}|||${String(competition || '')}`;
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
      if (!p._aggregateBaselines?.[key]) {
        saveBaseline(p, club, competition, p._initialStats, p._initialStatsUpdated || updated, p.statsAsOf);
      }
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
        if (incomingStats) {
          saveBaseline(p, p.club, p.league, incomingStats, u.statsAsOfDate || u.aggregateAsOf || fragmentUpdated, u.statsAsOf);
        }
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
        for (const field of DISC) {
          if (!inputs[field]) inputs[field] = { state: 'value', value: 0, sourceId: defaultSource };
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
      try {
        const entries = Object.entries(record?.ratingInputs || {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([field, input]) => [
            field,
            Object.entries(input || {}).sort(([left], [right]) => left.localeCompare(right))
          ]);
        return JSON.stringify(entries);
      } catch {
        return '';
      }
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
      const match = matchForRecord(r);
      return String(r?.competition || r?.league || match?.league || '');
    }

    function clubForRecord(r, p = playerForRecord(r)) {
      if (r?.club) return r.club;
      return membershipAt(p, r?.ko)?.club || p?.club || null;
    }

    function isOfficialRecord(r) {
      const match = matchForRecord(r);
      const competition = competitionOfRecord(r);
      return !!competition &&
        !NON_OFFICIAL_RE.test(competition) &&
        !NON_OFFICIAL_RE.test(String(match?.round || ''));
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
          const match = matchForRecord(r);
          r.playerId = p.playerId;
          r.playerName = r.playerName || p.name;
          r.player = r.player || p.name;
          r.match = r.match || match?.match || null;
          r.ko = r.ko || match?.ko || null;
          r.round = r.round || match?.round || null;
          r.club = clubForRecord(r, p);
          r.competition = competitionOfRecord(r);
          r.trackedAtMatch = recordWasTracked(r, p);
        }
        const index = D.playerMatchStats.findIndex(x =>
          (r.recordId && x.recordId === r.recordId) ||
          (x.matchId === r.matchId &&
            (x.playerId || x.player || x.playerName) === (r.playerId || r.player || r.playerName))
        );
        if (index >= 0) {
          const previous = D.playerMatchStats[index];
          const ratingInputs = mergeRatingInputs(previous.ratingInputs, r.ratingInputs);
          const missingFields = [...new Set([...(previous.missingFields || []), ...(r.missingFields || [])])]
            .filter(field => ratingInputs[field]?.state !== 'value');
          const merged = {
            ...previous,
            ...r,
            ratingInputs,
            missingFields,
            priorityFields: missingFields,
            priorityUpdate: missingFields.length > 0,
            providerIds: mergeProviderIds(previous.providerIds, r.providerIds),
            providerRatings: {
              ...(previous.providerRatings || {}),
              ...(r.providerRatings || {})
            }
          };
          const inputsChanged = ratingInputsSignature(previous) !== ratingInputsSignature(merged);
          const incomingCarriesRating = Object.prototype.hasOwnProperty.call(r, 'jfwRating')
            && ratingInputsSignature(merged) === ratingInputsSignature(r);
          r = inputsChanged && !incomingCarriesRating
            ? clearCachedRating(merged)
            : merged;
          D.playerMatchStats[index] = r;
        } else {
          D.playerMatchStats.push(r);
        }
      }
    }

    function mergeGA(rows) {
      D.gaResults = D.gaResults || [];
      for (const raw of rows || []) {
        const item = { ...raw };
        const p = (D.players || []).find(player =>
          (item.playerId && String(player.playerId) === String(item.playerId)) ||
          player.name === item.player
        );
        if (p) item.playerId = p.playerId;
        const index = D.gaResults.findIndex(existing =>
          (item.matchId && existing.matchId === item.matchId &&
            ((item.playerId && existing.playerId === item.playerId) || existing.player === item.player)) ||
          (existing.player === item.player && existing.ko === item.ko && existing.match === item.match)
        );
        if (index < 0) D.gaResults.push(item);
        else D.gaResults[index] = { ...D.gaResults[index], ...item };
      }
    }

    function removeGA(rows) {
      if (!rows?.length || !D.gaResults) return;
      D.gaResults = D.gaResults.filter(existing => !(rows || []).some(item =>
        (item.matchId && existing.matchId === item.matchId && (!item.player || existing.player === item.player)) ||
        (!item.matchId && item.player === existing.player && item.ko === existing.ko && (!item.match || item.match === existing.match))
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

        for (const baseline of Object.values(p._aggregateBaselines || {})) {
          if (!baseline?.club || !baseline?.competition) continue;
          baselineMap.set(baselineKey(baseline.club, baseline.competition), baseline);
          addSegment(seasonBucket, baseline.stats || {});
          addSegment(ensureMapBucket(competitionBuckets, baseline.competition), baseline.stats || {});
          addSegment(ensureMapBucket(clubBuckets, baseline.club), baseline.stats || {});
          addSegment(ensureMapBucket(clubCompetitionBuckets, baselineKey(baseline.club, baseline.competition)), baseline.stats || {});
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
        for (const [name, value] of competitionBuckets) p.competitionStats[name] = finalizeBucket(value);

        p.clubStats = {};
        for (const [club, value] of clubBuckets) p.clubStats[club] = finalizeBucket(value);

        p.clubCompetitionStats = {};
        for (const [key, value] of clubCompetitionBuckets) {
          const [club, competition] = key.split('|||');
          p.clubCompetitionStats[club] = p.clubCompetitionStats[club] || {};
          p.clubCompetitionStats[club][competition] = finalizeBucket(value);
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
        for (const competition of Object.keys(p.competitionStats || {})) {
          if (competition && !out.includes(competition)) out.push(competition);
        }
      }
      return out;
    }

    function currentTrackedPlayers() {
      return (D.players || []).filter(p => p.trackingStatus === 'active');
    }

    function matchesForClub(club) {
      const matchIds = new Set((D.playerMatchStats || [])
        .filter(r => clubForRecord(r, playerForRecord(r)) === club)
        .map(r => r.matchId)
        .filter(Boolean));
      return (D.matches || []).filter(match =>
        (match.matchId && matchIds.has(match.matchId)) ||
        String(match.match || '').includes(club)
      ).sort((a, b) => String(a.ko || '').localeCompare(String(b.ko || '')));
    }

    function applyFragments(parts) {
      initializePlayers();
      const sources = {};
      // Source definitions are resolved for the whole ordered manifest before any
      // records are normalized. Reusing an id is a correction: the later fragment
      // wins and therefore applies retroactively to every record with that id.
      for (const part of parts) Object.assign(sources, part.sources || {});
      for (const part of parts) {
        mergeMatchUpdates(part.matchUpdates);
        mergePlayerUpdates(part.playerUpdates, part.updated);
        upsertPlayerMatchStats(part.playerMatchStats, sources);
        mergeGA(part.gaResultsAdd);
        removeGA(part.gaResultsRemove);
      }
      rebuildPlayerSeasonAggregates();
      const newest = parts.map(item => item.updated).filter(Boolean).sort().at(-1);
      if (newest) D.updated = newest;
      D._playerMatchBackfill = {
        season: selectedSeason,
        updated: newest,
        fragments: parts.length,
        records: (D.playerMatchStats || []).length,
        trackingModelVersion: '1.0'
      };
    }

    return {
      applyFragments,
      rebuildPlayerSeasonAggregates,
      competitionScopes,
      currentTrackedPlayers,
      matchesForClub,
      membershipAt,
      playerForRecord,
      clubForRecord,
      competitionOfRecord
    };
  }

  function normalizeOptions(options) {
    return { season: String(options?.season || '') };
  }

  function mergeBackfillData(baseData, fragments, options = {}) {
    if (!baseData || typeof baseData !== 'object' || Array.isArray(baseData)) {
      throw new TypeError('baseData must be an object');
    }
    if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');
    const data = cloneJson(baseData);
    const parts = cloneJson(fragments);
    const { season } = normalizeOptions(options);
    createRuntime(data, season).applyFragments(parts);
    return data;
  }

  function rebuildAggregates(baseData, options = {}) {
    if (!baseData || typeof baseData !== 'object' || Array.isArray(baseData)) {
      throw new TypeError('baseData must be an object');
    }
    const data = cloneJson(baseData);
    const { season } = normalizeOptions(options);
    createRuntime(data, season).rebuildPlayerSeasonAggregates();
    return data;
  }

  function trackingApi(data, options = {}) {
    const { season } = normalizeOptions(options);
    const runtime = createRuntime(data || {}, season);
    return {
      membershipAt,
      playerForRecord: runtime.playerForRecord,
      clubForRecord: runtime.clubForRecord,
      competitionOfRecord: runtime.competitionOfRecord,
      competitionScopes: runtime.competitionScopes,
      currentTrackedPlayers: runtime.currentTrackedPlayers,
      matchesForClub: runtime.matchesForClub
    };
  }

  return {
    VERSION: '1.0',
    OUT_OF_SCOPE_BUCKET,
    mergeBackfillData,
    rebuildAggregates,
    trackingApi,
    stablePlayerId,
    isTrackedLeague,
    membershipAt,
    statsForScope,
    statsForClub,
    currentLeagueBucket
  };
});
