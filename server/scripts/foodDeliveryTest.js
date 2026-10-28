#!/usr/bin/env node
/** Misalignment detector: "app for ordering food delivery" must return food companies. */
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(__dirname, '..', 'data', 'corpus');
const FOOD = /food|restaurant|meal|grocer|delivery|kitchen|dining|catering|takeout|cook|chef/i;
(async () => {
  const companies = JSON.parse(fs.readFileSync(path.join(DIR, 'companies.json'), 'utf8'));
  const vectors = JSON.parse(fs.readFileSync(path.join(DIR, 'vectors.json'), 'utf8'));
  if (companies.length !== vectors.length) { console.error('FAIL: count mismatch'); process.exit(1); }
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = path.resolve(__dirname, '..', 'data', '.model-cache');
  const ex = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const q = (await ex('app for ordering food delivery', { pooling: 'mean', normalize: true })).tolist()[0];
  const top = vectors.map((v, i) => [i, v.reduce((s, x, j) => s + x * q[j], 0)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  let hits = 0;
  top.forEach(([i, s]) => {
    const c = companies[i]; const ok = FOOD.test(`${c.name} ${c.description} ${c.subIndustry} ${c.tags.join(' ')}`);
    hits += ok; console.log(`${ok ? 'food ' : 'OTHER'} ${s.toFixed(3)}  ${c.name} — ${c.description.slice(0, 70)}`);
  });
  console.log(`\n${hits}/10 look food-related`);
  if (hits < 8) { console.error('FAIL: vectors are probably misaligned with companies'); process.exit(1); }
  console.log('PASS');
})();
