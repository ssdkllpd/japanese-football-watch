from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JST = timezone(timedelta(hours=9))
NOW = datetime.now(JST).replace(microsecond=0).isoformat()


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write_text(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def read_json(path: str):
    return json.loads(read_text(path))


def write_json(path: str, value) -> None:
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return updated


def stable_hash(value: str) -> str:
    h = 2166136261
    for ch in str(value).strip():
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if h == 0:
        return "0"
    out = ""
    n = h
    while n:
        n, rem = divmod(n, 36)
        out = digits[rem] + out
    return out


def merge_nested_ids(current: dict | None, incoming: dict | None) -> dict:
    out = dict(current or {})
    for provider, ids in (incoming or {}).items():
        if isinstance(ids, dict):
            out[provider] = {**(out.get(provider) or {}), **ids}
        else:
            out[provider] = ids
    return out


def build_player_registry() -> dict:
    by_name: dict[str, dict] = {}

    def observe(name, player_id=None, provider_ids=None):
        if not name:
            return
        name = str(name).strip()
        row = by_name.setdefault(name, {
            "name": name,
            "playerId": None,
            "aliases": set(),
            "providerIds": {},
        })
        if player_id:
            player_id = str(player_id)
            if row["playerId"] and row["playerId"] != player_id:
                raise RuntimeError(f"conflicting playerId for {name}: {row['playerId']} vs {player_id}")
            row["playerId"] = player_id
        row["providerIds"] = merge_nested_ids(row["providerIds"], provider_ids)

    base = read_json("data.json")
    for player in base.get("players", []):
        observe(player.get("name"), player.get("playerId"), player.get("providerIds"))

    seasons = read_json("seasons.json")
    current = seasons.get("current")
    manifest_path = f"data/{current}/backfill/index.json"
    manifest = read_json(manifest_path)
    for fragment_name in manifest.get("fragments", []):
        fragment = read_json(f"data/{current}/backfill/{fragment_name}")
        for player in fragment.get("playerUpdates", []):
            observe(player.get("name"), player.get("playerId"), player.get("providerIds"))
        for record in fragment.get("playerMatchStats", []):
            observe(
                record.get("playerName") or record.get("player") or record.get("name"),
                record.get("playerId"),
                record.get("providerIds"),
            )

    provider_config = read_json("config/api-football-existing-results.json")
    for name, aliases in (provider_config.get("playerAliases") or {}).items():
        observe(name)
        by_name[name]["aliases"].update(str(alias).strip() for alias in aliases if alias)

    explicit_ids: dict[str, str] = {}
    for name, row in by_name.items():
        if not row["playerId"]:
            row["playerId"] = f"jp-{stable_hash(name)}"
        owner = explicit_ids.get(row["playerId"])
        if owner and owner != name:
            raise RuntimeError(f"playerId collision: {row['playerId']} for {owner} and {name}")
        explicit_ids[row["playerId"]] = name

    players = []
    for name in sorted(by_name):
        row = by_name[name]
        players.append({
            "playerId": row["playerId"],
            "name": name,
            "aliases": sorted(a for a in row["aliases"] if a and a != name),
            "providerIds": row["providerIds"],
        })

    return {
        "schemaVersion": 1,
        "updatedAt": NOW,
        "policy": {
            "runtimeIdentity": "explicit_registry_required",
            "nameHashGeneration": "migration_only_registry_bootstrap",
            "providerJoin": "provider_id_to_registry_to_player_id",
            "namesAreDisplayData": True,
        },
        "players": players,
    }


def patch_backfill_loader() -> None:
    path = "backfill-loader.js"
    text = read_text(path)

    text = replace_once(
        text,
        "  let loading = null;\n  let uiPolicyInstalled = false;\n",
        """  let loading = null;\n  let uiPolicyInstalled = false;\n  let playerRegistry = null;\n  let registryById = new Map();\n  let registryByName = new Map();\n  let registryByApiFootballId = new Map();\n""",
        "registry state",
    )

    text = replace_once(
        text,
        "  function stablePlayerId(name) { return `jp-${stableHash(name)}`; }\n",
        """  // Migration helper only. Runtime identity must resolve through config/player-registry.json.\n  function stablePlayerId(name) { return `jp-${stableHash(name)}`; }\n  function installPlayerRegistry(registry) {\n    const rows = Array.isArray(registry?.players) ? registry.players : [];\n    if (!rows.length) throw new Error('player registry is empty');\n    const byId = new Map();\n    const byName = new Map();\n    const byProvider = new Map();\n    for (const row of rows) {\n      const playerId = String(row?.playerId || '').trim();\n      const name = textKey(row?.name);\n      if (!playerId || !name) throw new Error('player registry contains an empty playerId/name');\n      if (byId.has(playerId)) throw new Error(`duplicate playerId in registry: ${playerId}`);\n      byId.set(playerId, row);\n      for (const alias of [name, ...(row.aliases || []).map(textKey)].filter(Boolean)) {\n        const existing = byName.get(alias);\n        if (existing && existing.playerId !== playerId) throw new Error(`ambiguous player alias in registry: ${alias}`);\n        byName.set(alias, row);\n      }\n      const providerId = row?.providerIds?.apiFootball?.player;\n      if (providerId !== null && providerId !== undefined) {\n        const key = String(providerId);\n        const existing = byProvider.get(key);\n        if (existing && existing.playerId !== playerId) throw new Error(`duplicate API-Football player id in registry: ${key}`);\n        byProvider.set(key, row);\n      }\n    }\n    playerRegistry = registry;\n    registryById = byId;\n    registryByName = byName;\n    registryByApiFootballId = byProvider;\n  }\n  async function ensurePlayerRegistryLoaded() {\n    if (playerRegistry) return playerRegistry;\n    const registry = await getJson('config/player-registry.json');\n    installPlayerRegistry(registry);\n    return registry;\n  }\n  function registryEntryForCandidate(value) {\n    if (!value) return null;\n    if (value.playerId) {\n      const byId = registryById.get(String(value.playerId));\n      if (byId) return byId;\n    }\n    const providerId = value?.providerIds?.apiFootball?.player ?? value?.apiFootballPlayerId ?? value?.providerPlayerId;\n    if (providerId !== null && providerId !== undefined) {\n      const byProvider = registryByApiFootballId.get(String(providerId));\n      if (byProvider) return byProvider;\n    }\n    const name = textKey(value.name || value.playerName || value.player);\n    return name ? (registryByName.get(name) || null) : null;\n  }\n  function registryPlayerIdForName(name) {\n    return registryByName.get(textKey(name))?.playerId || null;\n  }\n""",
        "registry helpers",
    )

    text = replace_once(
        text,
        "    if (!p.playerId) p.playerId = stablePlayerId(p.name);\n",
        """    const registryEntry = registryEntryForCandidate(p);\n    if (!registryEntry) throw new Error(`player registry missing: ${p.name}`);\n    p.playerId = registryEntry.playerId;\n    p.providerIds = mergeProviderIds(registryEntry.providerIds, p.providerIds);\n""",
        "ensurePlayerIdentity registry",
    )

    text = replace_regex_once(
        text,
        r"  function playerByIncoming\(u\) \{.*?\n  \}\n  function setTrackingState",
        """  function playerByIncoming(u) {\n    if (!u) return null;\n    const entry = registryEntryForCandidate(u);\n    if (!entry) return null;\n    return (D.players || []).find(p => String(p.playerId || '') === String(entry.playerId)) || null;\n  }\n  function setTrackingState""",
        "playerByIncoming",
    )

    text = replace_regex_once(
        text,
        r"  function recordsForIdentity\(p\) \{.*?\n  \}\n  function inferMembershipChangeType",
        """  function recordsForIdentity(p) {\n    return (D.playerMatchStats || []).filter(r => {\n      const entry = registryEntryForCandidate(r);\n      return entry && String(entry.playerId) === String(p.playerId);\n    });\n  }\n  function inferMembershipChangeType""",
        "recordsForIdentity",
    )

    text = replace_regex_once(
        text,
        r"  function playerForRecord\(r\) \{.*?\n  \}\n  function matchForRecord",
        """  function playerForRecord(r) {\n    const entry = registryEntryForCandidate(r);\n    if (!entry) return null;\n    return (D.players || []).find(p => String(p.playerId || '') === String(entry.playerId)) || null;\n  }\n  function matchForRecord""",
        "playerForRecord",
    )

    old_merge_ga = """      const p = (D.players || []).find(p =>\n        (x.playerId && String(p.playerId) === String(x.playerId)) ||\n        p.name === x.player\n      );\n      if (p) x.playerId = p.playerId;\n"""
    new_merge_ga = """      const registryEntry = registryEntryForCandidate(x);\n      const p = registryEntry\n        ? (D.players || []).find(p => String(p.playerId || '') === String(registryEntry.playerId))\n        : null;\n      if (p) x.playerId = p.playerId;\n"""
    text = replace_once(text, old_merge_ga, new_merge_ga, "mergeGA identity")

    text = replace_once(
        text,
        """  function recordBelongsToPlayer(r, p) {\n    return (r.playerId && String(r.playerId) === String(p.playerId)) || recordPlayerName(r) === p.name;\n  }\n""",
        """  function recordBelongsToPlayer(r, p) {\n    const entry = registryEntryForCandidate(r);\n    return !!entry && String(entry.playerId) === String(p.playerId);\n  }\n""",
        "recordBelongsToPlayer",
    )

    marker = "  async function applyCurrentBackfill() {\n"
    if marker not in text:
        raise RuntimeError("applyCurrentBackfill marker missing")
    blocking_helpers = """  function blockCurrentSeasonData(error) {\n    const detail = String(error?.message || error || 'unknown backfill load failure');\n    D = D || {};\n    D._dataIntegrity = {\n      blocked: true,\n      reason: 'current_season_overlay_load_failed',\n      season: String(selectedSeason || ''),\n      detail\n    };\n    const main = document.querySelector('main');\n    if (main) main.hidden = true;\n    let banner = document.getElementById?.('dataIntegrityError');\n    if (!banner) {\n      banner = document.createElement('div');\n      banner.id = 'dataIntegrityError';\n      banner.setAttribute?.('role', 'alert');\n      banner.style.cssText = 'margin:16px 0;padding:14px;border:1px solid #fca5a5;border-radius:12px;background:#3f151b;color:#fff;line-height:1.6';\n      const host = document.querySelector('.wrap') || document.body;\n      host?.insertBefore?.(banner, main || host.firstChild || null);\n    }\n    if (banner) banner.textContent = `最新データの読み込みに失敗したため表示を停止しました。再読み込みしても続く場合は更新処理を確認してください。 (${detail})`;\n    try { R.updated.textContent = 'データ整合性エラー・表示停止'; } catch {}\n    console.error('current season data blocked', error);\n  }\n  function clearCurrentSeasonDataBlock() {\n    if (D?._dataIntegrity?.reason === 'current_season_overlay_load_failed') delete D._dataIntegrity;\n    const main = document.querySelector('main');\n    if (main) main.hidden = false;\n    document.getElementById?.('dataIntegrityError')?.remove?.();\n  }\n\n"""
    text = text.replace(marker, blocking_helpers + marker, 1)

    text = replace_regex_once(
        text,
        r"  async function applyCurrentBackfill\(\) \{.*?\n  \}\n\n  async function refreshViews",
        """  async function applyCurrentBackfill() {\n    const season = String(selectedSeason || '');\n    if (!season) return false;\n    try {\n      await ensurePlayerRegistryLoaded();\n      const base = `data/${encodeURIComponent(season)}/backfill/`;\n      const manifest = await getJson(base + 'index.json');\n      const parts = await Promise.all((manifest.fragments || []).map(f => getJson(base + f)));\n      clearCurrentSeasonDataBlock();\n      applyFragments(parts);\n      try { R.updated.textContent = `${season} ・ 最終更新: ${D.updated || '未取得'}`; } catch {}\n      return true;\n    } catch (e) {\n      const isCurrentSeason = String(seasonManifest?.current || '') === season;\n      if (isCurrentSeason) {\n        blockCurrentSeasonData(e);\n        return false;\n      }\n      if (!String(e).includes('404')) console.warn('player match backfill load failed', e);\n      return false;\n    }\n  }\n\n  async function refreshViews""",
        "applyCurrentBackfill fail closed",
    )

    text = replace_once(
        text,
        "  async function refreshViews() {\n    try { renderAll(); } catch {}\n",
        "  async function refreshViews() {\n    if (D?._dataIntegrity?.blocked) return;\n    try { renderAll(); } catch {}\n",
        "refreshViews block guard",
    )

    text = replace_once(
        text,
        "    stablePlayerId,\n    isTrackedLeague,\n",
        "    stablePlayerId,\n    registryPlayerIdForName,\n    isTrackedLeague,\n",
        "registry export",
    )

    write_text(path, text)


def patch_node_merge() -> None:
    path = "scripts/api-football/backfill-existing-results.js"
    text = read_text(path)
    text = replace_once(
        text,
        "const fs = require('node:fs');\nconst path = require('node:path');\n",
        "const fs = require('node:fs');\nconst path = require('node:path');\nconst { execFileSync } = require('node:child_process');\n",
        "node child process import",
    )
    text = replace_regex_once(
        text,
        r"function mergeCurrentData\(root = ROOT, season = '2026-27'\) \{.*?\n\}\n\nfunction parseStoredScore",
        """function mergeCurrentData(root = ROOT, season = '2026-27') {\n  const loader = path.join(root, 'scripts', 'shared', 'runtime-data-loader-cli.js');\n  const output = execFileSync(process.execPath, [loader, '--root', root, '--season', season], {\n    encoding: 'utf8',\n    maxBuffer: 64 * 1024 * 1024,\n  });\n  return JSON.parse(output);\n}\n\nfunction parseStoredScore""",
        "mergeCurrentData runtime reuse",
    )
    write_text(path, text)


def write_runtime_loader() -> None:
    content = r"""'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeElement() {
  return {
    id: '',
    hidden: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    firstChild: null,
    setAttribute() {},
    remove() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {},
    insertBefore() {},
    insertAdjacentElement() {},
  };
}

function createRuntimeContext(root, season, data, seasons) {
  const main = makeElement();
  const wrap = makeElement();
  const body = makeElement();
  const elements = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    document: {
      body,
      getElementById(id) { return elements.get(id) || null; },
      querySelector(selector) {
        if (selector === 'main') return main;
        if (selector === '.wrap') return wrap;
        if (selector === 'script[data-jfw-match-detail]') return makeElement();
        return null;
      },
      createElement() {
        const element = makeElement();
        const originalRemove = element.remove;
        element.remove = function remove() {
          if (element.id) elements.delete(element.id);
          originalRemove.call(element);
        };
        return element;
      },
    },
    D: data,
    seasonManifest: seasons,
    selectedSeason: season,
    loadSeason: async () => {},
    renderAll() {},
    renderPlayerDetail() {},
    renderClubDetail() {},
    renderAttention() {},
    renderStats() {},
    relevantClubMatches() { return []; },
    clubPlayers() { return []; },
    clubMatchCard() { return ''; },
    pcard() { return ''; },
    mcard() { return ''; },
    bindEntities() {},
    bindWatch() {},
    btns() {},
    eligible() { return true; },
    playerRef(p) { return p.playerId || p.name; },
    playerByRef(ref) { return context.D.players.find(p => p.playerId === ref || p.name === ref); },
    roundNo() { return null; },
    fmt(v) { return v == null ? '—' : String(v); },
    E(v) { return String(v ?? ''); },
    $() { return makeElement(); },
    R: {
      updated: makeElement(), leagueBtns: makeElement(), players: makeElement(), scopeBtns: makeElement(),
      metricBtns: makeElement(), statRank: makeElement(), playerDetail: makeElement(), clubDetail: makeElement(),
    },
    order: ['すべて','プレミアリーグ','チャンピオンシップ','ブンデスリーガ','ラ・リーガ','リーグ・アン','セリエA','エールディヴィジ','ベルギー','ポルトガル','スコットランド'],
    scope: 'すべて', metric: 'goals', metrics: { goals: '得点', assists: 'アシスト' }, attLeague: 'すべて',
    page: 'home', activePlayer: null, activeClub: null, clubRoundFrom: null, clubRoundTo: null,
    clearDetailParams() {}, showPage() {}, lastPage: 'home', setTimeout, clearTimeout,
    fetch: async url => {
      const clean = String(url).replace(/[?&]v=\d+$/, '').replace(/^\.\//, '');
      const filePath = path.join(root, clean);
      if (!fs.existsSync(filePath)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => readJson(filePath) };
    },
  };
  context.window = context;
  wrap.insertBefore = element => { if (element?.id) elements.set(element.id, element); };
  body.insertBefore = wrap.insertBefore;
  return context;
}

async function loadIntegratedSeasonData(root, season) {
  const seasons = readJson(path.join(root, 'seasons.json'));
  const row = (seasons.seasons || []).find(item => String(item.id) === String(season));
  if (!row) throw new Error(`season not found in seasons.json: ${season}`);
  const data = readJson(path.join(root, row.data));
  const context = createRuntimeContext(root, season, data, seasons);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  await context.window.JFWBackfill.boot();
  if (context.D?._dataIntegrity?.blocked) {
    throw new Error(`runtime data merge blocked: ${context.D._dataIntegrity.detail || context.D._dataIntegrity.reason}`);
  }
  return JSON.parse(JSON.stringify(context.D));
}

module.exports = { loadIntegratedSeasonData };
"""
    write_text("scripts/shared/runtime-data-loader.js", content)

    cli = r"""'use strict';

const path = require('node:path');
const { loadIntegratedSeasonData } = require('./runtime-data-loader');

function valueOf(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

(async () => {
  const root = path.resolve(valueOf('--root', path.join(__dirname, '..', '..')));
  const season = valueOf('--season', '2026-27');
  const data = await loadIntegratedSeasonData(root, season);
  process.stdout.write(JSON.stringify(data));
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
"""
    write_text("scripts/shared/runtime-data-loader-cli.js", cli)


def write_compaction_tool() -> None:
    content = r"""'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadIntegratedSeasonData } = require('./shared/runtime-data-loader');

const ROOT = path.join(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = name => process.argv.includes(name);
const blobSha = content => {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
};

(async () => {
  const seasons = readJson(path.join(ROOT, 'seasons.json'));
  const season = arg('--season', seasons.current);
  const manifestPath = path.join(ROOT, 'data', season, 'backfill', 'index.json');
  const manifest = readJson(manifestPath);
  const fragments = manifest.fragments || [];
  const bytes = fragments.reduce((sum, name) => sum + fs.statSync(path.join(path.dirname(manifestPath), name)).size, 0);
  const thresholdFragments = Number(arg('--threshold-fragments', 40));
  const thresholdBytes = Number(arg('--threshold-bytes', 5 * 1024 * 1024));
  const eligible = fragments.length >= thresholdFragments || bytes >= thresholdBytes;
  const plan = { season, fragmentCount: fragments.length, fragmentBytes: bytes, thresholdFragments, thresholdBytes, eligible };

  if (!has('--apply')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (!eligible && !has('--force')) throw new Error(`compaction threshold not reached: ${JSON.stringify(plan)}`);

  const data = await loadIntegratedSeasonData(ROOT, season);
  const compactedAt = new Date().toISOString();
  data.compaction = {
    compactedAt,
    compactedThroughFragments: [...fragments],
    sourceManifest: `data/${season}/backfill/index.json`,
  };

  const baseRel = `data/${season}/compacted/base.json`;
  const basePath = path.join(ROOT, baseRel);
  const baseContent = `${JSON.stringify(data, null, 2)}\n`;
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  fs.writeFileSync(basePath, baseContent, 'utf8');

  const nextManifest = {
    ...manifest,
    fragments: [],
    compaction: {
      compactedAt,
      base: baseRel,
      archivedFragments: [...fragments],
    },
  };
  const manifestContent = `${JSON.stringify(nextManifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, manifestContent, 'utf8');

  const seasonRow = (seasons.seasons || []).find(row => String(row.id) === String(season));
  if (!seasonRow) throw new Error(`season missing: ${season}`);
  seasonRow.data = baseRel;
  writeJson(path.join(ROOT, 'seasons.json'), seasons);

  const snapshotPath = path.join(ROOT, 'state', 'latest_snapshot.json');
  if (fs.existsSync(snapshotPath) && String(seasons.current) === String(season)) {
    const snapshot = readJson(snapshotPath);
    snapshot.updatedAt = compactedAt;
    snapshot.base = { path: baseRel, blobSha: blobSha(baseContent) };
    snapshot.overlayManifest = {
      ...(snapshot.overlayManifest || {}),
      path: `data/${season}/backfill/index.json`,
      blobSha: blobSha(manifestContent),
      orderedFragments: [],
    };
    snapshot.compaction = { compactedAt, archivedFragments: [...fragments] };
    writeJson(snapshotPath, snapshot);
  }

  process.stdout.write(`${JSON.stringify({ ...plan, applied: true, base: baseRel }, null, 2)}\n`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
"""
    write_text("scripts/compact-season.js", content)


def append_regression_tests() -> None:
    integrity_path = "tests/current-data-integrity.test.js"
    integrity = read_text(integrity_path)
    marker = "伊東純也のシーズン通算アシストはbaselineと試合明細を二重計上せず2で固定される"
    if marker not in integrity:
        integrity += f"""\n\ntest('{marker}', async () => {{\n  const {{ data }} = await loadedData();\n  const player = data.players.find(p => p.name === '伊東純也');\n  assert.ok(player, '伊東純也の選手レコードが必要');\n  assert.equal(player.seasonStats?.assists, 2);\n  assert.equal(player.competitionStats?.['ベルギー']?.assists, 2);\n  assert.equal(player.clubStats?.['KRCヘンク']?.assists, 2);\n}});\n"""
        write_text(integrity_path, integrity)

    transfer_path = "tests/transfer-model.test.js"
    transfer = read_text(transfer_path)
    marker2 = "すべては親善試合を除く全公式戦通算で大会別集計とは分離される"
    if marker2 not in transfer:
        transfer += f"""\n\ntest('{marker2}', async () => {{\n  const player = {{\n    name: '公式戦太郎',\n    club: 'Club A',\n    league: 'プレミアリーグ',\n    stats: {{ apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }}\n  }};\n  const fragments = [{{\n    updated: '2026-08-20 12:00 JST',\n    matchUpdates: [{{ matchId: 'ucl-1', league: 'UEFA Champions League', competition: 'UEFA Champions League', ko: '2026-08-18 20:00', match: 'Club A 1-0 X', addIfMissing: true }}],\n    playerMatchStats: [{{\n      recordId: 'ucl-1-p', matchId: 'ucl-1', player: '公式戦太郎', club: 'Club A', competition: 'UEFA Champions League',\n      appearance: true, start: false, values: {{ minutes: 25, goals: 0, assists: 0 }}, missingFields: []\n    }}]\n  }}];\n  const context = buildHarness({{ player, fragments }});\n  // Synthetic migration records must also use an explicit registry entry.\n  context.window.JFWTracking.registryPlayerIdForName = context.window.JFWTracking.registryPlayerIdForName || (() => null);\n  const p = await apply(context);\n  assert.equal(p.seasonStats.apps, 1);\n  assert.equal(p.seasonStats.minutes, 25);\n  assert.equal(p.competitionStats['プレミアリーグ'].apps, 0);\n  assert.equal(p.competitionStats['UEFA Champions League'].apps, 1);\n}});\n"""
        write_text(transfer_path, transfer)


def write_fail_closed_test() -> None:
    content = r"""const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function element() {
  return { hidden: false, textContent: '', innerHTML: '', dataset: {}, style: {}, setAttribute() {}, remove() {}, querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, insertBefore() {}, insertAdjacentElement() {} };
}

function harness() {
  const main = element();
  const wrap = element();
  const body = element();
  const bannerById = new Map();
  const player = { playerId: 'jp-test', name: 'テスト選手', club: 'Club A', league: 'プレミアリーグ', stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 } };
  const context = {
    console: { log() {}, warn() {}, error() {} }, window: {}, D: { updated: 'base', players: [player], matches: [], topMatches: [] },
    seasonManifest: { current: '2026-27' }, selectedSeason: '2026-27', loadSeason: async () => {},
    document: {
      body,
      getElementById(id) { return bannerById.get(id) || null; },
      querySelector(selector) { if (selector === 'main') return main; if (selector === '.wrap') return wrap; if (selector === 'script[data-jfw-match-detail]') return element(); return null; },
      createElement() { const el = element(); el.remove = () => { if (el.id) bannerById.delete(el.id); }; return el; },
    },
    renderAll() {}, renderPlayerDetail() {}, renderClubDetail() {}, renderAttention() {}, renderStats() {}, relevantClubMatches() { return []; }, clubPlayers() { return []; }, clubMatchCard() { return ''; }, pcard() { return ''; }, mcard() { return ''; }, bindEntities() {}, bindWatch() {}, btns() {}, eligible() { return true; }, playerRef(p) { return p.playerId; }, playerByRef() { return player; }, roundNo() { return null; }, fmt(v) { return String(v); }, E(v) { return String(v ?? ''); }, $() { return element(); },
    R: { updated: element(), leagueBtns: element(), players: element(), scopeBtns: element(), metricBtns: element(), statRank: element(), playerDetail: element(), clubDetail: element() },
    order: ['すべて','プレミアリーグ'], scope: 'すべて', metric: 'goals', metrics: { goals: '得点' }, attLeague: 'すべて', page: 'home', activePlayer: null, activeClub: null, clubRoundFrom: null, clubRoundTo: null, clearDetailParams() {}, showPage() {}, lastPage: 'home', setTimeout, clearTimeout,
    fetch: async url => {
      const clean = String(url).replace(/[?&]v=\d+$/, '');
      if (clean === 'config/player-registry.json') return { ok: true, status: 200, json: async () => ({ players: [{ playerId: 'jp-test', name: 'テスト選手', aliases: [], providerIds: {} }] }) };
      if (clean.includes('index.json')) return { ok: true, status: 200, json: async () => ({ fragments: ['missing.json'] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  wrap.insertBefore = el => { if (el?.id) bannerById.set(el.id, el); };
  body.insertBefore = wrap.insertBefore;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  return { context, main };
}

test('current-season overlay failure blocks stale base rendering', async () => {
  const { context, main } = harness();
  await context.window.JFWBackfill.boot();
  assert.equal(context.D._dataIntegrity?.blocked, true);
  assert.equal(context.D._dataIntegrity?.reason, 'current_season_overlay_load_failed');
  assert.equal(main.hidden, true);
});
"""
    write_text("tests/backfill-fail-closed.test.js", content)


def update_stale_scope_note() -> int:
    path = "data/2026-27/backfill/latest-2026-08-20.json"
    data = read_json(path)
    changed = 0
    replacement = "現行仕様では players.stats / seasonStats の『すべて』は、追跡対象期間の全公式戦通算（親善・プレシーズン除外）。リーグ・カップ等の大会別表示は competitionStats を使用する。"

    def walk(value):
        nonlocal changed
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, str) and "カップ戦" in value and "players.stats" in value and "加算しない" in value:
            changed += 1
            return replacement
        return value

    updated = walk(data)
    if changed:
        write_json(path, updated)
    return changed


def update_policy() -> None:
    path = "state/workflow_policy.json"
    policy = read_json(path)
    policy["version"] = max(int(policy.get("version", 0)) + 1, 20)
    policy["updatedAt"] = NOW
    identity = policy.setdefault("playerIdentityPolicy", {})
    identity["registryPath"] = "config/player-registry.json"
    identity["runtimeRegistryRequired"] = True
    identity["nameHashGeneration"] = "migration_only_registry_bootstrap"
    identity["newUpdatesMayJoinByDisplayName"] = False
    identity["providerJoinPath"] = "provider_id -> player_registry -> playerId"

    season_policy = policy.setdefault("seasonPolicy", {})
    season_policy["compactionPolicy"] = {
        "tool": "scripts/compact-season.js",
        "defaultThresholdFragments": 40,
        "defaultThresholdBytes": 5242880,
        "archiveFragmentsInsteadOfDeleting": True,
        "materializedBaseMustUseRuntimeMerge": True,
        "applyRequiresValidationAfterCompaction": True,
    }

    provider = policy.setdefault("providerIntegrationPolicy", {})
    provider["playerRegistry"] = "config/player-registry.json"
    provider["providerPlayerIdMustResolveThroughRegistry"] = True
    provider["runtimeMergeForExistingResultSelection"] = "scripts/shared/runtime-data-loader.js"

    site = policy.setdefault("siteViewPolicy", {})
    site["currentSeasonOverlayFailure"] = "fail_closed_hide_data_views"

    consistency = policy.setdefault("consistencyPolicy", {})
    invariants = consistency.setdefault("invariants", [])
    for invariant in [
        "current_season_overlay_failure_must_not_render_stale_base_as_current",
        "runtime_player_identity_must_resolve_through_explicit_registry",
        "baseline_covered_match_records_must_not_double_count",
        "all_competitions_scope_must_include_official_cups_and_exclude_friendlies",
    ]:
        if invariant not in invariants:
            invariants.append(invariant)
    write_json(path, policy)


def main() -> None:
    registry = build_player_registry()
    write_json("config/player-registry.json", registry)
    patch_backfill_loader()
    patch_node_merge()
    write_runtime_loader()
    write_compaction_tool()
    append_regression_tests()
    write_fail_closed_test()
    note_changes = update_stale_scope_note()
    update_policy()
    print(json.dumps({
        "registryPlayers": len(registry["players"]),
        "staleScopeNotesUpdated": note_changes,
        "updatedAt": NOW,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
