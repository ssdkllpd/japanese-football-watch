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
    hasInternalBackTarget: false,
  };

  function setRoute(hash, { replace = false } = {}) {
    const method = replace ? 'replaceState' : 'pushState';
    history[method](null, '', `${location.pathname}${location.search}${hash}`);
  }

  function matchRouteHash() {
    return router.matchesHash(state.date, state.matchFilter);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[char]));
  }

  function readWorkerBase() {
    const configured = String(window.FOOTBALL_V2_API_BASE || '').trim();
    const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const query = localPreview ? new URL(location.href).searchParams.get('api') : null;
    const saved = localPreview ? (localStorage.getItem('football-v2-api-base') || localStorage.getItem('jfw-v2-api-base')) : null;
    return String(query || saved || configured)
      .trim().replace(/\/+$/, '');
  }

  function readFollows() {
    try {
      const value = JSON.parse(localStorage.getItem('football-v2-follows') || '{}');
      return {
        competitions: Array.isArray(value.competitions) ? value.competitions : [],
        teams: Array.isArray(value.teams) ? value.teams : [],
        players: Array.isArray(value.players) ? value.players : [],
      };
    } catch {
      return { competitions: [], teams: [], players: [] };
    }
  }

  function saveFollows() {
    localStorage.setItem('football-v2-follows', JSON.stringify(state.follows));
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
    return FINAL_STATUSES.has(statusShort(row)) || ['FINALIZED', 'PROVISIONAL_FINAL'].includes(String(row?.ingestionState || '').toUpperCase());
  }

  function isCancelled(row) {
    return ['CANC', 'PST', 'ABD', 'AWD', 'WO'].includes(statusShort(row));
  }

  async function apiFetch(path) {
    if (!state.workerBase) throw new Error('Worker未設定');
    const response = await fetch(`${state.workerBase}${path}`, { headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
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
    const errors = Array.isArray(integrity.errors) ? integrity.errors.filter(Boolean) : [];
    const detail = errors.length ? `<br><span class="entity-sub">${esc(errors.join(' / '))}</span>` : '';
    return `<div class="notice"><strong>追跡データの整合性警告</strong><br>backfillを完全適用できていないため、表示中の移行データは不完全な可能性があります。未取得を0として補完していません。${detail}</div>`;
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
    if (state.page === 'matches' && !state.detail) renderMatches();
    if (state.page === 'leagues' && !state.detail && !state.competitionDetail) renderLeagues();
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
            if (String(error.message).includes('Not found')) return { fixtures: [] };
            throw error;
          }),
          requestedDate === todayJst() ? apiFetch('/api/v2/live').catch(() => ({ fixtures: [] })) : Promise.resolve({ fixtures: [] }),
        ]);
        const baseRows = Array.isArray(index?.fixtures) ? index.fixtures : [];
        const liveRows = (Array.isArray(live?.fixtures) ? live.fixtures : []).map(normalizeLive);
        const merged = new Map(baseRows.map(row => [row.fixtureId, row]));
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
    const trackedClubs = new Set((state.legacy?.players || []).map(player => String(player.club || '').trim().toLowerCase()).filter(Boolean));
    return [row?.teams?.home?.name, row?.teams?.away?.name]
      .some(name => trackedClubs.has(String(name || '').trim().toLowerCase()));
  }

  function filteredFixtures() {
    if (state.matchFilter === 'live') return state.fixtures.filter(isLive);
    if (state.matchFilter === 'following') return state.fixtures.filter(fixtureIsFollowed);
    if (state.matchFilter === 'japanese') return state.fixtures.filter(fixtureHasTrackedJapanese);
    return state.fixtures;
  }

  function fixtureTeam(team, score) {
    const logo = team?.logo ? `<img class="team-logo" src="${esc(team.logo)}" alt="" loading="lazy">` : '<span></span>';
    return `<div class="team-line">${logo}<span class="team-name">${esc(team?.name || team?.id || '未取得')}</span><span class="team-score">${score ?? '—'}</span></div>`;
  }

  function fixtureRow(row) {
    const short = statusShort(row);
    const time = isLive(row) ? `<span class="live-time">${esc(row?.status?.elapsed ? `${row.status.elapsed}′` : short || 'LIVE')}</span>` : (row.kickoffDisplay || formatKickoff(row.kickoffUtc));
    const status = isLive(row) ? short || 'LIVE' : (isFinal(row) ? '終了' : (isCancelled(row) ? '中止' : short || '予定'));
    return `<article class="fixture-row" data-fixture="${esc(row.fixtureId)}">
      <div class="fixture-time">${time}</div>
      <div class="teams">
        ${fixtureTeam(row?.teams?.home, row?.score?.goals?.home)}
        ${fixtureTeam(row?.teams?.away, row?.score?.goals?.away)}
      </div>
      <span class="status-pill${isLive(row) ? ' is-live' : ''}${isFinal(row) ? ' is-final' : ''}${isCancelled(row) ? ' is-cancelled' : ''}">${esc(status)}</span>
    </article>`;
  }

  function competitionKey(row) {
    return row.competitionName || row?.competition?.name || row.competitionId || '大会未取得';
  }

  function groupFixtures(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = competitionKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const followIds = new Set(state.follows.competitions.map(item => item.id));
    return [...groups.entries()].sort((a, b) => {
      const aId = a[1][0]?.competitionId;
      const bId = b[1][0]?.competitionId;
      return Number(followIds.has(bId)) - Number(followIds.has(aId)) || a[0].localeCompare(b[0], 'ja');
    });
  }

  function renderMatches() {
    setPageHeader('matches');
    const rows = filteredFixtures();
    const sourceNote = state.source === 'core' ? '' : `<div class="notice">Core feedの接続前/取得失敗時は、既存の確認済みデータだけを移行表示しています。未取得を0にはしていません。</div>`;
    const integrityNote = state.source === 'core' ? '' : dataIntegrityNotice();
    const personalNote = ['following', 'japanese'].includes(state.matchFilter)
      ? '<div class="notice">この絞り込みは端末内のフォロー状態・追跡データに依存するため、同じURLでも端末によって結果が変わることがあります。</div>'
      : '';
    const filters = [
      ['all', 'すべて'],
      ['live', '● LIVE'],
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
        japanese: 'この日に追跡対象選手の所属クラブの試合はありません。',
        all: 'この日付の試合データはまだ取得されていません。',
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
    main.querySelectorAll('[data-fixture]').forEach(row => row.addEventListener('click', () => openFixture(row.dataset.fixture, returnView)));
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
      state.hasInternalBackTarget = true;
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
    } catch (error) {
      if (state.detail !== detailRequest) return;
      detailRequest.error = error.message;
    }
    if (state.detail !== detailRequest) return;
    detailRequest.loading = false;
    renderFixtureDetail();
  }

  function renderFixtureDetail() {
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
      <section class="detail-card score-hero"><div class="score-meta">${esc(comp)} · ${esc(formatKickoff(row.kickoffUtc))} JST</div><div class="score-grid"><div class="score-team">${homeLogo}<strong>${esc(home.name || 'Home')}</strong>${followTeamButton(home)}</div><div class="score-value">${row?.score?.goals?.home ?? '—'} - ${row?.score?.goals?.away ?? '—'}</div><div class="score-team">${awayLogo}<strong>${esc(away.name || 'Away')}</strong>${followTeamButton(away)}</div></div></section>
      <div class="detail-tabs" role="tablist" aria-label="試合詳細">${tabs.map(([tab, label]) => `<button class="detail-tab${state.detailTab === tab ? ' is-active' : ''}" data-detail-tab="${tab}" type="button" role="tab" aria-selected="${state.detailTab === tab}">${label}</button>`).join('')}</div>
      ${detail.loading ? '<div class="notice">試合詳細を読み込み中…</div>' : renderDetailBody(detail)}`;
    $('detailBack').addEventListener('click', () => {
      if (state.hasInternalBackTarget) {
        state.hasInternalBackTarget = false;
        history.back();
        return;
      }
      const parentHash = returnToCompetition
        ? router.competitionHash(state.competitionDetail.id, state.competitionDetail.seasonId, state.competitionDetail.tab)
        : matchRouteHash();
      setRoute(parentHash, { replace: true });
      applyCurrentRoute();
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
    bindImageFallbacks();
    bindTeamRows();
  }

  function bindRatingControls(row) {
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
    if (detail.error) return `<div class="notice">詳細データはまだCoreにありません。試合一覧のスコア/状態はそのまま利用できます。<br>${esc(detail.error)}</div>`;
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
    else if (['CANC', 'PST', 'ABD', 'AWD', 'WO'].includes(statusShort(row))) label = '中止・延期';
    return `<section class="detail-card fixture-state-card"><div><span>状態</span><strong>${esc(label)}</strong></div><div><span>ステータス</span><strong>${esc(statusShort(row) || row.ingestionState || '未取得')}</strong></div></section>`;
  }

  function renderEvents(bundle) {
    const events = Array.isArray(bundle.events) ? bundle.events : [];
    if (!events.length) return '<div class="notice">イベントは未取得、またはprovider側にありません。</div>';
    return `<section class="detail-card">${events.map(event => `<div class="event-row"><div class="event-minute">${event.elapsed ?? '—'}′</div><div><b>${esc(event.type || 'event')}</b> ${esc(event.detail || '')}<div class="entity-sub">${esc(event.playerId || '')}</div></div></div>`).join('')}</section>`;
  }

  function renderLineups(bundle) {
    const lineups = Array.isArray(bundle.lineups) ? bundle.lineups : [];
    if (!lineups.length) return '<div class="notice">ラインナップは未取得、またはprovider側にありません。</div>';
    return lineups.map(lineup => {
      const starters = Array.isArray(lineup.startXI) ? lineup.startXI : [];
      const substitutes = Array.isArray(lineup.substitutes) ? lineup.substitutes : [];
      const api = window.JFWFormation;
      const laidOut = api?.layoutPlayers ? api.layoutPlayers(starters, lineup.formation) : starters;
      const confidence = laidOut?.layoutMeta?.confidence || 'none';
      const team = [bundle?.fixture?.teams?.home, bundle?.fixture?.teams?.away].find(item => item?.id === lineup.teamId);
      const coach = lineup.coach;
      const teamTitle = team?.id
        ? `<button class="lineup-team-link" data-team-id="${esc(team.id)}" type="button">${esc(team.name || team.id)} · ${esc(lineup.formation || 'Formation未取得')}</button>`
        : `<span>${esc(team?.name || lineup.teamId || 'Team')} · ${esc(lineup.formation || 'Formation未取得')}</span>`;
      return `<section class="detail-card lineup-card"><div class="pitch-card"><div class="pitch-title">${teamTitle}<span class="estimate confidence-${esc(confidence)}">配置確度: ${esc(confidence)}</span></div><div class="pitch">${laidOut.map(player => `<div class="pitch-player" style="left:${Number(player.x) || 50}%;top:${Number(player.y) || 50}%"><span class="pitch-disc">${esc(player.number ?? '—')}</span><span>${esc(player.name || '選手')}</span></div>`).join('')}</div></div>
        <div class="lineup-list"><h3>先発 ${starters.length}</h3>${starters.map(player => lineupPersonRow(player, bundle, 'starter')).join('') || '<div class="notice">先発は未取得です。</div>'}</div>
        <div class="lineup-list"><h3>ベンチ ${substitutes.length}</h3>${substitutes.map(player => lineupPersonRow(player, bundle, 'substitute')).join('') || '<div class="notice">ベンチは未取得です。</div>'}</div>
        <div class="coach-row">${personAvatar(coach, 'coach')}<div><span>監督</span><strong>${esc(coach?.name || '監督未取得')}</strong></div></div>
      </section>`;
    }).join('');
  }

  function personAvatar(person, kind = 'player') {
    const name = String(person?.name || (kind === 'coach' ? '監督' : '選手'));
    const initials = name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || '—';
    if (person?.photo) return `<span class="person-photo person-avatar"><span class="person-initials" aria-hidden="true">${esc(initials)}</span><img src="${esc(person.photo)}" alt="" loading="lazy"></span>`;
    return `<span class="person-photo person-fallback" aria-hidden="true">${esc(initials)}</span>`;
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
    return `<div class="lineup-person">${personAvatar(player)}<span class="shirt-number">${esc(player.number ?? '—')}</span><div><strong>${esc(player.name || '選手')}</strong><span>${esc(player.position || '')}</span></div>${substitution ? `<b class="substitution ${role === 'starter' ? 'is-out' : 'is-in'}">${esc(substitution)}</b>` : ''}</div>`;
  }

  function renderPlayerRatings(bundle) {
    const rows = Array.isArray(bundle.playerStats) ? bundle.playerStats : [];
    if (!rows.length) return '<div class="notice">選手評価は未取得、またはprovider側にありません。</div>';
    const fixtureId = bundle?.fixture?.fixtureId || bundle?.fixture?.id || state.detail?.summary?.fixtureId;
    const modeLabel = state.ratingMode === 'jfw' ? 'JFW 独自評価' : 'API-Football 評価';
    return `<div class="rating-switch" role="group" aria-label="評価方式"><button class="chip${state.ratingMode === 'provider' ? ' is-active' : ''}" data-rating-mode="provider" type="button">API-Football</button><button class="chip${state.ratingMode === 'jfw' ? ' is-active' : ''}" data-rating-mode="jfw" type="button">JFW 独自評価</button></div>
      <section class="detail-card"><div class="section-title"><h2>${modeLabel}</h2></div>${rows.map(row => {
        const providerRating = row?.values?.rating;
        const jfwRating = row?.jfwRating?.value ?? row?.jfwRating ?? null;
        const value = state.ratingMode === 'jfw' ? jfwRating : providerRating;
        const playerId = row.playerId || row.id;
        return `<button class="rating-row" data-rating-player="${esc(playerId || '')}" type="button"${state.ratingMode !== 'jfw' || !playerId ? ' disabled' : ''}>${personAvatar({ name: row.playerName, photo: row.playerPhoto })}<span><strong>${esc(row.playerName || playerId || '選手')}</strong><small>${esc(row.position || '')}</small></span><b>${value ?? '未取得'}</b></button>`;
      }).join('')}</section>${state.ratingPlayerId ? renderRatingBreakdown(rows.find(row => String(row.playerId || row.id) === String(state.ratingPlayerId))) : ''}`;
  }

  function renderRatingBreakdown(row) {
    if (!row) return '<div class="notice">指定された選手評価は取得できません。</div>';
    const factors = row?.jfwRating?.factors || row?.ratingFactors || null;
    if (!factors || typeof factors !== 'object') return `<section class="detail-card rating-breakdown"><h3>${esc(row.playerName || '選手')} · JFW Rating 要因分解</h3><div class="notice">要因データは未取得です。欠落を±0.00として表示していません。</div></section>`;
    return `<section class="detail-card rating-breakdown"><h3>${esc(row.playerName || '選手')} · JFW Rating 要因分解</h3>${Object.entries(factors).map(([key, value]) => `<div><span>${esc(key)}</span><strong>${value === null || value === undefined ? '未取得' : esc(value)}</strong></div>`).join('')}</section>`;
  }

  function renderTeamStats(bundle) {
    const stats = Array.isArray(bundle.teamStats) ? bundle.teamStats : [];
    if (!stats.length) return '<div class="notice">チームスタッツは未取得、またはprovider側にありません。</div>';
    const homeId = bundle?.fixture?.teams?.home?.id;
    const awayId = bundle?.fixture?.teams?.away?.id;
    const home = stats.find(row => row.teamId === homeId)?.values || {};
    const away = stats.find(row => row.teamId === awayId)?.values || {};
    const keys = [...new Set([...Object.keys(home), ...Object.keys(away)])];
    return `<section class="detail-card">${keys.map(key => `<div class="team-stat-row"><span class="home">${home[key] ?? '—'}</span><span class="label">${esc(key.replaceAll('_',' '))}</span><span class="away">${away[key] ?? '—'}</span></div>`).join('')}</section>`;
  }

  function followTeamButton(team) {
    if (!team?.id) return '';
    const on = isFollowing('teams', team.id);
    return `<button class="follow-button${on ? ' is-following' : ''}" data-follow-type="teams" data-follow-id="${esc(team.id)}" data-follow-name="${esc(team.name || team.id)}" data-follow-logo="${esc(team.logo || '')}" type="button">${on ? '★ フォロー中' : '☆ フォロー'}</button>`;
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
    const unique = new Map();
    const byName = new Map();
    const add = item => {
      if (!item?.id || !item?.name) return;
      const nameKey = item.name.trim().toLocaleLowerCase('ja');
      const existingId = byName.get(nameKey);
      if (existingId && existingId !== item.id) {
        const existing = unique.get(existingId);
        const existingIsLegacy = String(existingId).startsWith('legacy:');
        const incomingIsLegacy = String(item.id).startsWith('legacy:');
        if (!existingIsLegacy && incomingIsLegacy) return;
        if (existingIsLegacy && !incomingIsLegacy) {
          unique.delete(existingId);
          unique.set(item.id, {
            ...existing,
            ...item,
            logo: item.logo || existing?.logo || '',
            seasonId: item.seasonId || existing?.seasonId || null,
          });
          byName.set(nameKey, item.id);
          return;
        }
      }
      const current = unique.get(item.id) || {};
      unique.set(item.id, {
        ...current,
        ...item,
        logo: item.logo || current.logo || '',
        seasonId: item.seasonId || current.seasonId || null,
      });
      byName.set(nameKey, item.id);
    };
    for (const player of state.legacy?.players || []) {
      add({ id: `legacy:competition:${player.league}`, name: player.league, logo: '', seasonId: null });
    }
    for (const item of state.follows.competitions) add(item);
    for (const row of state.fixtures) {
      add({
        id: row.competitionId || competitionKey(row),
        name: competitionKey(row),
        logo: row?.competition?.logo || '',
        seasonId: row.seasonId || null,
      });
    }
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, 'ja'));
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
      return `<div class="entity-row is-link" data-competition-id="${esc(item.id)}" data-competition-name="${esc(item.name)}" data-competition-logo="${esc(item.logo || '')}" data-competition-season="${esc(item.seasonId || '')}">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">${esc(item.seasonId ? `シーズン ${seasonLabel(item.seasonId)}` : item.id)}</div></div><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="competitions" data-follow-id="${esc(item.id)}" data-follow-name="${esc(item.name)}" data-follow-logo="${esc(item.logo || '')}" data-follow-season="${esc(item.seasonId || '')}" type="button">${on ? '★' : '☆'}</button></div>`;
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
    state.competitionDetail = {
      ...item,
      seasonId: options.seasonId || item.seasonId || null,
      date: state.date,
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
      state.hasInternalBackTarget = true;
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
        presence = 'present';
      } catch (error) {
        if (!String(error.message).includes('Not found')) matchesError = error.message;
      }
    }
    if (loadSequence !== state.competitionLoadSequence || state.competitionDetail !== detail) return;
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
      detail.standingsError = 'Football Data Workerを設定すると順位表を取得できます。';
      renderCompetitionDetailIfVisible();
      return;
    }
    try {
      detail.standings = await apiFetch(`/api/v2/competitions/${encodeURIComponent(detail.id)}/seasons/${encodeURIComponent(detail.seasonId)}/standings`);
    } catch (error) {
      detail.standingsError = String(error.message).includes('Not found')
        ? 'このシーズンの順位表はまだ取り込まれていません。'
        : `順位表を取得できませんでした: ${error.message}`;
    }
    if (state.competitionDetail !== detail) return;
    detail.standingsLoading = false;
    renderCompetitionDetailIfVisible();
  }

  function renderCompetitionDetailIfVisible() {
    if (state.page === 'leagues' && state.competitionDetail && !state.detail) renderCompetitionDetail();
  }

  function renderCompetitionDetail() {
    const detail = state.competitionDetail;
    if (!detail) {
      renderLeagues();
      return;
    }
    setPageHeader('leagues');
    const on = isCompetitionFollowing(detail);
    const tabs = [
      ['matches', '試合'],
      ['standings', '順位表'],
      ['overview', '概要'],
      ['players', '選手成績'],
      ['teams', 'チーム成績'],
    ];
    main.innerHTML = `<div class="detail-top"><button id="competitionBack" class="back-button" type="button">← リーグ一覧</button><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="competitions" data-follow-id="${esc(detail.id)}" data-follow-name="${esc(detail.name)}" data-follow-logo="${esc(detail.logo || '')}" data-follow-season="${esc(detail.seasonId || '')}" type="button">${on ? '★ フォロー中' : '☆ フォロー'}</button></div>
      <section class="competition-hero">${detail.logo ? `<img src="${esc(detail.logo)}" alt="">` : '<span class="competition-placeholder">🏆</span>'}<div><div class="eyebrow">${esc(detail.seasonId ? `Season ${seasonLabel(detail.seasonId)}` : 'Competition')}</div><h2>${esc(detail.name)}</h2></div></section>
      ${detail.seasonId ? `<label class="season-select-label" for="competitionSeason">シーズン<select id="competitionSeason" class="season-select"><option value="${esc(detail.seasonId)}">${esc(seasonLabel(detail.seasonId))}</option></select></label>` : ''}
      <div class="detail-tabs" role="tablist" aria-label="リーグ詳細">${tabs.map(([tab, label]) => `<button class="detail-tab${detail.tab === tab ? ' is-active' : ''}" data-competition-tab="${tab}" type="button" role="tab" aria-selected="${detail.tab === tab}">${label}</button>`).join('')}</div>
      ${renderCompetitionTab(detail)}`;
    $('competitionBack').addEventListener('click', () => {
      if (state.hasInternalBackTarget) {
        state.hasInternalBackTarget = false;
        history.back();
        return;
      }
      setRoute('#/competitions', { replace: true });
      applyCurrentRoute();
    });
    main.querySelectorAll('[data-competition-tab]').forEach(button => button.addEventListener('click', () => {
      detail.tab = button.dataset.competitionTab;
      setRoute(router.competitionHash(detail.id, detail.seasonId, detail.tab), { replace: true });
      renderCompetitionDetail();
    }));
    main.querySelectorAll('[data-competition-date]').forEach(button => button.addEventListener('click', () => {
      detail.date = button.dataset.competitionDate;
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
    const warning = detail.matchesError ? `<div class="notice">試合データを取得できませんでした: ${esc(detail.matchesError)}</div>` : '';
    if (detail.matchesLoading) body = '<div class="notice">リーグの試合を読み込み中…</div>';
    else if (detail.matchesPresence !== 'present') body = warning || '<div class="empty-state"><strong>試合データは未取得です</strong>未取得を0試合として表示していません。</div>';
    else if (!detail.fixtures.length) body = `${warning}<div class="empty-state"><strong>この日の試合はありません</strong>取得済みの日付インデックスは0試合です。</div>`;
    else body = `${warning}<div class="match-card">${detail.fixtures.map(fixtureRow).join('')}</div>`;
    return `${renderCompetitionDateStrip(detail)}${summary}${body}`;
  }

  function renderCompetitionStandings(detail) {
    if (detail.standingsLoading) return '<div class="notice">順位表を読み込み中…</div>';
    if (detail.standingsError) return `<div class="notice">${esc(detail.standingsError)}</div>`;
    const groups = Array.isArray(detail.standings?.groups) ? detail.standings.groups : [];
    if (!groups.length) return '<div class="empty-state"><strong>順位表は未取得です</strong>未取得の順位・勝点を0として表示していません。</div>';
    return groups.map(group => `<section class="section"><div class="section-title"><h2>${esc(group.name || '順位表')}</h2><span class="meta">${group.table?.length || 0}クラブ</span></div><div class="standings-card"><div class="standings-row standings-head"><span>#</span><span>クラブ</span><span>試</span><span>差</span><span>勝点</span></div>${(group.table || []).map(standingRow).join('')}</div></section>`).join('');
  }

  function standingRow(row) {
    const team = row?.team || {};
    return `<div class="standings-row${team.id ? ' is-link' : ''}"${team.id ? ` data-team-id="${esc(team.id)}"` : ''}><span class="standings-rank">${row?.rank ?? '—'}</span><span class="standings-team">${team.logo ? `<img src="${esc(team.logo)}" alt="">` : ''}<b>${esc(team.name || team.id || '未取得')}</b></span><span>${row?.overall?.played ?? '—'}</span><span>${row?.goalDifference ?? '—'}</span><strong>${row?.points ?? '—'}</strong></div>`;
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
    if (!rows.length) return '<div class="empty-state"><strong>まだフォローなし</strong>試合・リーグ・日本人画面から追加できます。</div>';
    return rows.map(item => {
      const linkAttributes = type === 'competitions'
        ? ` data-competition-id="${esc(item.id)}" data-competition-name="${esc(item.name)}" data-competition-logo="${esc(item.logo || '')}" data-competition-season="${esc(item.seasonId || '')}"`
        : type === 'teams'
          ? ` data-team-id="${esc(item.id)}"`
          : ` data-player-id="${esc(item.id)}"`;
      return `<div class="entity-row is-link"${linkAttributes}>${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">${esc(item.id)}</div></div><button class="follow-button is-following" data-follow-type="${type}" data-follow-id="${esc(item.id)}" data-follow-name="${esc(item.name)}" data-follow-logo="${esc(item.logo || '')}" data-follow-season="${esc(item.seasonId || '')}" type="button">解除</button></div>`;
    }).join('');
  }

  function renderJapanese() {
    setPageHeader('japanese');
    const players = (state.legacy?.players || []).slice().sort((a,b) => (Number(b.rating)||0)-(Number(a.rating)||0) || (Number(b?.stats?.goals)||0)+(Number(b?.stats?.assists)||0) - ((Number(a?.stats?.goals)||0)+(Number(a?.stats?.assists)||0)));
    const q = state.legacySearch.trim().toLowerCase();
    const filtered = players.filter(player => !q || `${player.name} ${player.club} ${player.league}`.toLowerCase().includes(q));
    main.innerHTML = `${dataIntegrityNotice()}<div class="notice">日本人追跡は総合データアプリのオプション機能です。既存の追跡データ/JFW Ratingは削除せず、Core factsへ順次接続します。</div><input id="japaneseSearch" class="search-box" placeholder="日本人選手を検索" value="${esc(state.legacySearch)}" autocomplete="off"><section class="section"><div class="section-title"><h2>追跡選手一覧・ランキング</h2><span class="meta">シーズン全体 · ${filtered.length}人</span></div><div id="japaneseList" class="list-card">${japaneseRows(filtered)}</div></section>${renderAttentionRanking()}${renderTrackingInsights()}`;
    $('japaneseSearch').addEventListener('input', event => { state.legacySearch = event.target.value; const next = players.filter(player => !state.legacySearch.trim() || `${player.name} ${player.club} ${player.league}`.toLowerCase().includes(state.legacySearch.trim().toLowerCase())); $('japaneseList').innerHTML = japaneseRows(next); bindFollowButtons(); bindPlayerRows(); });
    bindFollowButtons();
    bindPlayerRows();
  }

  function japaneseRows(players) {
    if (!players.length) return '<div class="empty-state"><strong>該当選手なし</strong>検索条件を変えてください。</div>';
    return players.slice(0,80).map(player => {
      const stats = player.seasonStats || player.stats || {};
      const id = `jfw:${player.name}`;
      const on = isFollowing('players',id);
      const photo = player.photo ? `<img class="entity-logo" src="${esc(player.photo)}" alt="" loading="lazy">` : '<span class="entity-logo"></span>';
      return `<div class="entity-row is-link" data-player-id="${esc(player.playerId || player.jfwPlayerId || id)}">${photo}<div class="entity-main"><div class="entity-name">${esc(player.name)}</div><div class="entity-sub">${esc(player.club || 'クラブ未取得')} · ${esc(player.league || 'リーグ未取得')} · ${esc(player.pos || '')}</div><div class="stat-inline"><span>出場 <b>${stats.apps ?? '—'}</b></span><span>G <b>${stats.goals ?? '—'}</b></span><span>A <b>${stats.assists ?? '—'}</b></span><span>${esc(player.status || '')}</span></div></div><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="players" data-follow-id="${esc(id)}" data-follow-name="${esc(player.name)}" data-follow-logo="${esc(player.photo || '')}" type="button" aria-label="${esc(player.name)}を${on ? 'フォロー解除' : 'フォロー'}">${on ? '★' : '☆'}</button></div>`;
    }).join('');
  }

  function renderAttentionRanking() {
    const candidates = Array.isArray(state.legacy?.topMatches) ? state.legacy.topMatches : [];
    const displayedScore = item => item.displayedScore ?? item.displayed_score;
    const missing = candidates.filter(item => displayedScore(item) === null || displayedScore(item) === undefined);
    const attentionHasMissing = missing.length > 0;
    const followedPlayers = state.follows.players.map(item => item.name).filter(Boolean);
    const followedTeams = state.follows.teams.map(item => item.name).filter(Boolean);
    const ranked = candidates.filter(item => Number(displayedScore(item)) >= 16).map(item => {
      const playerBoost = followedPlayers.some(name => String(item.players || '').includes(name)) ? 0.15 : 0;
      const teamBoost = followedTeams.some(name => String(item.match || '').includes(name)) ? 0.10 : 0;
      const multiplier = Math.min(1.25, 1 + playerBoost + teamBoost);
      return { ...item, multiplier, personalScore: Math.round(Number(displayedScore(item)) * multiplier * 100) / 100 };
    }).filter(item => item.personalScore >= 20).sort((a, b) => b.personalScore - a.personalScore);
    const version = candidates.find(item => item.attentionVersion || item.attention_version)?.attentionVersion
      || candidates.find(item => item.attention_version)?.attention_version
      || '未取得';
    return `<section class="section"><div class="section-title"><h2>視聴価値ランキング</h2><span class="meta">attention_version: ${esc(version)}</span></div>${ranked.length ? `<div class="list-card">${ranked.map((item, index) => `<div class="attention-row"><b>${index + 1}</b><div><strong>${esc(item.match || '試合')}</strong><span>${esc(item.reason || '')}</span><small>base ${esc(item.baseScore ?? item.base_score ?? '未取得')}</small>${item.multiplier > 1 ? `<small>フォロー係数 ×${item.multiplier.toFixed(2)}</small>` : ''}</div><strong>${item.personalScore.toFixed(2)}</strong></div>`).join('')}</div>` : '<div class="empty-state"><strong>表示できる視聴価値ランキングはありません</strong>全候補取得後に、個人スコア20.00以上だけを表示します。</div>'}${attentionHasMissing ? `<div class="notice">${missing.length}件は視聴価値が未算出のため除外しています。価値0としては扱っていません。</div>` : ''}</section>`;
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
    return `<div class="source-line">出典: ${sources.length ? esc(sources.join(' / ')) : '未取得'}</div>`;
  }

  function bindPlayerRows() {
    main.querySelectorAll('[data-player-id]').forEach(row => row.addEventListener('click', event => {
      if (event.target.closest('[data-follow-type]')) return;
      state.hasInternalBackTarget = true;
      setRoute(router.entityHash('players', row.dataset.playerId, currentProductSeason()));
      applyCurrentRoute();
    }));
  }

  function currentProductSeason() {
    return state.legacy?._dataIntegrity?.season
      ? `jfw:season:${state.legacy._dataIntegrity.season}`
      : 'jfw:season:2026-27';
  }

  function allKnownTeams() {
    const teams = new Map();
    const add = item => {
      if (!item?.id || !item?.name) return;
      teams.set(String(item.id), item);
    };
    for (const item of state.follows.teams) add(item);
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
    setPageHeader('matches');
    eyebrow.textContent = '共通検索';
    title.textContent = '検索';
    const query = state.searchQuery.trim().toLowerCase();
    const competitions = competitionDirectory().filter(item => !query || item.name.toLowerCase().includes(query));
    const teams = allKnownTeams().filter(item => !query || String(item.name).toLowerCase().includes(query));
    const players = (state.legacy?.players || []).filter(item => !query || `${item.name} ${item.club} ${item.league}`.toLowerCase().includes(query));
    main.innerHTML = `<div class="detail-top"><button id="searchBack" class="back-button" type="button">← 閉じる</button></div><label class="sr-only" for="globalSearch">大会・クラブ・選手を検索</label><input id="globalSearch" class="search-box" type="search" value="${esc(state.searchQuery)}" placeholder="大会・クラブ・選手を検索" autocomplete="off">${query ? `${searchSection('大会', competitionSearchRows(competitions))}${searchSection('クラブ', teamSearchRows(teams))}${searchSection('選手', japaneseRows(players.slice(0, 30)))}` : '<div class="empty-state"><strong>検索語を入力してください</strong>大会・クラブ・選手を横断して探せます。</div>'}`;
    $('searchBack').addEventListener('click', () => {
      if (state.hasInternalBackTarget) {
        state.hasInternalBackTarget = false;
        history.back();
      } else {
        setRoute(router.pageHash(state.searchReturnPage || 'matches'), { replace: true });
        applyCurrentRoute();
      }
    });
    $('globalSearch').addEventListener('input', event => {
      state.searchQuery = event.target.value;
      setRoute(router.searchHash(state.searchQuery), { replace: true });
      renderSearch();
      $('globalSearch')?.focus();
    });
    bindCompetitionRows();
    bindTeamRows();
    bindPlayerRows();
    bindFollowButtons();
  }

  function searchSection(label, rows) {
    return `<section class="section"><div class="section-title"><h2>${label}</h2></div><div class="list-card">${rows || '<div class="empty-state"><strong>該当なし</strong>一致する項目はありません。</div>'}</div></section>`;
  }

  function competitionSearchRows(items) {
    return items.slice(0, 20).map(item => `<div class="entity-row is-link" data-competition-id="${esc(item.id)}" data-competition-name="${esc(item.name)}" data-competition-logo="${esc(item.logo || '')}" data-competition-season="${esc(item.seasonId || '')}">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">大会</div></div><span aria-hidden="true">›</span></div>`).join('');
  }

  function teamSearchRows(items) {
    return items.slice(0, 20).map(item => `<div class="entity-row is-link" data-team-id="${esc(item.id)}">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">クラブ</div></div><span aria-hidden="true">›</span></div>`).join('');
  }

  function bindTeamRows() {
    main.querySelectorAll('[data-team-id]').forEach(row => row.addEventListener('click', () => {
      state.hasInternalBackTarget = true;
      setRoute(router.entityHash('teams', row.dataset.teamId, currentProductSeason()));
      applyCurrentRoute();
    }));
  }

  function renderTeamDetail(teamId, productSeason) {
    const team = allKnownTeams().find(item => String(item.id) === String(teamId));
    if (!team) return renderRouteError({ status: 404, code: 'entity_not_found' }, '#/competitions');
    setPageHeader('leagues');
    eyebrow.textContent = 'クラブ詳細';
    title.textContent = team.name || 'クラブ';
    const fixtures = state.fixtures.filter(row => [row?.teams?.home?.id, row?.teams?.away?.id].some(id => String(id) === String(teamId)));
    const standing = state.competitionDetail?.standings?.groups?.flatMap(group => group.table || []).find(row => String(row?.team?.id) === String(teamId));
    const players = (state.legacy?.players || []).filter(player => String(player.club || '').trim().toLowerCase() === String(team.name || '').trim().toLowerCase());
    main.innerHTML = `${entityBackButton('クラブ一覧', '#/competitions')}<section class="entity-hero">${team.logo ? `<img src="${esc(team.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div><div class="eyebrow">${esc(productSeason || currentProductSeason())}</div><h2>${esc(team.name || team.id)}</h2></div></section><section class="section"><div class="section-title"><h2>概要</h2></div><div class="competition-summary"><div><strong>${standing?.rank ?? '—'}</strong><span>順位</span></div><div><strong>${standing?.points ?? '—'}</strong><span>勝点</span></div><div><strong>${standing?.goalDifference ?? '—'}</strong><span>得失点</span></div></div></section><section class="section"><div class="section-title"><h2>試合</h2><span class="meta">${fixtures.length}</span></div>${fixtures.length ? `<div class="match-card">${fixtures.map(fixtureRow).join('')}</div>` : '<div class="empty-state"><strong>試合は未取得です</strong>別大会・別クラブの試合で補完していません。</div>'}</section><section class="section"><div class="section-title"><h2>順位表</h2></div>${standing ? `<div class="standings-card">${standingRow(standing)}</div>` : '<div class="empty-state"><strong>順位表は未取得です</strong>未取得値を0として表示していません。</div>'}</section><section class="section"><div class="section-title"><h2>所属選手</h2><span class="meta">${players.length}</span></div><div class="list-card">${japaneseRows(players)}</div></section>`;
    bindEntityBack();
    bindFixtureRows('team');
    bindPlayerRows();
    bindFollowButtons();
    bindImageFallbacks();
  }

  function findPlayer(playerId) {
    return (state.legacy?.players || []).find(player => [
      player.playerId,
      player.jfwPlayerId,
      `jfw:${player.name}`,
    ].some(id => String(id || '') === String(playerId)));
  }

  function renderPlayerDetail(playerId, productSeason) {
    const player = findPlayer(playerId);
    if (!player) return renderRouteError({ status: 404, code: 'entity_not_found' }, '#/japanese');
    setPageHeader('japanese');
    eyebrow.textContent = '選手詳細';
    title.textContent = player.name;
    const stats = player.seasonStats || player.stats || {};
    const facts = (state.legacy?.insights || []).filter(item => item.player === player.name);
    const analyses = (state.legacy?.analysis || []).filter(item => item.player === player.name);
    const matches = (state.legacy?.topMatches || []).filter(item => String(item.players || '').includes(player.name));
    const history = Array.isArray(player.membershipHistory) ? player.membershipHistory : [];
    const clubStats = player.clubStats && typeof player.clubStats === 'object' ? Object.entries(player.clubStats) : [];
    main.innerHTML = `${entityBackButton('日本人一覧', router.pageHash('japanese', productSeason || currentProductSeason()))}<section class="entity-hero">${personAvatar(player)}<div><div class="eyebrow">${esc(productSeason || currentProductSeason())}</div><h2>${esc(player.name)}</h2><p>${esc(player.pos || 'ポジション未取得')}</p></div></section><section class="detail-card profile-grid"><div><span>現在所属</span><strong>${esc(player.club || '未取得')}</strong></div><div><span>大会</span><strong>${esc(player.league || '未取得')}</strong></div><div><span>追跡</span><strong class="tracking-badge">海外日本人追跡</strong></div></section><section class="section"><div class="section-title"><h2>今季スタッツ</h2></div><div class="competition-summary"><div><strong>${stats.apps ?? '—'}</strong><span>出場</span></div><div><strong>${stats.goals ?? '—'}</strong><span>得点</span></div><div><strong>${stats.assists ?? '—'}</strong><span>アシスト</span></div></div></section>${renderPlayerStyle(facts, analyses)}<section class="section"><div class="section-title"><h2>所属履歴</h2></div>${history.length ? `<div class="list-card">${history.map(item => `<div class="history-row"><strong>${esc(item.club || item.teamName || '未取得')}</strong><span>${esc(item.start || item.from || '—')} – ${esc(item.end || item.to || '現在')}</span></div>`).join('')}</div>` : '<div class="empty-state"><strong>所属履歴は未取得です</strong>現在所属から過去を推測していません。</div>'}</section><section class="section"><div class="section-title"><h2>大会別成績</h2></div><div class="empty-state"><strong>大会別成績は未取得です</strong>未取得値を0として表示していません。</div></section><section class="section"><div class="section-title"><h2>クラブ別成績</h2></div>${clubStats.length ? `<div class="list-card">${clubStats.map(([club, value]) => `<div class="history-row"><strong>${esc(club)}</strong><span>${esc(JSON.stringify(value))}</span></div>`).join('')}</div>` : '<div class="empty-state"><strong>クラブ別成績は未取得です</strong>移籍元と移籍先を混ぜていません。</div>'}</section><section class="section"><div class="section-title"><h2>直近試合</h2><span class="meta">${matches.length}</span></div>${matches.length ? `<div class="list-card">${matches.map(item => `<div class="history-row"><strong>${esc(item.match)}</strong><span>${esc(item.reason || '')}</span></div>`).join('')}</div>` : '<div class="empty-state"><strong>直近試合は未取得です</strong>確認できた試合だけを表示します。</div>'}</section>`;
    bindEntityBack();
    bindImageFallbacks();
  }

  function renderPlayerStyle(facts, analyses) {
    if (!facts.length && !analyses.length) return '<section class="section"><div class="section-title"><h2>どんな選手か</h2></div><div class="empty-state"><strong>詳細データなし</strong>プレースタイルを断定できる詳細データはまだありません。</div></section>';
    return `<section class="section"><div class="section-title"><h2>どんな選手か</h2></div><div class="insights-grid">${facts.map(item => `<article class="insight-card is-fact"><h3>確認できた事実</h3><p>${esc(item.fact || '')}</p><h4>注目点</h4><p>${esc(item.why || '')}</p>${sourceLine(item.sources)}</article>`).join('')}${analyses.map(analysisCard).join('')}</div></section>`;
  }

  function entityBackButton(label, parentHash) {
    return `<div class="detail-top"><button class="back-button" data-entity-back="${esc(parentHash)}" type="button">← ${esc(label)}</button></div>`;
  }

  function bindEntityBack() {
    const button = main.querySelector('[data-entity-back]');
    if (!button) return;
    button.addEventListener('click', () => {
      if (state.hasInternalBackTarget) {
        state.hasInternalBackTarget = false;
        history.back();
      } else {
        setRoute(button.dataset.entityBack, { replace: true });
        applyCurrentRoute();
      }
    });
  }

  function renderRouteError(route, parentHash = '#/matches') {
    eyebrow.textContent = `HTTP ${route.status || 404}`;
    title.textContent = route.status === 400 ? 'URLを確認してください' : '対象が見つかりません';
    const message = route.code === 'invalid_season_namespace'
      ? 'シーズンIDの種類がこの画面と一致しません。別種類のIDへ黙って変換していません。'
      : '指定された大会・クラブ・選手・試合を確認できませんでした。';
    main.innerHTML = `<div class="empty-state route-error"><strong>${esc(route.code || 'entity_not_found')}</strong>${message}<button id="routeErrorBack" class="plain-button" type="button">一覧へ戻る</button></div>`;
    $('routeErrorBack').addEventListener('click', () => {
      setRoute(parentHash, { replace: true });
      applyCurrentRoute();
    });
  }

  function renderMore() {
    setPageHeader('more');
    const coverage = state.legacy?.dataCoverage || [];
    main.innerHTML = `${dataIntegrityNotice()}<div class="settings-grid"><section class="settings-block"><h3>データ取得状態</h3><p>${state.workerBase ? 'Core v2へ接続する設定が有効です。' : 'Core v2の接続設定は未取得です。移行データのみを表示します。'} API keyやD1/R2の内部識別子は表示しません。</p></section><section class="settings-block"><h3>表示テーマ</h3><p>ライト / ダークは端末内に保存します。</p><button id="moreTheme" class="plain-button" type="button">テーマを切り替える</button></section><section class="settings-block"><h3>既存機能</h3><p>移行中も日本人追跡の旧画面は削除していません。</p><button id="legacyOpen" class="plain-button" type="button">旧画面を開く</button></section>${coverage.length ? `<section class="settings-block"><h3>既存データ取得状況</h3>${coverage.map(item => `<p><b>${esc(item.label)}</b> · ${esc(item.level)}<br>${esc(item.note)}</p>`).join('')}</section>` : ''}</div>`;
    $('moreTheme').addEventListener('click', toggleTheme);
    $('legacyOpen').addEventListener('click', () => { location.href = 'legacy.html'; });
  }

  function isFollowing(type,id) {
    return state.follows[type].some(item => item.id === id);
  }

  function isCompetitionFollowing(item) {
    return state.follows.competitions.some(row => row.id === item.id || (row.name && row.name === item.name));
  }

  function toggleFollow(type,item) {
    const index = state.follows[type].findIndex(row => row.id === item.id || (type === 'competitions' && row.name && row.name === item.name));
    if (index >= 0) state.follows[type].splice(index,1); else state.follows[type].push(item);
    saveFollows();
    applyCurrentRoute();
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
    if (state.legacy?._dataIntegrity?.degraded && state.source !== 'core') dataMode.textContent = '移行データ ⚠';
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
    state.hasInternalBackTarget = true;
    setRoute(hash);
    syncNav();
    renderCurrentPage();
    scrollTo({ top: 0, behavior: 'instant' });
  }

  function applyCurrentRoute() {
    const route = router.parseHash(location.hash, {
      date: state.date || todayJst(),
      fixtureReturn: state.fixtureReturn || 'matches',
      returnPage: state.page || 'matches',
    });
    if (!location.hash || route.shouldReplace) setRoute(route.canonicalHash, { replace: true });
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
        name: route.competitionId,
        logo: '',
        seasonId: route.competitionSeason,
      };
      openCompetition(known, {
        routeDriven: true,
        seasonId: route.competitionSeason || known.seasonId,
        tab: route.tab,
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

  let routeApplyScheduled = false;
  function scheduleRouteApply() {
    if (routeApplyScheduled) return;
    routeApplyScheduled = true;
    queueMicrotask(() => {
      routeApplyScheduled = false;
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
  searchButton.addEventListener('click', () => {
    state.searchReturnPage = state.page;
    state.hasInternalBackTarget = true;
    setRoute(router.searchHash(''));
    applyCurrentRoute();
    $('globalSearch')?.focus();
  });
  themeButton.addEventListener('click', toggleTheme);
  window.addEventListener('popstate', scheduleRouteApply);
  window.addEventListener('hashchange', scheduleRouteApply);
  applyTheme(localStorage.getItem('football-v2-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  loadLegacy().then(() => {
    applyCurrentRoute();
    if (state.page !== 'matches') loadMatches();
  });
})();
