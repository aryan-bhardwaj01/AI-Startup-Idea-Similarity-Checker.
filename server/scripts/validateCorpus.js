#!/usr/bin/env node
/**
 * validateCorpus.js — the real contract. Independent of buildCorpus.js (own CSV logic).
 *   node server/scripts/validateCorpus.js [corpusDir]
 * Exit code 0 = all pass, 1 = any fail.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'data', 'corpus');

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const na = (v) => ((v ?? '').trim() === 'NA' ? '' : (v ?? '').trim());
const csv = (f) => parse(fs.readFileSync(path.join(RAW, f), 'utf8'), { columns: true, skip_empty_lines: true, bom: true });

// ---- independent expectations from raw ----
const yc = csv('yc_startups_dataset.csv');
const tech = csv('Tech_Companies_10k.csv');
const kept = yc.filter((r) => na(r['Company Description']) !== '');
const yr = (y) => { const n = Number(na(y)); return Number.isFinite(n) && na(y) ? String(Math.trunc(n)) : ''; };
const key = (n, b) => n.trim().toLowerCase() + '|' + b;
const ycKeys = new Map();
kept.forEach((r) => { const k = key(r['Company Name'], `${na(r['Batch Season'])} ${yr(r['Batch Year'])}`); ycKeys.set(k, (ycKeys.get(k) || 0) + 1); });
const techKeys = new Set(tech.filter((r) => na(r.long_description)).map((r) => key(r.name, r.batch.trim())));
const expectedLong = kept.filter((r) => { const k = key(r['Company Name'], `${na(r['Batch Season'])} ${yr(r['Batch Year'])}`); return techKeys.has(k) && ycKeys.get(k) === 1; }).length;

// ---- raw ----
check('Raw rows = 5,785', yc.length === 5785, `got ${yc.length}`);
check('Raw dir untouched: both CSVs present, read-only', ['yc_startups_dataset.csv', 'Tech_Companies_10k.csv'].every((f) => fs.existsSync(path.join(RAW, f))));

// ---- load outputs ----
let companies, vectors, meta;
try { companies = readJson('companies.json'); } catch (e) { check('companies.json readable', false, e.message); }
try { vectors = readJson('vectors.json'); } catch (e) { check('vectors.json readable', false, e.message); }
try { meta = readJson('meta.json'); } catch (e) { check('meta.json readable', false, e.message); }

if (companies) {
  const n = companies.length;
  check('After cleaning = 5,625 (only empty descriptions dropped)', n === 5625,
    n === 5625 ? '' : `got ${n}. ~5,500 => deduped by name; far lower => blanket dropna()`);
  check('Count equals independent recompute from raw', n === kept.length, `expected ${kept.length}`);
  check('Company IDs unique', new Set(companies.map((c) => c.id)).size === n);
  check('Same order as raw CSV (ids match row by row)', companies.every((c, i) => String(c.id) === String(kept[i]['Company ID'])));

  const alex = companies.filter((c) => c.name === 'Alex');
  check('Both "Alex" rows exist (ids 29263 and 30100)', alex.length === 2 && alex.some((c) => c.id === 29263) && alex.some((c) => c.id === 30100), `found ${alex.length}`);
  const apollo = companies.filter((c) => c.name === 'Apollo');
  const apolloRaw = kept.filter((r) => r['Company Name'].trim() === 'Apollo').length;
  check('All "Apollo" rows survive', apollo.length === apolloRaw && apollo.length >= 2, `found ${apollo.length}, raw has ${apolloRaw}`);

  const longN = companies.filter((c) => c.longDescription).length;
  check('Long descriptions merged ~927-933 (matches independent count)', longN === expectedLong && longN >= 900 && longN < 963,
    `got ${longN}, expected ${expectedLong}. 963+ => name-only matching; <900 => 2012.0 year bug`);
  const cb = companies.find((c) => c.name === 'Coinbase');
  check('Coinbase has long "Founded in June of 2012..." text', !!cb && !!cb.longDescription && cb.longDescription.startsWith('Founded in June of 2012'));

  const fields = ['id', 'name', 'description', 'longDescription', 'subIndustry', 'industry', 'tags', 'status', 'url'];
  check('Every company has exactly the contract fields', companies.every((c) => Object.keys(c).length === fields.length && fields.every((f) => f in c)));
  check('No empty descriptions', companies.every((c) => c.description && c.description.trim() && c.description !== 'NA'));
  check('No "; " left in descriptions (rule 3)', companies.every((c) => !c.description.includes('; ')));
  check('Tags are arrays, no "NA"/empty items', companies.every((c) => Array.isArray(c.tags) && c.tags.every((t) => t && t !== 'NA' && !t.includes(';'))));
  check('No literal "NA" in string fields', companies.every((c) => ['name', 'subIndustry', 'industry', 'status'].every((f) => c[f] !== 'NA') && c.url !== 'NA' && c.longDescription !== 'NA'));
}

if (companies && vectors) {
  check('Vector count == company count', vectors.length === companies.length, `${vectors.length} vs ${companies.length}`);
  const badDim = vectors.findIndex((v) => !Array.isArray(v) || v.length !== 384 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x)));
  check('Every vector has 384 finite numbers', badDim === -1, badDim === -1 ? '' : `first bad index ${badDim}`);
  const badNorm = vectors.findIndex((v) => Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) > 1e-3);
  check('Every vector is normalized (L2 norm ~ 1)', badNorm === -1, badNorm === -1 ? '' : `first bad index ${badNorm}`);
  const distinct = new Set(vectors.map((v) => v.slice(0, 8).join(','))).size;
  check('Vectors are not all identical / degenerate', distinct > vectors.length * 0.95, `${distinct} distinct of ${vectors.length}`);
} else if (companies) {
  check('vectors.json present', false, 'run the full build (not --clean-only)');
}
if (meta && companies) {
  check('meta.json: model, dimensions 384, count, builtAt', meta.model === 'Xenova/all-MiniLM-L6-v2' && meta.dimensions === 384 && meta.count === companies.length && !!meta.builtAt && Object.keys(meta).length === 4, JSON.stringify(meta));
}

// ---- drop report ----
try {
  const rep = readJson('drop_report.json');
  const d = rep.dropped.find((x) => x.reason === 'no description');
  check('Drop report: only reason is "no description" = 160 rows', rep.dropped.length === 1 && d && d.count === 160, JSON.stringify(rep.dropped.map((x) => [x.reason, x.count])));
  check('Drop report adds up (raw - dropped = cleaned)', rep.rawRows - rep.dropped.reduce((s, x) => s + x.count, 0) === rep.afterCleaning);
} catch (e) { check('drop_report.json readable', false, e.message); }

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
