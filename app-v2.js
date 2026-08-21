(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const main = $('appMain');
  const title = $('pageTitle');
  const eyebrow = $('pageEyebrow');
  const dataMode = $('dataMode');
  const themeButton = $('themeButton');
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
    liveOnly: false,
    detail: null,
    detailTab: 'overview',
    legacy: null,
    legacySearch: '',
    fixtures: [],
    source: 'loading',
    workerBase: readWorkerBase(),
    follows: readFollows(),
    loading: false,
    matchLoadSequence: 0,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[char]));
  }

  function readWorkerBase() {
    const query = new URL(location.href).searchParams.get('api');
    return String(query || localStorage.getItem('football-v2-api-base') || localStorage.getItem('jfw-v2-api-base') || '')
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
      const response = await fetch('data.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.legacy = await response.json();
    } catch {
      state.legacy = { players: [], topMatches: [], dataCoverage: [] };
    }
    return state.legacy;
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
      return `<button class="date-button${offset === 0 ? ' is-active' : ''}" data-date="${date}" type="button"><span class="dow">${esc(date === todayJst() ? '今日' : parts.dow)}</span><span class="day">${esc(parts.day)}</span></button>`;
    }).join('')}</div>`;
  }

  function fixtureTeam(team, score) {
    const logo = team?.logo ? `<img class="team-logo" src="${esc(team.logo)}" alt="" loading="lazy">` : '<span></span>';
    return `<div class="team-line">${logo}<span class="team-name">${esc(team?.name || team?.id || '未取得')}</span><span class="team-score">${score ?? '—'}</span></div>`;
  }

  function fixtureRow(row) {
    const short = statusShort(row);
    const time = isLive(row) ? `<span class="live-time">${esc(row?.status?.elapsed ? `${row.status.elapsed}′` : short || 'LIVE')}</span>` : (row.kickoffDisplay || formatKickoff(row.kickoffUtc));
    const status = isLive(row) ? short || 'LIVE' : (isFinal(row) ? '終了' : short || '予定');
    return `<article class="fixture-row" data-fixture="${esc(row.fixtureId)}">
      <div class="fixture-time">${time}</div>
      <div class="teams">
        ${fixtureTeam(row?.teams?.home, row?.score?.goals?.home)}
        ${fixtureTeam(row?.teams?.away, row?.score?.goals?.away)}
      </div>
      <span class="status-pill${isLive(row) ? ' is-live' : ''}${isFinal(row) ? ' is-final' : ''}">${esc(status)}</span>
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
    const rows = state.liveOnly ? state.fixtures.filter(isLive) : state.fixtures;
    const sourceNote = state.source === 'core' ? '' : `<div class="notice">Core feedの接続前/取得失敗時は、既存の確認済みデータだけを移行表示しています。未取得を0にはしていません。</div>`;
    main.innerHTML = `
      <div class="control-row"><button id="liveFilter" class="chip live${state.liveOnly ? ' is-active' : ''}" type="button">● LIVE</button><button id="todayButton" class="chip${state.date === todayJst() ? ' is-active' : ''}" type="button">今日</button></div>
      ${renderDateStrip()}
      ${sourceNote}
      ${state.loading ? '<div class="notice">試合データを読み込み中…</div>' : ''}
      <div id="fixtureGroups">${renderFixtureGroups(rows)}</div>`;
    $('liveFilter').addEventListener('click', () => { state.liveOnly = !state.liveOnly; renderMatches(); });
    $('todayButton').addEventListener('click', () => { state.date = todayJst(); loadMatches(); });
    main.querySelectorAll('[data-date]').forEach(button => button.addEventListener('click', () => { state.date = button.dataset.date; loadMatches(); }));
    bindFixtureRows();
    updateDataMode();
  }

  function renderFixtureGroups(rows) {
    if (!rows.length) {
      const message = state.liveOnly
        ? '現在進行中として取得できた試合はありません。'
        : 'この日付の試合データはまだ取得されていません。';
      return `<div class="empty-state"><strong>表示できる試合がありません</strong>${message}</div>`;
    }
    return groupFixtures(rows).map(([name, fixtures]) => {
      const sample = fixtures[0] || {};
      const logo = sample?.competition?.logo ? `<img class="competition-logo" src="${esc(sample.competition.logo)}" alt="">` : '';
      return `<section class="section"><div class="section-title"><h2>${logo}${esc(name)}</h2><span class="meta">${fixtures.length}試合</span></div><div class="match-card">${fixtures.map(fixtureRow).join('')}</div></section>`;
    }).join('');
  }

  function bindFixtureRows() {
    main.querySelectorAll('[data-fixture]').forEach(row => row.addEventListener('click', () => openFixture(row.dataset.fixture)));
  }

  async function openFixture(fixtureId) {
    const summary = state.fixtures.find(row => row.fixtureId === fixtureId) || null;
    state.detail = { summary, bundle: null, loading: true, error: null };
    state.detailTab = 'overview';
    renderFixtureDetail();
    if (String(fixtureId).startsWith('legacy:')) {
      state.detail.loading = false;
      renderFixtureDetail();
      return;
    }
    try {
      state.detail.bundle = await apiFetch(`/api/v2/fixtures/${encodeURIComponent(fixtureId)}`);
    } catch (error) {
      state.detail.error = error.message;
    }
    state.detail.loading = false;
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
    main.innerHTML = `<div class="detail-top"><button id="detailBack" class="back-button" type="button">← 試合一覧</button><span class="status-pill${isLive(row) ? ' is-live' : ''}">${esc(statusShort(row) || row.ingestionState || '—')}</span></div>
      <section class="detail-card score-hero"><div class="score-meta">${esc(comp)} · ${esc(formatKickoff(row.kickoffUtc))} JST</div><div class="score-grid"><div class="score-team">${homeLogo}<strong>${esc(home.name || 'Home')}</strong>${followTeamButton(home)}</div><div class="score-value">${row?.score?.goals?.home ?? '—'} - ${row?.score?.goals?.away ?? '—'}</div><div class="score-team">${awayLogo}<strong>${esc(away.name || 'Away')}</strong>${followTeamButton(away)}</div></div></section>
      <div class="detail-tabs">${['overview','lineup','stats'].map(tab => `<button class="detail-tab${state.detailTab === tab ? ' is-active' : ''}" data-detail-tab="${tab}" type="button">${tab === 'overview' ? '概要' : tab === 'lineup' ? 'ラインナップ' : 'スタッツ'}</button>`).join('')}</div>
      ${detail.loading ? '<div class="notice">試合詳細を読み込み中…</div>' : renderDetailBody(detail)}`;
    $('detailBack').addEventListener('click', () => { state.detail = null; renderMatches(); });
    main.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => { state.detailTab = button.dataset.detailTab; renderFixtureDetail(); }));
    bindFollowButtons();
  }

  function renderDetailBody(detail) {
    if (detail.error) return `<div class="notice">詳細データはまだCoreにありません。試合一覧のスコア/状態はそのまま利用できます。<br>${esc(detail.error)}</div>`;
    if (!detail.bundle) {
      const item = detail?.summary?.legacy || {};
      return `<section class="detail-card"><div class="event-row"><div class="event-minute">既存</div><div>${esc(item.reason || item.note || '確認済み結果')}</div></div><div class="event-row"><div class="event-minute">対象</div><div>${esc(item.players || '—')}</div></div></section>`;
    }
    if (state.detailTab === 'lineup') return renderLineups(detail.bundle);
    if (state.detailTab === 'stats') return renderTeamStats(detail.bundle);
    return renderEvents(detail.bundle);
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
      const api = window.JFWFormation;
      const laidOut = api?.layoutPlayers ? api.layoutPlayers(starters, lineup.formation) : starters;
      const confidence = laidOut?.layoutMeta?.confidence || 'none';
      const team = [bundle?.fixture?.teams?.home, bundle?.fixture?.teams?.away].find(item => item?.id === lineup.teamId);
      return `<section class="detail-card pitch-card"><div class="pitch-title"><span>${esc(team?.name || lineup.teamId || 'Team')} · ${esc(lineup.formation || 'Formation未取得')}</span>${confidence === 'high' ? '' : '<span class="estimate">配置は推定</span>'}</div><div class="pitch">${laidOut.map(player => `<div class="pitch-player" style="left:${Number(player.x) || 50}%;top:${Number(player.y) || 50}%"><span class="pitch-disc">${esc(player.number ?? '—')}</span><span>${esc(player.name || '選手')}</span></div>`).join('')}</div></section>`;
    }).join('');
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
    const fromFixtures = state.fixtures.map(row => ({ id: row.competitionId || competitionKey(row), name: competitionKey(row), logo: row?.competition?.logo || '' }));
    const fromLegacy = (state.legacy?.players || []).map(player => ({ id: `legacy:competition:${player.league}`, name: player.league, logo: '' }));
    const unique = new Map([...fromFixtures, ...fromLegacy].filter(item => item.name).map(item => [item.id, item]));
    const leagues = [...unique.values()].sort((a,b) => Number(isFollowing('competitions', b.id)) - Number(isFollowing('competitions', a.id)) || a.name.localeCompare(b.name,'ja'));
    main.innerHTML = `<input id="leagueSearch" class="search-box" placeholder="リーグ・大会を検索" autocomplete="off"><section class="section"><div class="section-title"><h2>大会</h2><span class="meta">${leagues.length}</span></div><div id="leagueList" class="list-card">${leagueRows(leagues,'')}</div></section>`;
    $('leagueSearch').addEventListener('input', event => { $('leagueList').innerHTML = leagueRows(leagues,event.target.value); bindFollowButtons(); });
    bindFollowButtons();
  }

  function leagueRows(leagues, query) {
    const q = String(query || '').trim().toLowerCase();
    const filtered = leagues.filter(item => !q || item.name.toLowerCase().includes(q));
    if (!filtered.length) return '<div class="empty-state"><strong>該当する大会なし</strong>検索条件を変えてください。</div>';
    return filtered.map(item => {
      const on = isFollowing('competitions', item.id);
      return `<div class="entity-row">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">${esc(item.id)}</div></div><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="competitions" data-follow-id="${esc(item.id)}" data-follow-name="${esc(item.name)}" data-follow-logo="${esc(item.logo || '')}" type="button">${on ? '★' : '☆'}</button></div>`;
    }).join('');
  }

  function renderFollowing() {
    setPageHeader('following');
    const groups = [['competitions','リーグ・大会'],['teams','クラブ'],['players','選手']];
    main.innerHTML = groups.map(([type,label]) => `<section class="section"><div class="section-title"><h2>${label}</h2><span class="meta">${state.follows[type].length}</span></div><div class="list-card">${followRows(type)}</div></section>`).join('');
    bindFollowButtons();
  }

  function followRows(type) {
    const rows = state.follows[type];
    if (!rows.length) return '<div class="empty-state"><strong>まだフォローなし</strong>試合・リーグ・日本人画面から追加できます。</div>';
    return rows.map(item => `<div class="entity-row">${item.logo ? `<img class="entity-logo" src="${esc(item.logo)}" alt="">` : '<span class="entity-logo"></span>'}<div class="entity-main"><div class="entity-name">${esc(item.name)}</div><div class="entity-sub">${esc(item.id)}</div></div><button class="follow-button is-following" data-follow-type="${type}" data-follow-id="${esc(item.id)}" data-follow-name="${esc(item.name)}" data-follow-logo="${esc(item.logo || '')}" type="button">解除</button></div>`).join('');
  }

  function renderJapanese() {
    setPageHeader('japanese');
    const players = (state.legacy?.players || []).slice().sort((a,b) => (Number(b.rating)||0)-(Number(a.rating)||0) || (Number(b?.stats?.goals)||0)+(Number(b?.stats?.assists)||0) - ((Number(a?.stats?.goals)||0)+(Number(a?.stats?.assists)||0)));
    const q = state.legacySearch.trim().toLowerCase();
    const filtered = players.filter(player => !q || `${player.name} ${player.club} ${player.league}`.toLowerCase().includes(q));
    main.innerHTML = `<div class="notice">日本人追跡は総合データアプリのオプション機能です。既存の追跡データ/JFW Ratingは削除せず、Core factsへ順次接続します。</div><input id="japaneseSearch" class="search-box" placeholder="日本人選手を検索" value="${esc(state.legacySearch)}" autocomplete="off"><section class="section"><div class="section-title"><h2>追跡選手</h2><span class="meta">${filtered.length}</span></div><div id="japaneseList" class="list-card">${japaneseRows(filtered)}</div></section>`;
    $('japaneseSearch').addEventListener('input', event => { state.legacySearch = event.target.value; const next = players.filter(player => !state.legacySearch.trim() || `${player.name} ${player.club} ${player.league}`.toLowerCase().includes(state.legacySearch.trim().toLowerCase())); $('japaneseList').innerHTML = japaneseRows(next); bindFollowButtons(); });
    bindFollowButtons();
  }

  function japaneseRows(players) {
    if (!players.length) return '<div class="empty-state"><strong>該当選手なし</strong>検索条件を変えてください。</div>';
    return players.slice(0,80).map(player => {
      const stats = player.stats || {};
      const id = `jfw:${player.name}`;
      const on = isFollowing('players',id);
      return `<div class="entity-row"><span class="entity-logo"></span><div class="entity-main"><div class="entity-name">${esc(player.name)}</div><div class="entity-sub">${esc(player.club || 'クラブ未取得')} · ${esc(player.league || 'リーグ未取得')} · ${esc(player.pos || '')}</div><div class="stat-inline"><span>出場 <b>${stats.apps ?? '—'}</b></span><span>G <b>${stats.goals ?? '—'}</b></span><span>A <b>${stats.assists ?? '—'}</b></span><span>${esc(player.status || '')}</span></div></div><button class="follow-button${on ? ' is-following' : ''}" data-follow-type="players" data-follow-id="${esc(id)}" data-follow-name="${esc(player.name)}" data-follow-logo="" type="button">${on ? '★' : '☆'}</button></div>`;
    }).join('');
  }

  function renderMore() {
    setPageHeader('more');
    const coverage = state.legacy?.dataCoverage || [];
    main.innerHTML = `<div class="settings-grid"><section class="settings-block"><h3>Football Data Worker</h3><p>API-Footballキーはブラウザに置かず、Cloudflare Worker経由でCoreデータを読み込みます。</p><input id="workerInput" class="settings-input" value="${esc(state.workerBase)}" placeholder="https://example.workers.dev"><button id="saveWorker" class="plain-button" type="button">保存して試合を再読込</button></section><section class="settings-block"><h3>表示テーマ</h3><p>通常 / ダークは端末内に保存します。</p><button id="moreTheme" class="plain-button" type="button">テーマを切り替える</button></section><section class="settings-block"><h3>既存機能</h3><p>移行中も日本人追跡の旧画面は削除していません。</p><button id="legacyOpen" class="plain-button" type="button">旧画面を開く</button></section>${coverage.length ? `<section class="settings-block"><h3>既存データ取得状況</h3>${coverage.map(item => `<p><b>${esc(item.label)}</b> · ${esc(item.level)}<br>${esc(item.note)}</p>`).join('')}</section>` : ''}</div>`;
    $('saveWorker').addEventListener('click', () => { state.workerBase = String($('workerInput').value || '').trim().replace(/\/+$/,''); if(state.workerBase){localStorage.setItem('football-v2-api-base',state.workerBase);}else{localStorage.removeItem('football-v2-api-base');} state.page='matches'; syncNav(); loadMatches(); });
    $('moreTheme').addEventListener('click', toggleTheme);
    $('legacyOpen').addEventListener('click', () => { location.href = 'index.html'; });
  }

  function isFollowing(type,id) {
    return state.follows[type].some(item => item.id === id);
  }

  function toggleFollow(type,item) {
    const index = state.follows[type].findIndex(row => row.id === item.id);
    if (index >= 0) state.follows[type].splice(index,1); else state.follows[type].push(item);
    saveFollows();
    renderCurrentPage();
  }

  function bindFollowButtons() {
    main.querySelectorAll('[data-follow-type]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      toggleFollow(button.dataset.followType,{ id: button.dataset.followId, name: button.dataset.followName, logo: button.dataset.followLogo || '' });
    }));
  }

  function setPageHeader(page) {
    const values = PAGE_TITLES[page] || PAGE_TITLES.matches;
    eyebrow.textContent = values[0];
    title.textContent = values[1];
  }

  function updateDataMode() {
    if (state.source === 'core') dataMode.textContent = 'Core v2';
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
    state.page = page;
    syncNav();
    renderCurrentPage();
    scrollTo({ top: 0, behavior: 'instant' });
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
  themeButton.addEventListener('click', toggleTheme);
  applyTheme(localStorage.getItem('football-v2-theme') || 'dark');

  loadLegacy().then(() => {
    renderCurrentPage();
    loadMatches();
  });
})();
