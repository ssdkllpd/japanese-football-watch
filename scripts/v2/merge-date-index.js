'use strict';

const fs = require('node:fs');

function load(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function mergeDateIndex(current, incoming) {
  if (!incoming?.date || !Array.isArray(incoming?.fixtures)) throw new Error('Incoming date index is invalid.');
  if (current?.date && current.date !== incoming.date) throw new Error('Cannot merge different JST dates.');
  const byId = new Map();
  for (const row of current?.fixtures || []) if (row?.fixtureId) byId.set(row.fixtureId, row);
  for (const row of incoming.fixtures) if (row?.fixtureId) byId.set(row.fixtureId, row);
  return {
    contractVersion: incoming.contractVersion || current?.contractVersion || '2.0.0',
    timeZone: incoming.timeZone || current?.timeZone || 'Asia/Tokyo',
    date: incoming.date,
    fixtures: [...byId.values()].sort((a, b) => String(a.kickoffUtc || '').localeCompare(String(b.kickoffUtc || ''))),
    generatedAt: incoming.generatedAt || new Date().toISOString(),
  };
}

if (require.main === module) {
  const [currentPath, incomingPath, outputPath] = process.argv.slice(2);
  if (!incomingPath || !outputPath) {
    console.error('Usage: node merge-date-index.js <current-or-dash> <incoming> <output>');
    process.exit(2);
  }
  const current = currentPath === '-' ? null : load(currentPath);
  const incoming = load(incomingPath);
  const merged = mergeDateIndex(current, incoming);
  fs.writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

module.exports = { mergeDateIndex };
