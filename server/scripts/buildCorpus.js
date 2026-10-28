#!/usr/bin/env node
/**
 * buildCorpus.js — builds the corpus for the AI Startup Similarity Checker.
 *
 *   node server/scripts/buildCorpus.js              full build (needs the model)
 *   node server/scripts/buildCorpus.js --clean-only cleaning + merge + report only,
 *                                                   NO vectors (debug; validator will fail)
 *
 * Reads  : server/data/raw/*.csv        (never modified)
 * Writes : server/data/corpus/*         (never inside raw/)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const OUT_DIR = path.join(ROOT, 'data', 'corpus');
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;
const BATCH_SIZE = 32;
const CLEAN_ONLY = process.argv.includes('--clean-only');

// ---------- helpers ----------------------------------------------------------
// The CSVs use the literal text "NA" for missing values. csv-parse does NOT turn
// that into empty, so every field goes through val(): "NA"/"" -> "".
const val = (v) => {
  const s = (v ?? '').toString().trim();
  return s === 'NA' ? '' : s;
};
const readCsv = (file) =>
  parse(fs.readFileSync(path.join(RAW_DIR, file), 'utf8'), {
    columns: true, skip_empty_lines: true, bom: true, relax_column_count: false,
  });

// Batch Year may arrive as "2012" or "2012.0" -> always "2012".
const normYear = (y) => {
  const s = val(y);
  if (!s) return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '';
};
const batchOf = (season, year) => {
  const s = val(season), y = normYear(year);
  return s && y ? `${s} ${y}` : '';
};
const mergeKey = (name, batch) => `${val(name).toLowerCase()}|${batch}`;
const squash = (s) => s.replace(/\s+/g, ' ').trim(); // whitespace only, no content edits
const endsWithPunct = (s) => /[.!?…]$/.test(s);

function buildEmbedText(c) {
  const parts = [`${c.name}.`.replace(/([.!?])\.$/, '$1')];
  parts.push(endsWithPunct(c.description) ? c.description : `${c.description}.`);
  if (c.subIndustry) parts.push(`Category: ${c.subIndustry}.`);
  if (c.tags.length) parts.push(`Tags: ${c.tags.join(', ')}.`);
  if (c.longDescription) parts.push(c.longDescription); // LAST: model truncates the tail
  return squash(parts.join(' '));
}

// ---------- 1. load ----------------------------------------------------------
const yc = readCsv('yc_startups_dataset.csv');
const tech = readCsv('Tech_Companies_10k.csv');

// ---------- 2. long descriptions keyed by name + batch -----------------------
const longByKey = new Map();
const techDupKeys = [];
let techEmptyLong = 0;
for (const r of tech) {
  const ld = val(r.long_description);
  if (!ld) { techEmptyLong++; continue; }
  const k = mergeKey(r.name, val(r.batch));
  if (longByKey.has(k)) { techDupKeys.push(k); continue; } // first wins
  longByKey.set(k, ld.replace(/\r\n?/g, '\n'));
}

// How many YC rows (post-clean) share a key? Those are ambiguous -> not merged.
const keyCount = new Map();
const cleanedRows = [];
const drops = { 'no description': [] };
for (const r of yc) {
  const description = val(r['Company Description']);
  if (!description) { drops['no description'].push(Number(r['Company ID'])); continue; } // the ONLY drop rule
  cleanedRows.push(r);
  const k = mergeKey(r['Company Name'], batchOf(r['Batch Season'], r['Batch Year']));
  keyCount.set(k, (keyCount.get(k) || 0) + 1);
}

// ---------- 3. build companies -----------------------------------------------
const companies = [];
const ambiguousMerges = [];
let longMerged = 0;
for (const r of cleanedRows) {
  const batch = batchOf(r['Batch Season'], r['Batch Year']);
  const key = mergeKey(r['Company Name'], batch);
  let longDescription = null;
  if (longByKey.has(key)) {
    if (keyCount.get(key) > 1) ambiguousMerges.push(key);
    else { longDescription = longByKey.get(key); longMerged++; }
  }
  companies.push({
    id: Number(r['Company ID']),
    name: val(r['Company Name']),
    description: val(r['Company Description']).replace(/; /g, ', '),
    longDescription,
    subIndustry: val(r['Sub-Industry']),
    industry: val(r['Industry']),
    tags: val(r['Tags']).split(';').map((t) => t.trim()).filter((t) => t && t !== 'NA'),
    status: val(r['Current Status']),
    url: val(r['Website URL']) || null,
  });
}
const ids = new Set(companies.map((c) => c.id));
if (ids.size !== companies.length) throw new Error('Duplicate Company IDs after cleaning');
const texts = companies.map(buildEmbedText);

// ---------- 4. embeddings ----------------------------------------------------
async function embedAll() {
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = path.join(ROOT, 'data', '.model-cache');
  const extractor = await pipeline('feature-extraction', MODEL);
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const out = await extractor(texts.slice(i, i + BATCH_SIZE), { pooling: 'mean', normalize: true });
    const rows = out.tolist();
    for (const v of rows) vectors.push(v.map((x) => Math.round(x * 1e6) / 1e6));
    if ((i / BATCH_SIZE) % 20 === 0) console.log(`  embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
  }
  return vectors;
}

// ---------- 5. write (atomic, deterministic) ---------------------------------
const writeAtomic = (file, data) => {
  const p = path.join(OUT_DIR, file);
  fs.writeFileSync(p + '.tmp', data);
  fs.renameSync(p + '.tmp', p);
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const companiesJson = JSON.stringify(companies, null, 1);
  const dropReport = {
    rawRows: yc.length,
    afterCleaning: companies.length,
    dropped: Object.entries(drops).map(([reason, list]) => ({ reason, count: list.length, companyIds: list })),
    techRows: tech.length,
    techRowsWithEmptyLongDescription: techEmptyLong,
    longDescriptionsMerged: longMerged,
    ambiguousMergeKeysSkipped: [...new Set(ambiguousMerges)],
    techDuplicateKeysIgnored: techDupKeys,
  };
  writeAtomic('companies.json', companiesJson);
  writeAtomic('embedding_texts.json', JSON.stringify(texts, null, 1));
  writeAtomic('drop_report.json', JSON.stringify(dropReport, null, 1));
  console.log(`raw=${yc.length} cleaned=${companies.length} dropped(no description)=${drops['no description'].length} longMerged=${longMerged}`);

  if (CLEAN_ONLY) { console.log('--clean-only: skipped embeddings, vectors.json/meta.json NOT written.'); return; }

  const vectors = await embedAll();
  if (vectors.length !== companies.length) throw new Error('vector/company count mismatch');
  const vectorsJson = JSON.stringify(vectors);
  writeAtomic('vectors.json', vectorsJson);

  // builtAt only changes when content changes, so re-running gives byte-identical files.
  const checksums = { companies: sha(companiesJson), vectors: sha(vectorsJson) };
  let builtAt = new Date().toISOString();
  try {
    const prevSums = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'checksums.json'), 'utf8'));
    const prevMeta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'meta.json'), 'utf8'));
    if (prevSums.companies === checksums.companies && prevSums.vectors === checksums.vectors) builtAt = prevMeta.builtAt;
  } catch (_) { /* first build */ }
  writeAtomic('checksums.json', JSON.stringify(checksums, null, 1));
  writeAtomic('meta.json', JSON.stringify({ model: MODEL, dimensions: DIMENSIONS, count: companies.length, builtAt }, null, 1));
  console.log(`Done. ${companies.length} companies x ${DIMENSIONS} dims -> ${OUT_DIR}`);
})().catch((e) => { console.error('BUILD FAILED:', e); process.exit(1); });
