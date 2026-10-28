const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const CORPUS_DIR = path.join(__dirname, 'server', 'data', 'corpus');
const MODEL = 'Xenova/all-MiniLM-L6-v2';   // must be the SAME model the corpus was built with
const TOP_K = 5;                            // how many matches to return

const app = express();
app.use(express.json());                                    // lets you read req.body
app.use(express.static(path.join(__dirname, 'public')));    // serves your HTML/CSS/JS
require('./server/insight')(app);                           // AI Insight: adds POST /api/insight

// These are filled once at startup, then reused by every request
let companies = [];
let vectors = [];
let extractor = null;   // the model

// Dot product: multiply matching positions and add up.
// Vectors are normalized, so this equals cosine similarity.
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

// Novelty v2.
// Two anchors turn a raw similarity into a 0-100 score:
//   SIM_UNRELATED (0.30): about what random, unrelated text scores  -> novelty 100
//   SIM_NEAR_COPY (0.60): about what a paraphrased copy of an existing startup scores -> novelty 0
// Change only these two numbers if the test ideas look too high or too low.
const SIM_UNRELATED = 0.30;
const SIM_NEAR_COPY = 0.60;

// We average the top 3 matches instead of trusting only the #1 match,
// so one lucky or unlucky word does not swing the score.
function noveltyFromScores(topScores) {
    const n = Math.min(3, topScores.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += topScores[i];
    const avg = sum / n;

    // Straight line: avg 0.60 -> 0, avg 0.30 -> 100
    const novelty = ((SIM_NEAR_COPY - avg) / (SIM_NEAR_COPY - SIM_UNRELATED)) * 100;
    return Math.max(0, Math.min(100, Math.round(novelty)));
}

// Domain boost.
// The page sends the domain the user picked. For each domain we list words that appear in
// a company's industry / subIndustry / tags. Companies that match get a small bonus
// when we ORDER the results. The bonus never changes the similarity number we show.
const DOMAIN_BOOST = 0.08;
const DOMAIN_WORDS = {
    'agriculture':    ['agricultur', 'farm', 'food'],
    'healthcare':     ['health', 'therapeutic', 'diagnostic', 'drug', 'medical', 'biotech'],
    'education':      ['education', 'edtech', 'learning'],
    'cybersecurity':  ['security', 'privacy'],
    'finance':        ['fintech', 'payment', 'banking', 'credit', 'lending', 'insurance', 'finance', 'asset management'],
    'e-commerce':     ['retail', 'e-commerce', 'ecommerce', 'marketplace', 'consumer', 'food and beverage', 'delivery'],
    'social':         ['social', 'community', 'messaging', 'communication'],
    'environment':    ['climate', 'energy', 'sustainab', 'environment', 'clean'],
    'transportation': ['logistics', 'supply chain', 'transportation', 'mobility', 'aviation', 'automotive', 'delivery'],
    'media':          ['content', 'media', 'entertainment', 'gaming', 'music', 'video']
};
let domainMasks = {};   // domain -> array of true/false, one per company (built at startup)

function buildDomainMasks() {
    const haystacks = companies.map((c) =>
        [c.industry, c.subIndustry, ...(Array.isArray(c.tags) ? c.tags : [])]
            .filter(Boolean).join(' ').toLowerCase());
    for (const [domain, words] of Object.entries(DOMAIN_WORDS)) {
        domainMasks[domain] = haystacks.map((h) => words.some((w) => h.includes(w)));
        console.log(`Domain "${domain}": ${domainMasks[domain].filter(Boolean).length} companies`);
    }
}

// Is this a real description? We use the corpus itself as a dictionary:
// a word counts as "known" if it appears in at least 2 different companies' text.
// Real ideas are 75-95% known words. Gibberish, lorem ipsum and key-mashing are under 45%.
const MIN_WORDS = 6;            // fewer words than this is not a description
const MIN_UNIQUE_WORDS = 5;     // "test test test test ..." is not a description
const MIN_KNOWN_RATIO = 0.55;   // between real ideas (0.79+) and gibberish (0.42 max in our tests)
let vocab = new Set();

function buildVocab() {
    const counts = new Map();
    for (const c of companies) {
        const text = [c.name, c.description, c.longDescription, c.subIndustry, ...(c.tags || [])]
            .filter(Boolean).join(' ').toLowerCase();
        for (const w of new Set(text.match(/[a-z]{2,}/g) || [])) {
            counts.set(w, (counts.get(w) || 0) + 1);
        }
    }
    vocab = new Set([...counts].filter(([, n]) => n >= 2).map(([w]) => w));
    console.log(`Dictionary: ${vocab.size} words`);
}

// Returns an error message if the text looks invalid, or null if it is fine.
function checkDescription(text) {
    const words = text.toLowerCase().match(/[a-z]{2,}/g) || [];
    if (words.length < MIN_WORDS) {
        return 'Please describe your idea in at least a full sentence (English words only).';
    }
    if (new Set(words).size < MIN_UNIQUE_WORDS) {
        return 'Your description repeats the same words. Please describe your idea in more detail.';
    }
    const known = words.filter((w) => vocab.has(w)).length;
    if (known / words.length < MIN_KNOWN_RATIO) {
        return "This doesn't look like a real startup description. Please write a few clear sentences in English about what your startup does.";
    }
    return null;
}

app.post('/api/analyze', async (req, res) => {
    try {
        const { title, description, domain } = req.body || {};

        // Validate again on the server. Never trust the browser.
        if (typeof title !== 'string' || typeof description !== 'string' ||
            !title.trim() || !description.trim()) {
            return res.status(400).json({ error: 'title and description are required' });
        }
        if (title.length > 200 || description.length > 5000) {
            return res.status(400).json({ error: 'input too long' });
        }

        // Refuse gibberish instead of showing a meaningless result
        const problem = checkDescription(description);
        if (problem) {
            return res.status(400).json({ error: problem });
        }

        // 1. Turn the idea into 384 numbers (same model as the corpus).
        // We use the DESCRIPTION only. The title is a made-up name (like "QuickBite")
        // and would match companies with similar-sounding names, not similar ideas.
        const text = description.trim();
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        const query = output.tolist()[0];

        // 2. Compare against every company (raw similarity)
        const scored = vectors.map((v, i) => ({ i, score: dot(v, query) }));

        // Novelty uses the RAW best matches, so the domain choice never changes it
        const rawSorted = [...scored].sort((a, b) => b.score - a.score);
        const novelty = noveltyFromScores(rawSorted.slice(0, 3).map((t) => t.score));

        // 3. Order the results: raw similarity + a small bonus for the chosen domain
        const mask = domainMasks[domain];   // undefined if the domain is unknown
        const ranked = scored
            .map((t) => ({ ...t, rank: t.score + (mask && mask[t.i] ? DOMAIN_BOOST : 0) }))
            .sort((a, b) => b.rank - a.rank);

        // 4. Keep the top few
        const top = ranked.slice(0, TOP_K);
        console.log('Top matches:', top.map((t) => `${companies[t.i].name} (${t.score.toFixed(2)})`).join(', '));

        // 5. Send back the shape the page expects
        res.json({
            noveltyScore: novelty,
            matches: top.map(({ i, score }) => {
                const c = companies[i];   // vector i belongs to company i
                return {
                    id: c.id,
                    name: c.name,
                    similarity: Number(score.toFixed(3)),
                    description: c.description,
                    subIndustry: c.subIndustry,
                    status: c.status,
                    url: c.url
                };
            })
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'analysis failed' });
    }
});

async function start() {
    console.log('Loading corpus...');
    companies = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'companies.json'), 'utf8'));
    vectors = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'vectors.json'), 'utf8'));
    if (companies.length !== vectors.length) {
        throw new Error(`companies (${companies.length}) and vectors (${vectors.length}) do not match`);
    }
    console.log(`Loaded ${companies.length} companies.`);
    buildDomainMasks();
    buildVocab();

    console.log('Loading model...');
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = path.join(__dirname, 'server', 'data', '.model-cache');
    extractor = await pipeline('feature-extraction', MODEL);

    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

start().catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
});