'use strict';

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
const unique = values => [...new Set((values || []).filter(Boolean))];

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
  if (!fragments.length) {
    process.stdout.write(`${JSON.stringify({ ...plan, applied: false, reason: 'no_new_fragments' }, null, 2)}\n`);
    return;
  }
  if (!eligible && !has('--force')) throw new Error(`compaction threshold not reached: ${JSON.stringify(plan)}`);

  const data = await loadIntegratedSeasonData(ROOT, season);
  const compactedAt = new Date().toISOString();
  const previousCompactedThrough = Array.isArray(data.compaction?.compactedThroughFragments)
    ? data.compaction.compactedThroughFragments
    : [];
  const previousArchived = Array.isArray(manifest.compaction?.archivedFragments)
    ? manifest.compaction.archivedFragments
    : [];
  const compactedThroughFragments = unique([
    ...previousCompactedThrough,
    ...previousArchived,
    ...fragments,
  ]);
  data.compaction = {
    ...(data.compaction || {}),
    compactedAt,
    compactedThroughFragments,
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
      ...(manifest.compaction || {}),
      compactedAt,
      base: baseRel,
      archivedFragments: compactedThroughFragments,
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
    snapshot.compaction = {
      ...(snapshot.compaction || {}),
      compactedAt,
      archivedFragments: compactedThroughFragments,
    };
    writeJson(snapshotPath, snapshot);
  }

  process.stdout.write(`${JSON.stringify({ ...plan, applied: true, base: baseRel, compactedThroughFragments }, null, 2)}\n`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
