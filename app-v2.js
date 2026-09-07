(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const main = $('appMain');
  const title = $('pageTitle');
  const eyebrow = $('pageEyebrow');
  const dataMode = $('dataMode');
  const searchButton = $('searchButton');
  const themeButton = $('themeButton');
  const router = window.FootballV2Router;
  const data = window.FootballV2Data;
  const config = window.FOOTBALL_V2_CONFIG || {};
  const navigation = window.FootballV2History();
  const knownTeams = new Map();
  const knownFixtures = new Map();
  const knownStandings = new Map();
  const knownPlayers = new Map();
  const knownCompetitions = new Map();
  const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT']);
  const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);
  const PAGE_TITLES = {
    matches: ['Football Companion', '試合'],
    leagues: ['大会を探す', 'リーグ'],
    following: ['自分用フィード', 'フォロー中'],
    japanese: ['オプション', '日本人'],
    more: ['設定・データ', 'その他'],
  };

  const state = {
    page: 'matches',
    date: todayJst(),
    matchFilter: 'all',
    detail: null,
    detailTab: 'overview',
    ratingMode: 'provider',
    ratingPlayerId: null,
    fixtureReturn: 'matches',
    competitionDetail: null,
    legacy: null,
    legacySearch: '',
    fixtures: [],
    source: 'loading',
    workerBase: readWorkerBase(),
    follows: readFollows(),
    loading: false,
    matchLoadSequence: 0,
    competitionLoadSequence: 0,
    routeError: null,
    searchQuery: '',
    searchReturnPage: 'matches',
    route: null,
    japaneseCompetition: 'all',
    attention: { presence: 'not_fetched', snapshot: null, season: null, loading: false, error: null },
  };

  function setRoute(hash, options = {}) {
    navigation.go(hash, options);
    lastAppliedEntry = '';
  }
  function goBack(parentHash) {
    navigation.back(parentHash, applyCurrentRoute);
  }
  function rememberFixtures(fixtures) {
    for (const row of fixtures) {
      row.fixtureId ||= row.id;
      if (row.fixtureId) knownFixtures.set(row.fixtureId,row);
      for (const team of [row.teams?.home, row.teams?.away]) if (team?.id) knownTeams.set(team.id, team);
    }
  }
  function repaint() {
    const route = router.parseHash(location.hash, { date: state.date });
    if (route.kind === 'fixture' && state.detail) renderFixtureDetail();
    else if (route.kind === 'competition' && state.competitionDetail) renderCompetitionDetail();
    else if (route.kind === 'team') renderTeamDetail(route.entityId, route.productSeason);
    else if (route.kind === 'player') renderPlayerDetail(route.entityId, route.productSeason);
    else if (route.kind === 'search') renderSearch();
    else renderCurrentPage();
  }

  function matchRouteHash() {
    return router.matchesHash(state.date, state.matchFilter);
  }

  function errorNotice(error) {
    const code = error.code || '';
    const message = error.status === 429 ? 'アクセスが集中しています。しばらく待ってから再試行してください。'
      : error.status === 409 ? (code === 'archive_pending' ? '過去のデータを準備中です。' : code === 'attention_cursor_expired' ? 'データが更新されました。再取得してください。' : 'データ確認中です。しばらく待ってから再試行してください。')
      : error.status === 404 ? '指定されたデータが見つかりません。'
      : error.status === 400 ? '指定されたシーズンは利用できません。'
      : 'データは未取得です。接続後に再試行してください。';
    return `<div class="notice" role="status">${message}<button type="button" class="plain-button" data-retry>再試行</button>${error.status === 404 ? '<button type="button" class="plain-button" data-open-search>検索を開く</button>' : ''}</div>`;
  }
  function icon(name, filled = false) {
    const shapes = {
      follow: '<path d="M12 3.2 14.7 9l6.3.9-4.6 4.4 1.1 6.2L12 17.6 6.5 20.5l1.1-6.2L3 9.9 9.3 9z"/>',
      'live-dot': '<circle cx="12" cy="12" r="5"/>',
      estimated: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>',
      'missing-photo': '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.6" stroke-width="1.6"/><circle cx="9" cy="10.4" r="1.7" fill="currentColor"/><path d="M4.6 17.4 8.9 13l3 3 2.5-2.5 5 5" stroke-width="1.6" stroke-linejoin="round"/>',
      'tracked-mark': '<circle cx="12" cy="12" r="8.2" stroke-width="1.7"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
      search: '<circle cx="10.6" cy="10.6" r="6.1" stroke-width="1.9"/><path d="M15.1 15.1 20 20" stroke-width="1.9" stroke-linecap="round"/>'
    };
    return `<svg class="ui-icon icon-${name}" viewBox="0 0 24 24" width="24" height="24" fill="${filled || name === 'live-dot' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${shapes[name] || ''}</svg>`;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[char]));
  }

  function readWorkerBase() {
    const configured = String(window.FOOTBALL_V2_API_BASE || config.apiBase || '').trim();
    const localPreview = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
    const override = localPreview ? (new URL(location.href).searchParams.get('api') || localStorage.getItem('football-v2-api-base') || localStorage.getItem('jfw-v2-api-base')) : null;
    if (override) {
      try {
        const url = new URL(override);
        if ((config.previewOrigins || []).includes(url.origin) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) return url.origin;
      } catch { /* Ignore invalid preview configuration. */ }
    }
    return configured.replace(/\/+$/, '');
  }

  function readFollows() {
    try {
      const raw = JSON.parse(localStorage.getItem('football-v2-follows') || '{}');
      const migrated = Object.fromEntries(['competitions','teams','players'].map(type => [type,
        [...new Set((Array.isArray(raw[type]) ? raw[type] : []).map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id))]
      ]));
      localStorage.setItem('football-v2-follows', JSON.stringify(migrated));
      return Object.fromEntries(Object.entries(migrated).map(([type, ids]) => [type, ids.map(id => ({ id }))]));
    } catch { return { competitions: [], teams: [], players: [] }; }
  }

  function saveFollows() {
    localStorage.setItem('football-v2-follows', JSON.stringify(Object.fromEntries(Object.entries(state.follows).map(([type, items]) => [type, items.map(item => item.id)]))));
  }

  function todayJst() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function shiftDate(date, days) {
    const base = new Date(`${date}T12:00:00+09:00`);
    base.setUTCDate(base.getUTCDate() + days);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(base);
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function dateParts(date) {
    const parsed = new Date(`${date}T12:00:00+09:00`);
    return {
      dow: new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' }).format(parsed),
      day: new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', day: 'numeric' }).format(parsed),
    };
  }

  function formatKickoff(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function statusShort(row) {
    return String(row?.status?.short || row?.ingestionState || '').toUpperCase();
  }

  function isLive(row) {
    return LIVE_STATUSES.has(statusShort(row));
  }

  function isFinal(row) {
    return !isCancelled(row) && statusShort(row) !== 'PST' && (FINAL_STATUSES.has(statusShort(row)) || ['FINALIZED', 'PROVISIONAL_FINAL'].includes(String(row?.ingestionState || '').toUpperCase()));
  }

  function isCancelled(row) {
    return ['CANC', 'ABD', 'AWD', 'WO'].includes(statusShort(row));
  }

  async function apiFetch(path) {
    if (!state.workerBase) throw Object.assign(new Error('not_fetched'), { code: 'not_fetched' });
    const response = await fetch(`${state.workerBase}${path}`, { headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error?.message || body?.error || `HTTP ${response.status}`), { status: response.status, code: body?.code || body?.error?.code || body?.error, availableSeasons: body?.availableSeasons, retryAfter: response.headers?.get('retry-after') });
    return body;
  }

  async function loadLegacy() {
    if (state.legacy) return state.legacy;
    try {
      const loader = window.JFWV2BackfillData;
      const mergeBackfillData = window.JFWBackfillMerge?.mergeBackfillData;
      if (!loader?.loadCurrentMergedData) throw new Error('v2 backfill data adapter が読み込まれていません');
      state.legacy = await loader.loadCurrentMergedData({ mergeBackfillData });
    } catch (error) {
      state.legacy = {
        players: [], matches: [], topMatches: [], dataCoverage: [],
        _dataIntegrity: {
          degraded: true,
          season: null,
          errors: [String(error?.message || error || 'v2 backfill load failed')],
        },
      };
    }
    return state.legacy;
  }

  function dataIntegrityNotice() {
    const integrity = state.legacy?._dataIntegrity;
    if (!integrity?.degraded) return '';
    return '<div class="notice"><strong>追跡データの整合性警告</strong><br>追跡データの一部を読み込めませんでした。表示内容が不完全な可能性があります。</div>';
  }

  function parseLegacyMatch(item, index) {
    const text = String(item?.match || '').trim();
    const match = text.match(/^(.*?)\s+(\d+)\s*[-–]\s*(\d+)\s+(.*?)$/);
    const ko = String(item?.ko || '');
    const date = /^\d{4}-\d{2}-\d{2}/.test(ko) ? ko.slice(0, 10) : null;
    const time = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(ko) ? ko.slice(11, 16) : '—';
    return {
      fixtureId: `legacy:${item?.rank || index + 1}:${date || 'unknown'}`,
      competitionId: `legacy:competition:${item?.league || 'unknown'}`,
      competitionName: item?.league || '大会未取得',
      kickoffDisplay: time,
      dateJst: date,
      status: { short: item?.status === 'verified' ? 'FT' : null },
      ingestionState: item?.status === 'verified' ? 'finalized' : 'legacy_unverified',
      teams: {
        home: { id: null, name: match?.[1] || text || 'Home', logo: null },
        away: { id: null, name: match?.[4] || 'Away', logo: null },
      },
      score: { goals: { home: match ? Number(match[2]) : null, away: match ? Number(match[3]) : null } },
      watch: item.watch || null,
      legacy: item,
    };
  }

  function legacyFixturesForDate(legacy, date) {
    return (legacy.topMatches || [])
      .map(parseLegacyMatch)
      .filter(row => row.dateJst === date);
  }

  function normalizeLive(row) {
    return {
      fixtureId: row.fixtureId,
      competitionId: row.competitionId,
      seasonId: row.seasonId,
      kickoffUtc: row.kickoffUtc,
      dateJst: row.dateJst,
      status: row.status || {},
      ingestionState: 'live',
      teams: {
        home: { id: row?.home?.teamId, name: row?.home?.name, logo: row?.home?.logo },
        away: { id: row?.away?.teamId, name: row?.away?.name, logo: row?.away?.logo },
      },
      score: { goals: { home: row?.home?.score ?? null, away: row?.away?.score ?? null } },
    };
  }

  function renderMatchesIfVisible() {
    const route = router.parseHash(location.hash, { date: state.date });
    if (route.kind === 'matches') renderMatches();
    if (route.kind === 'competitions') renderLeagues();
    if (route.kind === 'team') renderTeamDetail(route.entityId, route.productSeason);
    if (route.kind === 'following') renderFollowing();
  }

  async function loadMatches() {
    const loadSequence = ++state.matchLoadSequence;
    const requestedDate = state.date;
    state.loading = true;
    renderMatchesIfVisible();
    const legacy = await loadLegacy();
    const legacyRows = legacyFixturesForDate(legacy, requestedDate);
    let fixtures;
    let source;
    if (state.workerBase) {
      try {
        const [index, live] = await Promise.all([
          apiFetch(`/api/v2/dates/${encodeURIComponent(requestedDate)}`).catch(error => {
            throw error;
          }),
          requestedDate === todayJst() ? apiFetch('/api/v2/live').catch(() => ({ fixtures: [] })) : Promise.resolve({ fixtures: [] }),
        ]);
        if (!Array.isArray(index?.fixtures)) throw new Error('invalid_date_index');
        const baseRows = index.fixtures;
        const liveRows = (Array.isArray(live?.fixtures) ? live.fixtures : []).map(normalizeLive);
        const merged = new Map(baseRows.map(row => [row.fixtureId || row.id, { ...row, fixtureId: row.fixtureId || row.id }]));
        for (const row of liveRows) if (row.dateJst === requestedDate) merged.set(row.fixtureId, { ...(merged.get(row.fixtureId) || {}), ...row });
        fixtures = [...merged.values()].sort((a, b) => String(a.kickoffUtc || '').localeCompare(String(b.kickoffUtc || '')));
        source = 'core';
      } catch (error) {
        fixtures = legacyRows;
        source = `fallback:${error.message}`;
      }
    } else {
      fixtures = legacyRows;
      source = 'legacy';
    }
    if (loadSequence !== state.matchLoadSequence) return;
    rememberFixtures(fixtures);
    state.fixtures = fixtures;
    state.source = source;
    state.loading = false;
    renderMatchesIfVisible();
  }

  function renderDateStrip() {
    return `<div class="date-strip">${[-2, -1, 0, 1, 2].map(offset => {
      const date = shiftDate(state.date, offset);
      const parts = dateParts(date);
      return `<button class="date-button${offset === 0 ? ' is-active' : ''}" data-date="${date}" type="button" aria-label="${esc(date)}の試合"><span class="dow">${esc(date === todayJst() ? '今日' : parts.dow)}</span><span class="day">${esc(parts.day)}</span></button>`;
    }).join('')}</div>`;
  }

  function fixtureIsFollowed(row) {
    const competitionIds = new Set(state.follows.competitions.map(item => String(item.id)));
    const teamIds = new Set(state.follows.teams.map(item => String(item.id)));
    return competitionIds.has(String(row.competitionId))
      || teamIds.has(String(row?.teams?.home?.id))
      || teamIds.has(String(row?.teams?.away?.id));
  }

  function fixtureHasTrackedJapanese(row) {
    return data.trackedFixture(row, state.legacy?.trackingPeriods, config.scope) === true;
  }

  function filteredFixtures() {
    if (state.matchFilter === 'live') return state.fixtures.filter(isLive);
    if (state.matchFilter === 'following') return state.fixtures.filter(fixtureIsFollowed);
    if (state.matchFilter === 'japanese') return state.fixtures.filter(fixtureHasTrackedJapanese);
    return state.fixtures;
  }

  function fixtureTeam(team, score) {
    const logo = team?.logo ? `<img class="team-logo" src="${esc(team.logo)}" alt="" loading="lazy">` : '<span></span>';
    return `<div class="team-line">${logo}<span class="team-name">${esc(team?.name || team?.id || '未取得')}</span><span class="team-score">${valueCell(score)}</span></div>`;
  }

  function fixtureRow(row) {
    const short = statusShort(row);
    const time = isLive(row) ? `<span class="live-time">${esc(row?.status?.elapsed ? `${row.status.elapsed}′` : short || 'LIVE')}</span>` : (row.kickoffDisplay || formatKickoff(row.kickoffUtc));
    const status = isLive(row) ? short || 'LIVE' : (isFinal(row) ? '終了' : (isCancelled(row) ? '中止' : short === 'PST' ? '延期' : short || '予定'));
    return `<article class="fixture-row" role="button" tabindex="0" data-fixture="${esc(row.fixtureId)}">
      <div class="fixture-time">${time}</div>
      <div class="teams">
        ${fixtureTeam(row?.teams?.home, row?.score?.goals?.home)}
        ${fixtureTeam(row?.teams?.away, row?.score?.goals?.away)}
        ${watchLabel(row)}
      </div>
      <span class="status-pill${isLive(row) ? ' is-live' : ''}${isFinal(row) ? ' is-final' : ''}${isCancelled(row) ? ' is-cancelled' : ''}">${esc(status)}</span>
    </article>`;
  }

  function competitionKey(row) {
    return row.competitionName || row?.competition?.name || '大会未取得';
  }

  function groupFixtures(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = row.competitionId || competitionKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const followIds = new Set(state.follows.competitions.map(item => item.id));
    return [...groups.entries()].sort((a, b) => {
      const aId = a[1][0]?.competitionId;
      const bId = b[1][0]?.competitionId;
      return Number(followIds.has(bId)) - Number(followIds.has(aId)) || a[0].localeCompare(b[0], 'ja');
    }).map(([,rows]) => [competitionKey(rows[0]),rows]);
  }

  function renderMatches() {
    setPageHeader('matches');
    const rows = filteredFixtures();
    const sourceNote = state.source === 'core' ? '' : `<div class="notice">試合データに接続できていないため、取得済みの移行データを表示しています。</div>`;
    const integrityNote = state.source === 'core' ? '' : dataIntegrityNotice();
    const personalNote = ['following', 'japanese'].includes(state.matchFilter)
      ? '<div class="notice">この絞り込みは端末内のフォロー状態・追跡データに依存するため、同じURLでも端末によって結果が変わることがあります。</div>'
      : '';
    const filters = [
      ['all', 'すべて'],
      ['live', `${icon('live-dot')} LIVE`],
      ['following', 'フォロー中'],
      ['japanese', '日本人'],
    ];
    main.innerHTML = `
      <div class="control-row" aria-label="試合の絞り込み">${filters.map(([filter, label]) => `<button class="chip${filter === 'live' ? ' live' : ''}${state.matchFilter === filter ? ' is-active' : ''}" data-match-filter="${filter}" type="button" aria-pressed="${state.matchFilter === filter}">${label}</button>`).join('')}<button id="todayButton" class="chip${state.date === todayJst() ? ' is-active' : ''}" type="button">今日へ移動</button></div>
      ${renderDateStrip()}
      ${personalNote}
      ${sourceNote}
      ${integrityNote}
      ${state.loading ? '<div class="notice">試合データを読み込み中…</div>' : ''}
      <div id="fixtureGroups">${renderFixtureGroups(rows)}</div>`;
    main.querySelectorAll('[data-match-filter]').forEach(button => button.addEventListener('click', () => {
      state.matchFilter = button.dataset.matchFilter;
      setRoute(matchRouteHash());
      renderMatches();
    }));
    $('todayButton').addEventListener('click', () => { state.date = todayJst(); setRoute(matchRouteHash()); loadMatches(); });
    main.querySelectorAll('[data-date]').forEach(button => button.addEventListener('click', () => { state.date = button.dataset.date; setRoute(matchRouteHash()); loadMatches(); }));
    bindFixtureRows();
    updateDataMode();
  }

  function renderFixtureGroups(rows) {
    if (!rows.length) {
      const messages = {
        live: '現在進行中として取得できた試合はありません。',
        following: 'この日にフォロー中の大会・クラブの試合はありません。',
        japanese: Array.isArray(state.legacy?.trackingPeriods) ? 'この日に取得できた対象試合はありません。' : '追跡期間とクラブの対応データは未取得です。対象試合の有無はまだ判断できません。',
        all: state.source === 'core' && !state.loading ? '該当なし。この日の取得済み試合は0件です。' : 'この日付の試合データはまだ取得されていません。',
      };
      const message = messages[state.matchFilter] || messages.all;
      return `<div class="empty-state"><strong>表示できる試合がありません</strong>${message}</div>`;
    }
    return groupFixtures(rows).map(([name, fixtures]) => {
      const sample = fixtures[0] || {};
      const logo = sample?.competition?.logo ? `<img class="competition-logo" src="${esc(sample.competition.logo)}" alt="">` : '';
      return `<section class="section"><div class="section-title"><h2>${logo}${esc(name)}</h2><span class="meta">${fixtures.length}試合</span></div><div class="match-card">${fixtures.map(fixtureRow).join('')}</div></section>`;
    }).join('');
  }

  function bindFixtureRows(returnView = 'matches') {
    main.querySelectorAll('[data-fixture]').forEach(row => {
      row.addEventListener('click', () => openFixture(row.dataset.fixture, returnView));
      row.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); row.click(); } });
    });
  }

  async function openFixture(fixtureId, returnView = 'matches', options = {}) {
    const competitionFixtures = state.competitionDetail?.fixtures || [];
    const summary = [...competitionFixtures, ...state.fixtures].find(row => row.fixtureId === fixtureId) || null;
    state.fixtureReturn = returnView;
    const detailRequest = { summary, bundle: null, loading: true, error: null };
    state.detail = detailRequest;
    state.detailTab = options.tab || 'overview';
    state.ratingMode = options.ratingMode || 'provider';
    state.ratingPlayerId = options.playerId || null;
    if (!options.routeDriven) {

      setRoute(router.fixtureHash(fixtureId, {
        tab: state.detailTab,
        ratingMode: state.ratingMode,
        playerId: state.ratingPlayerId,
      }));
    }
    renderFixtureDetail();
    if (String(fixtureId).startsWith('legacy:')) {
      detailRequest.loading = false;
      renderFixtureDetail();
      return;
    }
    try {
      const bundle = await apiFetch(`/api/v2/fixtures/${encodeURIComponent(fixtureId)}`);
      if (state.detail !== detailRequest) return;
      detailRequest.bundle = bundle;
      rememberFixtures(bundle.fixture ? [bundle.fixture] : []);
      for (const lineup of bundle.lineups || []) for (const player of [...(lineup.startXI || []), ...(lineup.substitutes || [])]) if (player.id) knownPlayers.set(player.id,{playerId:player.id,name:player.name,photo:player.photo,pos:player.position});
      for (const row of bundle.playerStats || []) if (row.playerId) knownPlayers.set(row.playerId, { playerId: row.playerId, name: row.playerName, photo: row.playerPhoto, pos: row.position });
    } catch (error) {
      if (state.detail !== detailRequest) return;
      detailRequest.error = error;
    }
    if (state.detail !== detailRequest) return;
    detailRequest.loading = false;
    renderFixtureDetail();
  }

  function renderFixtureDetail() {
    eyebrow.textContent = '試合詳細';
    title.textContent = '試合';
    const detail = state.detail || {};
    const bundle = detail.bundle || {};
    const row = bundle.fixture || detail.summary || {};
    const home = row?.teams?.home || {};
    const away = row?.teams?.away || {};
    const comp = bundle?.competition?.name || detail.summary?.competitionName || detail.summary?.competitionId || '大会未取得';
    const homeLogo = home.logo ? `<img src="${esc(home.logo)}" alt="">` : '';
    const awayLogo = away.logo ? `<img src="${esc(away.logo)}" alt="">` : '';
    const returnToCompetition = state.fixtureReturn === 'competition' && state.competitionDetail;
    const returnLabel = returnToCompetition ? 'リーグ' : state.fixtureReturn === 'team' ? 'クラブ' : '試合一覧';
    const tabs = [
      ['overview', '概要'],
      ['lineup', 'ラインナップ'],
      ['events', 'イベント'],
      ['stats', 'スタッツ'],
      ['ratings', '選手評価'],
    ];
    main.innerHTML = `<div class="detail-top"><button id="detailBack" class="back-button" type="button">← ${returnLabel}</button><span class="status-pill${isLive(row) ? ' is-live' : ''}${isFinal(row) ? ' is-final' : ''}${isCancelled(row) ? ' is-cancelled' : ''}">${esc(statusShort(row) || row.ingestionState || '—')}</span></div>
      <section class="detail-card score-hero"><div class="score-meta">${esc(comp)} · ${esc(row.round || '節は未取得')} · ${esc(row.dateJst || '日付は未取得')} ${esc(formatKickoff(row.kickoffUtc))} JST</div><div class="score-grid"><div class="score-team">${homeLogo}<strong>${esc(home.name || 'Home')}</strong>${followTeamButton(home)}</div><div class="score-value">${valueCell(row?.score?.goals?.home)} - ${valueCell(row?.score?.goals?.away)}</div><div class="score-team">${awayLogo}<strong>${esc(away.name || 'Away')}</strong>${followTeamButton(away)}</div></div></section>
      <p class="entity-sub">更新: ${row.reconciledAt || row.provenance?.fetchedAt ? esc(row.reconciledAt || row.provenance.fetchedAt) : valueCell(null)} · ${watchLabel(row)} · ${attentionLabel(row)}</p>${renderAnnotations(bundle.annotations)}
      <div class="detail-tabs" role="tablist" aria-label="試合詳細">${tabs.map(([tab, label]) => `<button class="detail-tab${state.detailTab === tab ? ' is-active' : ''}" id="fixture-tab-${tab}" aria-controls="fixture-panel" data-detail-tab="${tab}" type="button" role="tab" aria-selected="${state.detailTab === tab}">${label}</button>`).join('')}</div>
      <div id="fixture-panel" role="tabpanel" aria-labelledby="fixture-tab-${state.detailTab}">${detail.loading ? '<div class="notice">試合詳細を読み込み中…</div>' : renderDetailBody(detail)}</div>`;
    $('detailBack').addEventListener('click', () => {
      if (state.ratingPlayerId) {closeRatingBreakdown(row);return;}
      goBack(returnToCompetition ? router.competitionHash(state.competitionDetail.id,state.competitionDetail.seasonId,state.competitionDetail.tab,state.competitionDetail.date) : matchRouteHash());
    });
    main.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => {
      state.detailTab = button.dataset.detailTab;
      state.ratingPlayerId = null;
      const fixtureId = row.fixtureId || row.id || detail.summary?.fixtureId;
      setRoute(router.fixtureHash(fixtureId, { tab: state.detailTab, ratingMode: state.ratingMode }), { replace: true });
      renderFixtureDetail();
    }));
    bindFollowButtons();
    bindRatingControls(row);
    bindPlayerRows();
    bindImageFallbacks();
    bindTeamRows();
  }

  function closeRatingBreakdown(row) {
    state.ratingPlayerId=null;
    setRoute(router.fixtureHash(row.fixtureId || row.id,{tab:'ratings',ratingMode:'jfw'}),{replace:true});
    renderFixtureDetail();
  }
  function bindRatingControls(row) {
    main.querySelector('[data-close-rating]')?.addEventListener('click',()=>closeRatingBreakdown(row));
    main.querySelectorAll('[data-rating-mode]').forEach(button => button.addEventListener('click', () => {
      state.ratingMode = button.dataset.ratingMode;
      state.ratingPlayerId = null;
      const fixtureId = row.fixtureId || row.id || state.detail?.summary?.fixtureId;
      setRoute(router.fixtureHash(fixtureId, { tab: 'ratings', ratingMode: state.ratingMode }), { replace: true });
      renderFixtureDetail();
    }));
    main.querySelectorAll('[data-rating-player]').forEach(button => button.addEventListener('click', () => {
      if (button.disabled) return;
      state.ratingPlayerId = button.dataset.ratingPlayer;
      const fixtureId = row.fixtureId || row.id || state.detail?.summary?.fixtureId;
      setRoute(router.fixtureHash(fixtureId, { tab: 'ratings', ratingMode: 'jfw', playerId: state.ratingPlayerId }), { replace: true });
      renderFixtureDetail();
    }));
  }

  function renderDetailBody(detail) {
    if (detail.error) return errorNotice(detail.error);
    if (detail.bundle?.archiveState === 'archive_pending' || detail.bundle?.presence === 'archive_pending') return errorNotice({status:409,code:'archive_pending'});
    if (!detail.bundle) {
      const item = detail?.summary?.legacy || {};
      return `<section class="detail-card"><div class="event-row"><div class="event-minute">既存</div><div>${esc(item.reason || item.note || '確認済み結果')}</div></div><div class="event-row"><div class="event-minute">対象</div><div>${esc(item.players || '—')}</div></div></section>`;
    }
    if (detail.bundle.detailAvailability === 'unavailable') return '<div class="notice"><strong>詳細は取得できません</strong><br>試合一覧のスコアと状態はそのまま表示しています。</div>';
    if (state.detailTab === 'lineup') return renderLineups(detail.bundle);
    if (state.detailTab === 'stats') return renderTeamStats(detail.bundle);
    if (state.detailTab === 'ratings') return renderPlayerRatings(detail.bundle);
    if (state.detailTab === 'events') return renderEvents(detail.bundle);
    return `${renderFixtureStatus(detail.bundle)}${renderEvents(detail.bundle)}`;
  }

  function renderFixtureStatus(bundle) {
    const row = bundle.fixture || {};
    let label = '開催前';
    if (isLive(row)) label = 'LIVE';
    else if (isFinal(row)) label = '終了';
    else if (isCancelled(row)) label = '中止';
    else if (statusShort(row) === 'PST') label = '延期';
    return `<section class="detail-card fixture-state-card"><div><span>状態</span><strong>${esc(label)}</strong></div><div><span>ステータス</span><strong>${esc(statusShort(row) || row.ingestionState || '未取得')}</strong></div><div><span>節</span><strong>${valueCell(row.round)}</strong></div><div><span>データ更新</span><strong>${valueCell(row.reconciledAt || row.provenance?.fetchedAt)}</strong></div></section>`;
  }

  function valueCell(value, state, label = '') {
    const presence = data.presence(value, state);
    if (presence === 'present') return esc(value);
    const text = ['not_applicable','provider_missing'].includes(presence) ? '非該当' : presence === 'conflict' ? '確認中' : '未取得';
    return `<span class="presence presence-${esc(presence)}" data-presence="${esc(presence)}" title="${esc(label)}${presence === 'not_applicable' ? '：非該当' : ''}">${text}</span>`;
  }
  function emptySection(bundle, key) {
    const presence = data.section(bundle,key);
    return presence === 'present' ? '<p class="empty-result">該当なし</p>' : `<div class="notice">${valueCell(null, presence)}</div>`;
  }
  function renderEvents(bundle) {
    const events = Array.isArray(bundle.events) ? bundle.events : [];
    if (data.section(bundle,'events') !== 'present' || !events.length) return emptySection(bundle,'events');
    return `<section class="detail-card">${events.map(event => `<div class="event-row"><div class="event-minute">${valueCell(event.elapsed)}′</div><div><b>${esc(event.type || 'イベント')}</b> ${esc(event.detail || '')}<div class="entity-sub">${esc(event.playerName || knownPlayers.get(event.playerId)?.name || '選手情報は未取得')}</div></div></div>`).join('')}</section>`;
  }

  function renderLineups(bundle) {
    const lineups = Array.isArray(bundle.lineups) ? bundle.lineups : [];
    if (data.section(bundle,'lineups') !== 'present' || !lineups.length) return emptySection(bundle,'lineups');
    return lineups.map(lineup => {
      const starters = Array.isArray(lineup.startXI) ? lineup.startXI : [];
      const substitutes = Array.isArray(lineup.substitutes) ? lineup.substitutes : [];
      const api = window.JFWFormation;
      const laidOut = api?.layoutPlayers ? api.layoutPlayers(starters, lineup.formation) : starters;
      const confidence = lineup.layoutConfidence || laidOut?.layoutMeta?.confidence || 'none';
      const team = [bundle?.fixture?.teams?.home, bundle?.fixture?.teams?.away].find(item => item?.id === lineup.teamId);
      const coach = lineup.coach;
      const teamTitle = team?.id
        ? `<button class="lineup-team-link" data-team-id="${esc(team.id)}" type="button">${esc(team.name || team.id)} · ${esc(lineup.formation || 'フォーメーション未取得')}</button>`
        : `<span>${esc(team?.name || lineup.teamId || 'Team')} · ${esc(lineup.formation || 'フォーメーション未取得')}</span>`;
      return `<section class="detail-card lineup-card"><div class="pitch-card"><div class="pitch-title">${teamTitle}${confidence === 'high' ? '' : `<span class="estimate confidence-${esc(confidence)}">${icon('estimated')} ${confidence === 'low' ? '推定（低確度）' : confidence === 'none' ? '配置は未取得' : '推定'}</span>`}</div><div class="pitch confidence-${esc(confidence)}">${confidence === 'none' ? '<div class="pitch-unavailable">配置は未取得です</div>' : laidOut.map(player => `<div class="pitch-player" style="left:${Number.isFinite(player.x) ? player.x : 50}%;top:${Number.isFinite(player.y) ? player.y : 50}%"><span class="pitch-disc">${esc(player.number ?? '—')}</span><span>${esc(player.name || '選手')}</span></div>`).join('')}</div></div>
        <div class="lineup-list"><h3>先発 ${Array.isArray(lineup.startXI) ? starters.length : valueCell(null)}</h3>${starters.map(player => lineupPersonRow(player, bundle, 'starter')).join('') || (Array.isArray(lineup.startXI) ? '<p class="empty-result">該当なし</p>' : valueCell(null))}</div>
        <div class="lineup-list"><h3>ベンチ ${Array.isArray(lineup.substitutes) ? substitutes.length : valueCell(null)}</h3>${substitutes.map(player => lineupPersonRow(player, bundle, 'substitute')).join('') || (Array.isArray(lineup.substitutes) ? '<p class="empty-result">該当なし</p>' : valueCell(null))}</div>
        <div class="coach-row">${personAvatar(coach, 'coach')}<div><span>監督</span><strong>${esc(coach?.name || '監督未取得')}</strong></div></div>
      </section>`;
    }).join('');
  }

  function personAvatar(person, kind = 'player') {
    const name = String(person?.name || (kind === 'coach' ? '監督' : '選手'));
    const initials = name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || '—';
    const fallback = kind === 'coach' ? esc(initials) : icon('missing-photo');
    const providerId = person?.providerId || (kind === 'coach' ? /^af:coach:(\d+)$/.exec(person?.id || '')?.[1] : null);
    const photo = person?.photo || (kind === 'coach' && /^\d+$/.test(String(providerId || '')) ? `https://media.api-sports.io/football/coachs/${providerId}.png` : null);
    if (photo) return `<span class="person-photo person-avatar"><span class="person-initials" aria-hidden="true">${fallback}</span><img src="${esc(photo)}" alt="" loading="lazy"></span>`;
    return `<span class="person-photo person-fallback" aria-hidden="true">${fallback}</span>`;
  }

  function bindImageFallbacks() {
    main.querySelectorAll('.person-avatar img').forEach(image => image.addEventListener('error', () => {
      image.hidden = true;
      image.closest('.person-avatar')?.classList.add('is-fallback');
    }, { once: true }));
  }

  function substitutionForPlayer(player, bundle, role) {
    if (player?.substitution) {
      const minute = player.substitution.elapsed ?? player.substitution.minute;
      return minute === null || minute === undefined ? '' : `${role === 'starter' ? 'OUT' : 'IN'} ${minute}′`;
    }
    const id = String(player?.id || player?.playerId || '');
    const event = (bundle.events || []).find(item => {
      if (!/subst/i.test(String(item.type || ''))) return false;
      return String(role === 'starter' ? item.playerId : item.relatedPlayerId || '') === id;
    });
    if (!event) return '';
    return `${role === 'starter' ? 'OUT' : 'IN'} ${event.elapsed ?? '—'}′${event.extra ? `+${event.extra}` : ''}`;
  }

  function lineupPersonRow(player, bundle, role) {
    const substitution = substitutionForPlayer(player, bundle, role);
    const stats = (bundle.playerStats || []).find(row => row.playerId === player.id);
    const nationality = player.nationality || stats?.nationality;
    return `<div class="lineup-person">${personAvatar(player)}<span class="shirt-number">${esc(player.number ?? '—')}</span><div><strong>${player.id ? `<button class="lineup-team-link" data-player-id="${esc(player.id)}" type="button">${esc(player.name || '選手')}</button>` : esc(player.name || '選手')}</strong><span>${esc(player.position || '')} ${nationality ? esc(nationality) : ''} · 出場 ${valueCell(stats?.values?.minutes)}分</span></div>${substitution ? `<b class="substitution ${role === 'starter' ? 'is-out' : 'is-in'}">${esc(substitution)}</b>` : ''}</div>`;
  }

  function renderPlayerRatings(bundle) {
    const rows = Array.isArray(bundle.playerStats) ? bundle.playerStats : [];
    if (data.section(bundle,'playerStats') !== 'present' || !rows.length) return emptySection(bundle,'playerStats');
    const modeLabel = state.ratingMode === 'jfw' ? 'JFW 独自評価' : 'API-Football 評価';
    const teams = [bundle.fixture?.teams?.home, bundle.fixture?.teams?.away].filter(Boolean);
    const renderRow = row => {
      const playerId = row.playerId || row.id;
      const lineupPlayer = (bundle.lineups || []).flatMap(l => [...(l.startXI || []), ...(l.substitutes || [])]).find(p => p.id === playerId);
      const eligible = data.trackedFixture(bundle.fixture || {}, state.legacy?.trackingPeriods, config.scope);
      const trackedPlayer = (state.legacy?.trackingPeriods || []).some(p => p.playerId === playerId && data.trackedFixture(bundle.fixture, [p], config.scope));
      const jfwState = eligible === false || (eligible === true && !trackedPlayer) ? 'not_applicable' : eligible === null ? 'not_fetched' : row.jfwRating?.presence;
      const jfwValue = typeof row.jfwRating === 'number' ? row.jfwRating : row.jfwRating?.value;
      const value = state.ratingMode === 'jfw' ? valueCell(jfwValue, jfwState) : valueCell(row.values?.rating, row.fieldStates?.rating);
      const actionable = state.ratingMode === 'jfw' && playerId && !['not_applicable','not_fetched'].includes(jfwState) && row.jfwRating?.factors;
      return `<button class="rating-row" data-rating-player="${esc(playerId || '')}" type="button"${actionable ? '' : ' disabled'}>${personAvatar({ name: row.playerName, photo: row.playerPhoto })}<span><strong>${esc(row.playerName || '選手')}</strong><small>${esc(lineupPlayer?.number ?? '')} · ${esc(row.position || lineupPlayer?.position || '')} ${esc(row.nationality || lineupPlayer?.nationality || '')} · 出場 ${valueCell(row.values?.minutes)}分</small></span><b>${value}</b></button>`;
    };
    return `<div class="rating-switch" role="group" aria-label="評価方式"><button class="chip${state.ratingMode === 'provider' ? ' is-active' : ''}" data-rating-mode="provider" aria-pressed="${state.ratingMode === 'provider'}" type="button">API-Football</button><button class="chip${state.ratingMode === 'jfw' ? ' is-active' : ''}" data-rating-mode="jfw" aria-pressed="${state.ratingMode === 'jfw'}" type="button">JFW 独自評価</button></div><h2>${modeLabel}</h2>${teams.map(team => `<section class="detail-card" data-rating-team="${esc(team.id)}"><div class="section-title"><h3>${esc(team.name || 'チーム')}</h3></div>${rows.filter(row => row.teamId === team.id).map(renderRow).join('') || valueCell(null)}</section>`).join('')}${state.ratingPlayerId ? renderRatingBreakdown(rows.find(row => String(row.playerId || row.id) === String(state.ratingPlayerId))) : ''}`;
  }

  function renderRatingBreakdown(row) {
    if (!row) return '<div class="notice">指定された選手評価は取得できません。</div>';
    const factors = row?.jfwRating?.factors || row?.ratingFactors || null;
    if (!factors || typeof factors !== 'object') return `<section class="detail-card rating-breakdown"><button type="button" class="plain-button" data-close-rating>評価一覧に戻る</button><h3>${esc(row.playerName || '選手')} · JFW Rating 要因分解</h3><div class="notice">要因データは未取得です。欠落を±0.00として表示していません。</div></section>`;
    return `<section class="detail-card rating-breakdown"><button type="button" class="plain-button" data-close-rating>評価一覧に戻る</button><h3>${esc(row.playerName || '選手')} · JFW Rating 要因分解</h3>${Object.entries(factors).map(([key, value]) => `<div><span>${esc(key)}</span><strong>${value === null || value === undefined ? '未取得' : esc(value)}</strong></div>`).join('')}</section>`;
  }

  function renderTeamStats(bundle) {
    const stats = Array.isArray(bundle.teamStats) ? bundle.teamStats : [];
    if (data.section(bundle,'teamStats') !== 'present' || !stats.length) return emptySection(bundle,'teamStats');
    const home = stats.find(row => row.teamId === bundle.fixture?.teams?.home?.id) || {};
    const away = stats.find(row => row.teamId === bundle.fixture?.teams?.away?.id) || {};
    const keys = [...new Set([...Object.keys(home.values || {}), ...Object.keys(away.values || {})])];
    const labels = { penalties:'PK', distance_covered:'走行距離', shots:'シュート', shots_on_goal:'枠内シュート', shots_off_goal:'枠外シュート', total_shots:'シュート', blocked_shots:'ブロックされたシュート', shots_insidebox:'エリア内シュート', shots_outsidebox:'エリア外シュート', fouls:'ファウル', corner_kicks:'コーナーキック', offsides:'オフサイド', ball_possession:'ボール保持率', yellow_cards:'イエローカード', red_cards:'レッドカード', goalkeeper_saves:'セーブ', total_passes:'パス', passes_accurate:'成功パス', passes_percentage:'パス成功率', expected_goals:'ゴール期待値', goals_prevented:'失点阻止' };
    return `<section class="detail-card">${keys.map(key => `<div class="team-stat-row"><span class="home">${valueCell(home.values?.[key],home.fieldStates?.[key])}</span><span class="label">${esc(labels[key.toLowerCase().replaceAll(' ','_')] || key)}</span><span class="away">${valueCell(away.values?.[key],away.fieldStates?.[key])}</span></div>`).join('')}</section>`;
  }

  function followTeamButton(team) {
    if (!team?.id) return '';
    const on = isFollowing('teams', team.id);
    return `<button class="follow-button${on ? ' is-following' : ''}" data-follow-type="teams" data-follow-id="${esc(team.id)}" data-follow-name="${esc(team.name || team.id)}" data-follow-logo="${esc(team.logo || '')}" type="button">${icon('follow',on)} ${on ? 'フォロー中' : 'フォロー'}</button>`;
  }

  function renderLeagues() {
    setPageHeader('leagues');
    if (state.competitionDetail) {
      renderCompetitionDetail();
      return;
    }
    const leagues = competitionDirectory();
    main.innerHTML = `<input id="leagueSearch" class="search-box" placeholder="リーグ・大会を検索" autocomplete="off"><div id="leagueDirectory">${leagueDirectorySections(leagues, '')}</div>`;
    $('leagueSearch').addEventListener('input', event => {
      $('leagueDirectory').innerHTML = leagueDirectorySections(leagues, event.target.value);
      bindCompetitionRows();
      bindFollowButtons();
    });
    bindCompetitionRows();
    bindFollowButtons();
  }

  function competitionDirectory() {
    const unique = new Map(knownCompetitions);
    for (const player of state.legacy?.players || []) if (player.league) {
      const id = `legacy:competition:${player.league}`;
      unique.set(id, {id,name:player.league,logo:'',seasonId:null});
    }
    for (const row of state.fixtures) if (row.competitionId) {
      const prior = unique.get(row.competitionId) || {};
      unique.set(row.competitionId, { ...prior, id:row.competitionId, name:competitionKey(row), logo:row.competition?.logo || prior.logo || '', seasonId:row.seasonId || prior.seasonId || null });
    }
    return [...unique.values()].sort((a,b) => a.name.localeCompare(b.name,'ja'));
  }

  function leagueDirectorySections(leagues, query) {
    const q = String(query || '').trim().toLowerCase();
    const filtered = leagues.filter(item => !q || item.name.toLowerCase().includes(q));
    const followed = filtered.filter(isCompetitionFollowing);
    const all = filtered.filter(item => !isCompetitionFollowing(item));
    if (!filtered.length) return '<div class="empty-state"><strong>該当する大会なし</strong>検索条件を変えてください。</div>';
    return `${followed.length ? `<section class="section"><div class="section-title"><h2>フォロー中</h2><span class="meta">${followed.length}</span></div><div class="list-card">${leagueRows(followed)}</div></section>` : ''}<section class="section"><div class="section-title"><h2>すべての大会</h2><span class="meta">${all.length}</span></div><div class="list-card">${leagueRows(all)}</div></section>`;
  }

  function leagueRows(leagues) {
    if (!leagues.length) return '<div class="empty-state"><strong>大会なし</strong>この区分に表示できる大会はありません。</div>';
    return leagues.map(item => {
      const on = isCompetitionFollowing(item);
      return `<div class="entity-row is-link" data-competition-id="${esc(item.id)}" data-competition-name="${esc(item.name)}" data-competition-logo="${esc(item.logo || '')}" data-competition-season="${esc(item.seasonId || '')}">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">${esc(item.seasonId ? `シーズン ${seasonLabel(item.seasonId)}` : item.id)}</div></div><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="competitions" data-follow-id="${esc(item.id)}" ${String(item.id).startsWith('legacy:') && !isFollowing('competitions',item.id) ? 'disabled' : ''} data-follow-name="${esc(item.name)}" data-follow-logo="${esc(item.logo || '')}" data-follow-season="${esc(item.seasonId || '')}" type="button">${icon('follow',on)}</button></div>`;
    }).join('');
  }

  function seasonLabel(canonicalSeasonId) {
    return String(canonicalSeasonId || '').split(':').at(-1) || '—';
  }

  function bindCompetitionRows() {
    main.querySelectorAll('[data-competition-id]').forEach(row => row.addEventListener('click', () => openCompetition({
      id: row.dataset.competitionId,
      name: row.dataset.competitionName,
      logo: row.dataset.competitionLogo || '',
      seasonId: row.dataset.competitionSeason || null,
    })));
  }

  function openCompetition(item, options = {}) {
    state.page = 'leagues';
    syncNav();
    state.detail = null;
    if (!item.unresolved) knownCompetitions.set(item.id, item);
    state.competitionDetail = {
      ...item,
      seasonId: options.seasonId || item.seasonId || null,
      date: options.date || state.date,
      tab: options.tab || 'matches',
      fixtures: [],
      matchesLoading: false,
      matchesError: null,
      matchesPresence: 'not_fetched',
      standings: null,
      standingsLoading: false,
      standingsError: null,
    };
    if (!options.routeDriven) {

      setRoute(router.competitionHash(item.id, state.competitionDetail.seasonId, state.competitionDetail.tab));
    }
    renderCompetitionDetail();
    loadCompetitionMatches();
    loadCompetitionStandings();
  }

  async function loadCompetitionMatches() {
    const detail = state.competitionDetail;
    if (!detail) return;
    const loadSequence = ++state.competitionLoadSequence;
    const requestedDate = detail.date;
    detail.matchesLoading = true;
    detail.matchesError = null;
    renderCompetitionDetailIfVisible();
    const cached = state.fixtures.filter(row => row.competitionId === detail.id && row.dateJst === requestedDate);
    let fixtures = cached;
    let presence = cached.length ? 'present' : 'not_fetched';
    let matchesError = null;
    if (state.workerBase && !detail.id.startsWith('legacy:')) {
      try {
        const index = await apiFetch(`/api/v2/competitions/${encodeURIComponent(detail.id)}/dates/${encodeURIComponent(requestedDate)}`);
        fixtures = Array.isArray(index?.fixtures) ? index.fixtures : [];
        presence = Array.isArray(index?.fixtures) ? 'present' : 'not_fetched';
      } catch (error) {
        matchesError = error;
      }
    }
    if (loadSequence !== state.competitionLoadSequence || state.competitionDetail !== detail) return;
    rememberFixtures(fixtures);
    detail.fixtures = fixtures;
    detail.matchesPresence = presence;
    detail.matchesError = matchesError;
    detail.matchesLoading = false;
    renderCompetitionDetailIfVisible();
  }

  async function loadCompetitionStandings() {
    const detail = state.competitionDetail;
    if (!detail || !detail.seasonId || detail.id.startsWith('legacy:')) return;
    detail.standingsLoading = true;
    detail.standingsError = null;
    renderCompetitionDetailIfVisible();
    if (!state.workerBase) {
      detail.standingsLoading = false;
      detail.standingsError = {code:'not_fetched'};
      renderCompetitionDetailIfVisible();
      return;
    }
    try {
      detail.standings = await apiFetch(`/api/v2/competitions/${encodeURIComponent(detail.id)}/seasons/${encodeURIComponent(detail.seasonId)}/standings`);
    } catch (error) {
      detail.standingsError = error;
      if (Array.isArray(error.availableSeasons)) detail.availableSeasons = error.availableSeasons;
    }
    if (state.competitionDetail !== detail) return;
    for (const group of detail.standings?.groups || []) for (const row of group.table || []) if (row.team?.id) {
      knownStandings.set(row.team.id,{...row,seasonId:detail.seasonId,competitionId:detail.id});knownTeams.set(row.team.id,row.team);
    }
    detail.standingsLoading = false;
    renderCompetitionDetailIfVisible();
  }

  function renderCompetitionDetailIfVisible() {
    if (router.parseHash(location.hash).kind === 'competition' && state.competitionDetail) renderCompetitionDetail();
  }

  function renderCompetitionDetail() {
    const detail = state.competitionDetail;
    if (!detail) {
      renderLeagues();
      return;
    }
    setPageHeader('leagues');
    const on = isCompetitionFollowing(detail);
    const seasons = [...new Set([detail.seasonId, ...(detail.availableSeasons || []).map(item => typeof item === 'string' ? item : item.id), ...state.fixtures.filter(row => row.competitionId === detail.id).map(row => row.seasonId)].filter(Boolean))];
    const tabs = [
      ['matches', '試合'],
      ['standings', '順位表'],
      ['overview', '概要'],
      ['players', '選手成績'],
      ['teams', 'チーム成績'],
    ];
    main.innerHTML = `<div class="detail-top"><button id="competitionBack" class="back-button" type="button">← リーグ一覧</button><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="competitions" data-follow-id="${esc(detail.id)}" ${String(detail.id).startsWith('legacy:') && !on ? 'disabled' : ''} data-follow-name="${esc(detail.name)}" data-follow-logo="${esc(detail.logo || '')}" data-follow-season="${esc(detail.seasonId || '')}" type="button">${icon('follow',on)} ${on ? 'フォロー中' : 'フォロー'}</button></div>
      <section class="competition-hero">${detail.logo ? `<img src="${esc(detail.logo)}" alt="">` : '<span class="competition-placeholder" aria-hidden="true"></span>'}<div><div class="eyebrow">${esc(detail.seasonId ? `Season ${seasonLabel(detail.seasonId)}` : 'Competition')}</div><h2>${esc(detail.name)}</h2></div></section>
      ${seasons.length > 1 ? `<label class="season-select-label" for="competitionSeason">シーズン<select id="competitionSeason" class="season-select">${seasons.map(id => `<option value="${esc(id)}" ${id === detail.seasonId ? 'selected' : ''}>${esc(seasonLabel(id))}</option>`).join('')}</select></label>` : `<p class="season-select-label">シーズン ${detail.seasonId ? esc(seasonLabel(detail.seasonId)) : valueCell(null)} · 別シーズンは未取得</p>`}
      <div class="detail-tabs" role="tablist" aria-label="リーグ詳細">${tabs.map(([tab, label]) => `<button class="detail-tab${detail.tab === tab ? ' is-active' : ''}" id="competition-tab-${tab}" aria-controls="competition-panel" data-competition-tab="${tab}" type="button" role="tab" aria-selected="${detail.tab === tab}">${label}</button>`).join('')}</div>
      <div id="competition-panel" role="tabpanel" aria-labelledby="competition-tab-${detail.tab}">${renderCompetitionTab(detail)}</div>`;
    $('competitionSeason')?.addEventListener('change', event => {
      setRoute(router.competitionHash(detail.id,event.target.value,detail.tab,detail.date), {replace:true});
      applyCurrentRoute();
    });
    $('competitionBack').addEventListener('click', () => goBack('#/competitions'));
    main.querySelectorAll('[data-competition-tab]').forEach(button => button.addEventListener('click', () => {
      detail.tab = button.dataset.competitionTab;
      setRoute(router.competitionHash(detail.id, detail.seasonId, detail.tab, detail.date), { replace: true });
      renderCompetitionDetail();
    }));
    main.querySelectorAll('[data-competition-date]').forEach(button => button.addEventListener('click', () => {
      detail.date = button.dataset.competitionDate;
      setRoute(router.competitionHash(detail.id, detail.seasonId, detail.tab, detail.date), { replace: true });
      renderCompetitionDetail();
      loadCompetitionMatches();
    }));
    bindFixtureRows('competition');
    bindFollowButtons();
    bindTeamRows();
  }

  function renderCompetitionTab(detail) {
    if (detail.tab === 'standings') return renderCompetitionStandings(detail);
    if (detail.tab === 'matches') return renderCompetitionMatches(detail);
    const labels = { overview: '概要', players: '選手成績', teams: 'チーム成績' };
    return `<div class="empty-state"><strong>${labels[detail.tab] || 'この項目'}は準備中です</strong>表示項目とAPI契約が確定するまで、未取得値を推測表示しません。</div>`;
  }

  function renderCompetitionDateStrip(detail) {
    return `<div class="date-strip">${[-2, -1, 0, 1, 2].map(offset => {
      const date = shiftDate(detail.date, offset);
      const parts = dateParts(date);
      return `<button class="date-button${offset === 0 ? ' is-active' : ''}" data-competition-date="${date}" type="button"><span class="dow">${esc(date === todayJst() ? '今日' : parts.dow)}</span><span class="day">${esc(parts.day)}</span></button>`;
    }).join('')}</div>`;
  }

  function renderCompetitionMatches(detail) {
    const finished = detail.fixtures.filter(isFinal).length;
    const live = detail.fixtures.filter(isLive).length;
    const summary = detail.matchesPresence === 'present' && !detail.matchesLoading
      ? `<div class="competition-summary"><div><strong>${detail.fixtures.length}</strong><span>試合</span></div><div><strong>${live}</strong><span>LIVE</span></div><div><strong>${finished}</strong><span>終了</span></div></div>`
      : '';
    let body;
    const warning = detail.matchesError ? errorNotice(detail.matchesError) : '';
    if (detail.matchesLoading) body = '<div class="notice">リーグの試合を読み込み中…</div>';
    else if (detail.matchesPresence !== 'present') body = warning || '<div class="empty-state"><strong>試合データは未取得です</strong>未取得を0試合として表示していません。</div>';
    else if (!detail.fixtures.length) body = `${warning}<div class="empty-state"><strong>この日の試合はありません</strong>取得済みの日付インデックスは0試合です。</div>`;
    else body = `${warning}<div class="match-card">${detail.fixtures.map(fixtureRow).join('')}</div>`;
    return `${renderCompetitionDateStrip(detail)}${summary}${body}`;
  }

  function renderCompetitionStandings(detail) {
    if (detail.standingsLoading) return '<div class="notice">順位表を読み込み中…</div>';
    if (detail.standingsError) return errorNotice(detail.standingsError);
    const groups = Array.isArray(detail.standings?.groups) ? detail.standings.groups : [];
    if (!detail.seasonId || detail.id.startsWith('legacy:')) return `<div class="notice">順位表 ${valueCell(null, 'not_applicable')}</div>`;
    if (!groups.length) return detail.standings ? '<p class="empty-result">該当なし</p>' : valueCell(null);
    return groups.map(group => `<section class="section"><div class="section-title"><h2>${esc(group.name || '順位表')}</h2><span class="meta">${group.table?.length || 0}クラブ</span></div><div class="standings-card"><div class="standings-row standings-head"><span>#</span><span>クラブ</span><span>試</span><span>差</span><span>勝点</span></div>${(group.table || []).map(standingRow).join('')}</div></section>`).join('');
  }

  function standingRow(row) {
    const team = row?.team || {};
    return `<div class="standings-row${team.id ? ' is-link' : ''}"${team.id ? ` data-team-id="${esc(team.id)}"` : ''}><span class="standings-rank">${valueCell(row?.rank,row?.fieldStates?.rank)}</span><span class="standings-team">${team.logo ? `<img src="${esc(team.logo)}" alt="">` : ''}<b>${esc(team.name || team.id || '未取得')}</b></span><span>${valueCell(row?.overall?.played,row?.fieldStates?.played)}</span><span>${valueCell(row?.goalDifference,row?.fieldStates?.goalDifference)}</span><strong>${valueCell(row?.points,row?.fieldStates?.points)}</strong></div>`;
  }

  function renderFollowing() {
    setPageHeader('following');
    const groups = [['competitions','リーグ・大会'],['teams','クラブ'],['players','選手']];
    main.innerHTML = groups.map(([type,label]) => `<section class="section"><div class="section-title"><h2>${label}</h2><span class="meta">${state.follows[type].length}</span></div><div class="list-card">${followRows(type)}</div></section>`).join('');
    bindCompetitionRows();
    bindTeamRows();
    bindPlayerRows();
    bindFollowButtons();
  }

  function followRows(type) {
    const rows = state.follows[type];
    if (!rows.length) return '<div class="empty-state"><strong>該当なし</strong>試合・リーグ・日本人画面から追加できます。</div>';
    return rows.map(ref => {
      const item = (type === 'competitions' ? competitionDirectory() : type === 'teams' ? allKnownTeams() : allKnownPlayers()).find(item => (item.id || item.playerId || item.jfwPlayerId) === ref.id);
      if (!item) return `<div class="entity-row"><span class="entity-logo"></span><div class="entity-main"><strong>${state.loading ? 'フォロー情報を読み込み中…' : '参照先は未取得'}</strong><p class="entity-sub">${state.loading ? '取得済みのデータを確認しています。' : '参照先を確認する機能は準備中です。'}</p></div><button class="follow-button" data-follow-type="${type}" data-follow-id="${esc(ref.id)}" type="button">解除</button></div>`;
      item.id ||= ref.id;
      const linkAttributes = type === 'competitions'
        ? ` data-competition-id="${esc(item.id)}" data-competition-name="${esc(item.name)}" data-competition-logo="${esc(item.logo || '')}" data-competition-season="${esc(item.seasonId || '')}"`
        : type === 'teams'
          ? ` data-team-id="${esc(item.id)}"`
          : ` data-player-id="${esc(item.id)}"`;
      return `<div class="entity-row is-link"${linkAttributes}>${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">${esc(type === 'players' ? '選手' : type === 'teams' ? 'クラブ' : '大会')}</div></div><button class="follow-button is-following" data-follow-type="${type}" data-follow-id="${esc(item.id)}" ${String(item.id).startsWith('legacy:') && !isFollowing('competitions',item.id) ? 'disabled' : ''} data-follow-name="${esc(item.name)}" data-follow-logo="${esc(item.logo || '')}" data-follow-season="${esc(item.seasonId || '')}" type="button">解除</button></div>`;
    }).join('');
  }

  function renderJapanese() {
    setPageHeader('japanese');
    const season = router.parseHash(location.hash).productSeason || currentProductSeason();
    if (season && currentProductSeason() && season !== currentProductSeason()) return renderRouteError({status:400,code:'season_not_available'},router.pageHash('japanese',currentProductSeason()));
    const players = state.legacy?.players || [];
    const aggregateKeys = [...new Set(players.flatMap(p => Object.keys(p.competitionStats || {})))];
    const competitions = aggregateKeys.filter(key => config.scope?.attentionEligibleCompetitions.includes(config.competitionAliases?.[key] || key)).map(key => ({id:key,label:config.scope?.trackingLeagues.find(c => c.id === key)?.label || key}));
    if (!competitions.some(c => c.id === state.japaneseCompetition)) state.japaneseCompetition = 'all';
    const options = [{id:'all',label:'シーズン通算'},...competitions];
    main.innerHTML = `${dataIntegrityNotice()}<p class="notice">承認済みの海外リーグにおける追跡期間中の成績を表示します。J1など対象外へ移籍した後も、取得済みの成績は残ります。</p><div class="control-row"><span>シーズン ${season ? esc(seasonLabel(season)) : valueCell(null)}</span><label>大会 <select id="japaneseCompetition" class="season-select" ${competitions.length ? '' : 'disabled'}>${options.map(c => `<option value="${esc(c.id)}" ${c.id === state.japaneseCompetition ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>${competitions.length ? '' : '<span class="entity-sub">大会別集計は接続準備中</span>'}</div><input id="japaneseSearch" class="search-box" placeholder="日本人選手を検索" value="${esc(state.legacySearch)}" autocomplete="off"><div id="japaneseList"></div>${renderAttentionRanking()}${renderTrackingInsights()}`;
    const renderList = () => {
      const q = state.legacySearch.trim().toLowerCase();
      const rows = players.filter(p => p.rankingEligible !== false && (!q || `${p.name} ${p.club} ${p.league}`.toLowerCase().includes(q))).map(p => ({...p, displayStats: state.japaneseCompetition === 'all' ? p.seasonStats || p.stats : p.competitionStats?.[state.japaneseCompetition]})).filter(p => state.japaneseCompetition === 'all' || p.displayStats);
      const sorted = rows.sort((a,b) => {
        const total = p => Number.isFinite(p.displayStats?.goals) && Number.isFinite(p.displayStats?.assists) ? p.displayStats.goals + p.displayStats.assists : -1;
        return total(b)-total(a) || String(a.name).localeCompare(String(b.name),'ja');
      });
      const out = p => ['out_of_scope','inactive','unattached'].includes(p.trackingStatus);
      const group = (label,items) => `<section class="section"><div class="section-title"><h2>${label}</h2><span class="meta">${items.length}人 · 得点＋アシスト順</span></div><div class="list-card">${japaneseRows(items)}</div></section>`;
      $('japaneseList').innerHTML = group('追跡選手',sorted.filter(p => !out(p))) + (sorted.some(out) ? group('無所属・追跡対象外',sorted.filter(out)) : '');
      bindFollowButtons(); bindPlayerRows(); bindImageFallbacks();
    };
    $('japaneseSearch').addEventListener('input',event => {state.legacySearch=event.target.value;renderList();});
    $('japaneseCompetition').addEventListener('change',event => {state.japaneseCompetition=event.target.value;renderList();});
    renderList();
    if (config.attentionEnabled && !state.attention.loading && state.attention.season !== season) loadAttention(season);
  }

  function japaneseRows(players, emptyMessage = '検索条件を変えてください。') {
    if (!players.length) return `<div class="empty-state"><strong>該当なし</strong>${esc(emptyMessage)}</div>`;
    return players.map(player => {
      const stats = player.displayStats || player.seasonStats || player.stats || {};
      const id = player.playerId || player.jfwPlayerId;
      const canFollow = Boolean(id);
      const on = isFollowing('players',id);
      const photo = personAvatar(player);
      return `<div class="entity-row is-link" ${id ? `data-player-id="${esc(id)}"` : ''}>${photo}<div class="entity-main"><div class="entity-name">${esc(player.name)}</div><div class="entity-sub">${esc(player.club || 'クラブ未取得')} · ${esc(player.league || 'リーグ未取得')} · ${esc(player.pos || '')}</div><div class="stat-inline"><span>出場 <b>${valueCell(stats.apps)}</b></span><span>G <b>${valueCell(stats.goals)}</b></span><span>A <b>${valueCell(stats.assists)}</b></span><span>${esc(player.status || '')}</span></div></div><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="players" data-follow-id="${esc(id)}" ${canFollow ? '' : 'disabled'} data-follow-name="${esc(player.name)}" data-follow-logo="${esc(player.photo || '')}" type="button" aria-label="${esc(player.name)}を${on ? 'フォロー解除' : 'フォロー'}">${icon('follow',on)}</button></div>`;
    }).join('');
  }

  function renderAttentionRanking() {
    const attention = state.attention;
    const header = '<section class="section"><div class="section-title"><h2>視聴価値ランキング</h2></div>';
    if (attention.loading) return `${header}<p class="notice">全候補を取得中… 順位は取得完了後に表示します。</p></section>`;
    if (attention.error) return `${header}${errorNotice(attention.error)}</section>`;
    if (!attention.snapshot) return `${header}<p class="notice">視聴価値データは${valueCell(null)}です。ランキングの取得は準備中です。</p></section>`;
    const ranked = data.rankCandidates(attention.snapshot.candidates, Object.fromEntries(Object.entries(state.follows).map(([key,items]) => [key,items.map(item => item.id)])));
    return `${header}<p class="entity-sub">スコア仕様 ${esc(attention.snapshot.attentionVersion)} · ${esc(attention.snapshot.asOfUtc)} 時点</p>${ranked.length ? `<div class="list-card">${ranked.map((item,index) => `<article class="attention-row"><b>${index+1}</b><div><strong>${esc(item.match || '試合')}</strong><small>基礎スコア ${esc(item.baseScore)} · フォロー係数 ×${item.multiplier.toFixed(2)}</small>${renderAnnotations(item.annotations)}</div><strong>${item.personalScore}</strong></article>`).join('')}</div>` : '<p class="empty-result">該当なし（個人スコア20.00以上）</p>'}</section>`;
  }
  async function loadAttention(season) {
    const request = {season,loading:true,presence:'not_fetched',snapshot:null,error:null};
    state.attention = request;
    renderJapanese();
    try { request.snapshot = await data.loadAttention((productSeason,cursor) => {
      const params = new URLSearchParams({productSeason}); if (cursor) params.set('cursor',cursor);
      return apiFetch(`/api/v2/tracking/attention?${params}`);
    },season); request.presence='present'; }
    catch(error) {request.error=error;}
    request.loading=false;
    if(state.attention===request && router.parseHash(location.hash).kind==='japanese') renderJapanese();
  }
  function renderAnnotations(annotations) {
    return (Array.isArray(annotations) ? annotations : []).map(item => `<div class="match-annotation"><span class="confidence-pill">確信度 ${esc(item.confidence || '未取得')}</span><p>${esc(item.text || item.reason || '')}</p>${sourceLine(item.sources || item.citations)}</div>`).join('');
  }
  function watchLabel(row) {
    const watch = row.watch;
    const label = typeof watch === 'string' ? watch : watch?.label || watch?.service;
    return `<span class="watch-label">配信: ${label ? esc(label) : valueCell(null,watch?.presence)}</span>`;
  }
  function attentionLabel(row) {
    const attention = row.attention;
    if (!attention) return `視聴価値 ${valueCell(null)}`;
    if (attention.presence === 'not_applicable') return `視聴価値 ${valueCell(null,'not_applicable')}`;
    if (['missing','provider_missing','conflict'].includes(attention.presence)) return '<span class="entity-sub">視聴価値は未算出です</span>';
    return `視聴価値 ${valueCell(attention.displayedScore,attention.presence)}`;
  }

  function renderTrackingInsights() {
    const facts = Array.isArray(state.legacy?.insights) ? state.legacy.insights : [];
    const analyses = Array.isArray(state.legacy?.analysis) ? state.legacy.analysis : [];
    if (!facts.length && !analyses.length) return '<section class="section"><div class="section-title"><h2>好調・注目ポイント</h2></div><div class="empty-state"><strong>掲載項目なし</strong>現時点で、掲載に足る根拠のある好調・分析項目はありません。</div></section>';
    const factCards = facts.map(item => `<article class="insight-card is-fact"><div class="insight-kicker">確認済みの事実</div><h3>${esc(item.player || item.title || '注目ポイント')}</h3><p>${esc(item.fact || item.text || '')}</p><h4>なぜ注目か</h4><p>${esc(item.why || '')}</p>${sourceLine(item.sources || item.source)}</article>`).join('');
    const expanded = analyses.filter(item => item.confidence !== 'low').map(analysisCard).join('');
    const low = analyses.filter(item => item.confidence === 'low');
    const collapsed = low.length ? `<details class="low-insights"><summary>もっと見る（${low.length}件）</summary>${low.map(analysisCard).join('')}</details>` : '';
    return `<section class="section"><div class="section-title"><h2>好調・注目ポイント</h2><span class="meta">事実と分析を分離</span></div><div class="insights-grid">${factCards}${expanded}${collapsed}</div></section>`;
  }

  function analysisCard(item) {
    return `<article class="insight-card is-analysis"><div class="insight-kicker">分析 <span class="confidence-pill">確信度 ${esc(item.confidence || '未取得')}</span></div><h3>${esc(item.player || item.title || '分析')}</h3><p>${esc(item.text || '')}</p>${sourceLine(item.sources || item.source)}</article>`;
  }

  function sourceLine(value) {
    const sources = Array.isArray(value) ? value : (value ? [value] : []);
    const safe = sources.map(source => {
      if (typeof source === 'string') return esc(source);
      const label = source.title || source.label || source.name || '出典';
      try { const url=new URL(source.url); if (['https:','http:'].includes(url.protocol)) return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`; } catch { /* Plain label when URL is absent/invalid. */ }
      return esc(label);
    });
    return `<div class="source-line">出典: ${safe.length ? safe.join(' / ') : '未取得'}</div>`;
  }

  function bindPlayerRows() {
    main.querySelectorAll('[data-player-id]').forEach(row => row.addEventListener('click', event => {
      if (event.target.closest('[data-follow-type]')) return;

      setRoute(router.entityHash('players', row.dataset.playerId, currentProductSeason()));
      applyCurrentRoute();
    }));
  }

  function currentProductSeason() {
    return state.legacy?._dataIntegrity?.season
      ? `jfw:season:${state.legacy._dataIntegrity.season}`
      : null;
  }

  function allKnownTeams() {
    const teams = new Map();
    const add = item => {
      if (!item?.id || !item?.name) return;
      teams.set(String(item.id), item);
    };
    for (const item of knownTeams.values()) add(item);
    for (const row of state.fixtures) {
      add(row?.teams?.home);
      add(row?.teams?.away);
    }
    for (const group of state.competitionDetail?.standings?.groups || []) {
      for (const row of group.table || []) add(row?.team);
    }
    return [...teams.values()];
  }

  function renderSearch() {
    eyebrow.textContent = '共通検索';
    title.textContent = '検索';
    main.innerHTML = `<div class="detail-top"><button id="searchBack" class="back-button" type="button">← 閉じる</button></div><label class="sr-only" for="globalSearch">大会・クラブ・選手を検索</label><input id="globalSearch" class="search-box" type="search" value="${esc(state.searchQuery)}" placeholder="大会・クラブ・選手を検索" autocomplete="off"><p class="notice">取得済みの項目を検索します。全大会・全選手の検索は準備中です。</p><div id="searchResults"></div>`;
    $('searchBack').addEventListener('click', () => goBack(matchRouteHash()));
    const input = $('globalSearch');
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    const update = () => {
      state.searchQuery = input.value;
      if (composing) return;
      setRoute(router.searchHash(state.searchQuery), { replace: true });
      renderSearchResults();
    };
    input.addEventListener('compositionend', () => { composing = false; update(); });
    input.addEventListener('input', update);
    renderSearchResults();
  }
  function renderSearchResults() {
    const query = state.searchQuery.trim().toLowerCase();
    const competitions = competitionDirectory().filter(item => item.name.toLowerCase().includes(query));
    const teams = allKnownTeams().filter(item => String(item.name).toLowerCase().includes(query));
    const players = allKnownPlayers().filter(item => `${item.name} ${item.club || ''} ${item.league || ''}`.toLowerCase().includes(query));
    $('searchResults').innerHTML = query ? `${searchSection('大会', competitionSearchRows(competitions))}${searchSection('クラブ', teamSearchRows(teams))}${searchSection('選手', japaneseRows(players))}` : '<p class="empty-state">検索語を入力してください</p>';
    bindCompetitionRows(); bindTeamRows(); bindPlayerRows(); bindFollowButtons();
  }
  function allKnownPlayers() {
    const players = new Map(knownPlayers);
    for (const player of state.legacy?.players || []) {
      const id = player.playerId || player.jfwPlayerId;
      if (id) players.set(id, player);
    }
    return [...players.values()];
  }

  function searchSection(label, rows) {
    return `<section class="section"><div class="section-title"><h2>${label}</h2></div><div class="list-card">${rows || '<div class="empty-state"><strong>該当なし</strong>一致する項目はありません。</div>'}</div></section>`;
  }

  function competitionSearchRows(items) {
    return items.map(item => `<div class="entity-row is-link" data-competition-id="${esc(item.id)}" data-competition-name="${esc(item.name)}" data-competition-logo="${esc(item.logo || '')}" data-competition-season="${esc(item.seasonId || '')}">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">大会</div></div><span aria-hidden="true">›</span></div>`).join('');
  }

  function teamSearchRows(items) {
    return items.map(item => `<div class="entity-row is-link" data-team-id="${esc(item.id)}">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">クラブ</div></div><span aria-hidden="true">›</span></div>`).join('');
  }

  function bindTeamRows() {
    main.querySelectorAll('[data-team-id]').forEach(row => row.addEventListener('click', () => {

      setRoute(router.entityHash('teams', row.dataset.teamId, currentProductSeason()));
      applyCurrentRoute();
    }));
  }

  function renderTeamDetail(teamId, productSeason) {
    const team = allKnownTeams().find(item => String(item.id) === String(teamId));
    if (!team) {
      eyebrow.textContent = 'クラブ詳細'; title.textContent = 'クラブ';
      main.innerHTML = `${entityBackButton('クラブ一覧', '#/competitions')}<div class="notice">クラブ情報は未取得です。${state.loading ? '読み込み中…' : 'クラブ詳細の取得機能は準備中です。'}</div>`;
      bindEntityBack(); return;
    }
    setPageHeader('leagues');
    eyebrow.textContent = 'クラブ詳細';
    title.textContent = team.name || 'クラブ';
    const fixtures = [...knownFixtures.values()].filter(row => [row?.teams?.home?.id, row?.teams?.away?.id].some(id => String(id) === String(teamId)));
    const standing = knownStandings.get(teamId);
    const sameSeason = !productSeason || productSeason === currentProductSeason();
    const players = sameSeason ? (state.legacy?.players || []).filter(player => player.currentTeamId === teamId || player.currentMembership?.teamId === teamId).map(player => ({...player,displayStats:player.clubStats?.[teamId] || {}})) : [];
    const hasRoster = sameSeason && (state.legacy?.players || []).some(player => player.currentTeamId || player.currentMembership?.teamId);
    main.innerHTML = `${entityBackButton('クラブ一覧', '#/competitions')}<section class="entity-hero">${team.logo ? `<img src="${esc(team.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div><div class="eyebrow">${esc(productSeason || currentProductSeason())}</div><h2>${esc(team.name || team.id)}</h2></div></section><section class="section"><div class="section-title"><h2>概要</h2></div><div class="competition-summary"><div><strong>${valueCell(standing?.rank)}</strong><span>順位</span></div><div><strong>${valueCell(standing?.points)}</strong><span>勝点</span></div><div><strong>${valueCell(standing?.goalDifference)}</strong><span>得失点</span></div></div></section><section class="section"><div class="section-title"><h2>取得済みの試合</h2><span class="meta">${fixtures.length ? fixtures.length + '件（取得範囲内）' : '未取得'}</span></div>${fixtures.length ? `${['直近','今後'].map((label,index) => {const rows=fixtures.filter(row => (Date.parse(row.kickoffUtc) > Date.now()) === Boolean(index));return `<h3>${label}</h3>${rows.length ? `<div class="match-card">${rows.map(fixtureRow).join('')}</div>` : '<p class="notice">取得済みの範囲にはありません</p>'}`;}).join('')}` : `<div class="notice">試合 ${valueCell(null)}</div>`}</section><section class="section"><div class="section-title"><h2>順位表</h2><span class="meta">${standing?.seasonId ? esc(seasonLabel(standing.seasonId)) : ''}</span></div>${standing ? `<div class="standings-card">${standingRow(standing)}</div>` : '<div class="empty-state"><strong>順位表は未取得です</strong>未取得値を0として表示していません。</div>'}</section><section class="section"><div class="section-title"><h2>所属選手</h2><span class="meta">${hasRoster ? players.length + '人（追跡データ内）' : '未取得'}</span></div><div class="list-card">${hasRoster ? japaneseRows(players, 'このクラブの取得済み所属選手はありません。') : '<p class="notice">所属選手の対応データは未取得です。</p>'}</div></section>`;
    bindEntityBack();
    bindFixtureRows('team');
    bindPlayerRows();
    bindFollowButtons();
    bindImageFallbacks();
  }

  function findPlayer(playerId) {
    return allKnownPlayers().find(player => [player.playerId, player.jfwPlayerId].some(id => id && String(id) === String(playerId)));
  }

  function renderPlayerDetail(playerId, productSeason) {
    const player = findPlayer(playerId);
    if (!player) {
      eyebrow.textContent='選手詳細'; title.textContent='選手';
      main.innerHTML=`${entityBackButton('選手一覧','#/japanese')}<p class="notice">選手情報は未取得です。選手詳細の取得機能は準備中です。</p>`;bindEntityBack();return;
    }
    if(productSeason && currentProductSeason() && productSeason !== currentProductSeason()) return renderRouteError({status:400,code:'season_not_available'},router.entityHash('players',playerId,currentProductSeason()));
    const isTracked = (state.legacy?.players || []).includes(player) && player.trackingStatus === 'active';
    setPageHeader('japanese');
    eyebrow.textContent = '選手詳細';
    title.textContent = player.name;
    const stats = player.displayStats || player.seasonStats || player.stats || {};
    const facts = (state.legacy?.insights || []).filter(item => item.player === player.name);
    const analyses = (state.legacy?.analysis || []).filter(item => item.player === player.name);
    const history = Array.isArray(player.membershipHistory) ? player.membershipHistory : [];
    main.innerHTML = `${entityBackButton('日本人一覧', router.pageHash('japanese', productSeason || currentProductSeason()))}<section class="entity-hero">${personAvatar(player)}<div><div class="eyebrow">${esc(productSeason || currentProductSeason())}</div><h2>${esc(player.name)}</h2><p>${esc(player.pos || 'ポジション未取得')}</p></div></section><section class="detail-card profile-grid"><div><span>現在所属</span><strong>${esc(player.club || '未取得')}</strong></div><div><span>大会</span><strong>${esc(player.league || '未取得')}</strong></div><div><span>国籍</span><strong>${valueCell(player.nationality)}</strong></div><div><span>生年月日</span><strong>${valueCell(player.birth?.date || player.birthDate)}</strong></div><div><span>追跡</span>${isTracked ? `<strong class="tracking-badge">${icon('tracked-mark')} 海外日本人追跡</strong>` : valueCell(null,player.trackingStatus === 'out_of_scope' || knownPlayers.has(playerId) ? 'not_applicable' : 'not_fetched')}</div></section><section class="section"><div class="section-title"><h2>今季スタッツ</h2></div><div class="competition-summary"><div><strong>${valueCell(stats.apps)}</strong><span>出場</span></div><div><strong>${valueCell(stats.goals)}</strong><span>得点</span></div><div><strong>${valueCell(stats.assists)}</strong><span>アシスト</span></div><div><strong>${valueCell(stats.minutes)}</strong><span>出場分</span></div><div><strong>${valueCell(stats.redCards)}</strong><span>退場</span></div></div></section>${renderPlayerStyle(facts, analyses)}<section class="section"><div class="section-title"><h2>所属履歴</h2></div>${history.length ? `<div class="list-card">${history.map(item => `<div class="history-row"><strong>${esc(item.club || item.teamName || '未取得')}</strong><span>${esc(item.start || item.from || '—')} – ${esc(item.end || item.to || '現在')}</span></div>`).join('')}</div>` : Array.isArray(player.membershipHistory) ? '<p class="empty-result">該当なし</p>' : `<div class="notice">所属履歴 ${valueCell(null)}</div>`}</section><section class="section"><div class="section-title"><h2>大会別成績</h2></div>${aggregateRows(player.competitionStats,'competition',player)}</section><section class="section"><div class="section-title"><h2>クラブ別成績</h2></div>${aggregateRows(player.clubStats,'team',player)}</section>${renderRecentPlayerMatches(playerId)}`;
    bindEntityBack();
    bindImageFallbacks();
  }

  function statsSummary(stats = {}) {
    return `出場 ${valueCell(stats.apps)} · 得点 ${valueCell(stats.goals)} · アシスト ${valueCell(stats.assists)} · 出場分 ${valueCell(stats.minutes)}`;
  }
  function aggregateLabel(id, type, player) {
    const memberships = Array.isArray(player.membershipHistory) ? player.membershipHistory : [];
    if (type === 'competition') {
      const canonical = config.competitionAliases?.[id] || id;
      const configured = config.scope?.trackingLeagues?.find(item => item.id === canonical)?.label;
      const known = competitionDirectory().find(item => item.id === canonical)?.name;
      const alias = Object.entries(config.competitionAliases || {}).find(([,value]) => value === canonical)?.[0];
      const legacyLabel = player.league === id || memberships.some(item => item.league === id);
      return configured || (known && known !== canonical ? known : null) || alias || (legacyLabel ? id : '大会名は未取得');
    }
    const known = allKnownTeams().find(item => item.id === id);
    const membership = memberships.find(item => item.teamId === id);
    const currentId = player.currentTeamId || player.currentMembership?.teamId;
    // Legacy aggregates already use display names; preserve names explicitly
    // present in this player's data without turning them into another entity ID.
    const legacyLabel = player.club === id || memberships.some(item => (item.club || item.teamName) === id);
    return known?.name || membership?.teamName || membership?.club
      || (currentId === id ? player.club : null) || (legacyLabel ? id : 'クラブ名は未取得');
  }
  function aggregateRows(stats, type, player) {
    if (!stats || typeof stats !== 'object') return `<div class="notice">${valueCell(null)}</div>`;
    const entries = Object.entries(stats);
    return entries.length ? `<div class="list-card">${entries.map(([id,value]) => `<div class="history-row"><strong title="${esc(id)}">${esc(aggregateLabel(id,type,player))}</strong><span>${statsSummary(value)}</span></div>`).join('')}</div>` : '<p class="empty-result">該当なし</p>';
  }
  function renderRecentPlayerMatches(playerId) {
    const records = state.legacy?.playerMatchStats;
    let presence = data.section(state.legacy || {},'playerMatchStats');
    if (presence === 'present' && !Array.isArray(records)) presence = 'not_fetched';
    const matches = presence === 'present' ? records.filter(item => item.playerId === playerId) : [];
    const count = presence === 'present' ? matches.length : valueCell(null,presence);
    const content = presence !== 'present' ? `<div class="notice">直近試合 ${valueCell(null,presence)}</div>`
      : matches.length ? `<div class="list-card">${matches.map(item => `<div class="history-row"><strong>${esc(item.match)}</strong><span>${esc(item.reason || '')}</span></div>`).join('')}</div>`
      : '<p class="empty-result">該当なし</p>';
    return `<section class="section"><div class="section-title"><h2>直近試合</h2><span class="meta">${count}</span></div>${content}</section>`;
  }
  function renderPlayerStyle(facts, analyses) {
    if (!facts.length && !analyses.length) return '<section class="section"><div class="section-title"><h2>どんな選手か</h2></div><div class="empty-state"><strong>詳細データなし</strong>プレースタイルを断定できる詳細データはまだありません。</div></section>';
    return `<section class="section"><div class="section-title"><h2>どんな選手か</h2></div><div class="insights-grid">${facts.map(item => `<article class="insight-card is-fact"><h3>確認できた事実</h3><p>${esc(item.fact || '')}</p><h4>注目点</h4><p>${esc(item.why || '')}</p>${sourceLine(item.sources)}</article>`).join('')}${analyses.map(analysisCard).join('')}</div></section>`;
  }

  function entityBackButton(label, parentHash) {
    return `<div class="detail-top"><button class="back-button" data-entity-back="${esc(parentHash)}" type="button">← ${esc(label)}</button></div>`;
  }

  function bindEntityBack() {
    main.querySelector('[data-entity-back]')?.addEventListener('click', event => goBack(event.currentTarget.dataset.entityBack));
  }

  function renderRouteError(route, parentHash = '#/matches') {
    eyebrow.textContent = `HTTP ${route.status || 404}`;
    title.textContent = route.status === 400 ? 'シーズンを確認してください' : '対象が見つかりません';
    const message = route.status === 400 ? '指定されたシーズンは、この画面で利用できません。' : '指定されたデータを確認できませんでした。';
    const collection = location.hash.match(/^#\/(competitions|players|teams)\/([^?]+)/);
    const competition = collection?.[1] === 'competitions';
    let id = null; try {id = collection ? decodeURIComponent(collection[2]) : null;} catch { /* Router already rejects bad encoding. */ }
    const available = competition ? competitionDirectory().find(c => c.id === id)?.seasonId : currentProductSeason();
    const recovery = competition ? (available ? router.competitionHash(id,available) : '#/competitions')
      : collection ? router.entityHash(collection[1],id,available) : router.pageHash('japanese',available);
    if (competition) parentHash = '#/competitions';
    main.innerHTML = `<div class="empty-state route-error"><strong>${message}</strong>${route.status === 400 && available ? `<button class="plain-button" data-recovery-hash="${esc(recovery)}" type="button">取得済みシーズン ${esc(seasonLabel(available))} を開く</button>` : ''}<button id="routeErrorBack" class="plain-button" type="button">一覧へ戻る</button><button class="plain-button" data-open-search type="button">検索を開く</button></div>`;
    $('routeErrorBack').addEventListener('click', () => {setRoute(parentHash,{replace:true});applyCurrentRoute();});
    main.querySelector('[data-recovery-hash]')?.addEventListener('click',event => {setRoute(event.currentTarget.dataset.recoveryHash,{replace:true});applyCurrentRoute();});
  }

  function renderMore() {
    setPageHeader('more');
    const coverage = state.legacy?.dataCoverage || [];
    main.innerHTML = `${dataIntegrityNotice()}<div class="settings-grid"><section class="settings-block"><h3>データ取得状態</h3><p>${state.workerBase ? '試合データの接続設定が有効です。' : '試合データの接続は準備中です。取得済みの移行データを表示しています。'}</p></section><section class="settings-block"><h3>表示テーマ</h3><p>ライト / ダークは端末内に保存します。</p><button id="moreTheme" class="plain-button" type="button">テーマを切り替える</button></section><section class="settings-block"><h3>既存機能</h3><p>移行中も日本人追跡の旧画面は削除していません。</p><button id="legacyOpen" class="plain-button" type="button">旧画面を開く</button></section>${coverage.length ? `<section class="settings-block"><h3>既存データ取得状況</h3>${coverage.map(item => `<p><b>${esc(item.label)}</b> · ${esc(item.level)}<br>${esc(item.note)}</p>`).join('')}</section>` : ''}</div>`;
    $('moreTheme').addEventListener('click', toggleTheme);
    $('legacyOpen').addEventListener('click', () => { location.href = 'legacy.html'; });
  }

  function isFollowing(type,id) {
    return state.follows[type].some(item => item.id === id);
  }

  function isCompetitionFollowing(item) {
    return state.follows.competitions.some(row => row.id === item.id);
  }

  function toggleFollow(type,item) {
    if (!Object.hasOwn(state.follows,type) || !item.id) return;
    if (item.id.startsWith('legacy:') && !isFollowing(type,item.id)) return;
    const index = state.follows[type].findIndex(row => row.id === item.id);
    if (index >= 0) state.follows[type].splice(index,1); else state.follows[type].push({ id: item.id });
    saveFollows();
    repaint();
  }

  function bindFollowButtons() {
    main.querySelectorAll('[data-follow-type]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      toggleFollow(button.dataset.followType,{ id: button.dataset.followId, name: button.dataset.followName, logo: button.dataset.followLogo || '', seasonId: button.dataset.followSeason || null });
    }));
  }

  function setPageHeader(page) {
    const values = PAGE_TITLES[page] || PAGE_TITLES.matches;
    eyebrow.textContent = values[0];
    title.textContent = values[1];
  }

  function updateDataMode() {
    if (state.legacy?._dataIntegrity?.degraded && state.source !== 'core') dataMode.textContent = '移行データ・確認中';
    else if (state.source === 'core') dataMode.textContent = 'Core v2';
    else if (state.source === 'loading') dataMode.textContent = '準備中';
    else dataMode.textContent = '移行データ';
  }

  function renderCurrentPage() {
    state.detail = null;
    if (state.page === 'matches') renderMatches();
    if (state.page === 'leagues') renderLeagues();
    if (state.page === 'following') renderFollowing();
    if (state.page === 'japanese') renderJapanese();
    if (state.page === 'more') renderMore();
    updateDataMode();
  }

  function syncNav() {
    document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('is-active', button.dataset.page === state.page));
  }

  function navigate(page) {
    if (!PAGE_TITLES[page]) return;
    const hash = page === 'leagues'
      ? '#/competitions'
      : page === 'matches'
        ? matchRouteHash()
        : router.pageHash(page, page === 'japanese' ? currentProductSeason() : null);
    state.page = page;
    state.competitionDetail = null;
    state.detail = null;

    setRoute(hash);
    syncNav();
    renderCurrentPage();
    scrollTo({ top: 0, behavior: 'instant' });
  }

  function applyCurrentRoute() {
    navigation.activate();
    lastAppliedEntry = `${navigation.entry().key}:${location.hash}`;
    const route = router.parseHash(location.hash, {
      date: state.date || todayJst(),
      fixtureReturn: state.fixtureReturn || 'matches',
      returnPage: state.page || 'matches',
    });
    if (!location.hash || route.shouldReplace) setRoute(route.canonicalHash, { replace: true });
    state.route = route;
    state.routeError = route.kind === 'error' ? route : null;
    if (route.kind === 'error') {
      state.detail = null;
      state.competitionDetail = null;
      state.page = route.page;
      syncNav();
      renderRouteError(route);
      return;
    }

    if (route.kind === 'matches') {
      state.page = 'matches';
      state.detail = null;
      state.competitionDetail = null;
      state.date = route.date || todayJst();
      state.matchFilter = route.filter;
      syncNav();
      renderMatches();
      loadMatches();
      return;
    }

    if (route.kind === 'fixture') {
      state.page = ['competition', 'team'].includes(state.fixtureReturn) ? 'leagues' : 'matches';
      syncNav();
      openFixture(route.fixtureId, state.fixtureReturn, {
        routeDriven: true,
        tab: route.tab,
        playerId: route.playerId,
        ratingMode: route.ratingMode,
      });
      return;
    }

    if (route.kind === 'competitions') {
      state.page = 'leagues';
      state.detail = null;
      state.competitionDetail = null;
      syncNav();
      renderLeagues();
      return;
    }

    if (route.kind === 'competition') {
      const known = competitionDirectory().find(item => String(item.id) === String(route.competitionId)) || {
        id: route.competitionId,
        name: '大会情報は未取得',
        unresolved: true,
        logo: '',
        seasonId: route.competitionSeason,
      };
      openCompetition(known, {
        routeDriven: true,
        seasonId: route.competitionSeason || known.seasonId,
        tab: route.tab,
        date: route.date,
      });
      return;
    }

    state.detail = null;
    state.competitionDetail = null;
    if (route.kind === 'search') {
      state.searchQuery = route.query;
      renderSearch();
      return;
    }
    if (route.kind === 'team') {
      state.page = 'leagues';
      syncNav();
      renderTeamDetail(route.entityId, route.productSeason);
      return;
    }
    if (route.kind === 'player') {
      state.page = 'japanese';
      syncNav();
      renderPlayerDetail(route.entityId, route.productSeason);
      return;
    }
    state.page = route.page;
    syncNav();
    renderCurrentPage();
  }

  new MutationObserver(() => navigation.rendered()).observe(main, { childList: true, subtree: true });
  let lastAppliedEntry = '';
  let routeApplyScheduled = false;
  function scheduleRouteApply() {
    if (routeApplyScheduled) return;
    routeApplyScheduled = true;
    queueMicrotask(() => {
      routeApplyScheduled = false;
      const identity = `${navigation.entry().key}:${location.hash}`;
      if (identity === lastAppliedEntry) return;
      lastAppliedEntry = identity;
      applyCurrentRoute();
    });
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('football-v2-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f1f3f5' : '#101214';
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  }

  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
  searchButton.innerHTML = icon('search');
  main.addEventListener('click', event => {
    if (event.target.closest('[data-retry]')) { if (router.parseHash(location.hash).kind === 'japanese' && config.attentionEnabled) loadAttention(currentProductSeason()); else applyCurrentRoute(); }
    if (event.target.closest('[data-open-search]')) searchButton.click();
  });
  searchButton.addEventListener('click', () => {
    state.searchReturnPage = state.page;

    setRoute(router.searchHash(''));
    applyCurrentRoute();
    $('globalSearch')?.focus();
  });
  themeButton.addEventListener('click', toggleTheme);
  window.addEventListener('popstate', scheduleRouteApply);
  window.addEventListener('hashchange', scheduleRouteApply);
  applyTheme(localStorage.getItem('football-v2-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  loadLegacy().then(() => {
    const migrated = router.migrateLegacy(location.search, location.hash, {
      players: allKnownPlayers().map(p => ({ id: p.corePlayerId || p.playerId, name: p.name })),
      teams: allKnownTeams(),
    });
    if (migrated) history.replaceState(history.state, '', `${location.pathname}${migrated.search}${migrated.hash}`);
    applyCurrentRoute();
    if (state.page !== 'matches') loadMatches();
  });
})();
