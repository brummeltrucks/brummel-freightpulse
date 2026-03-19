const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const PPLX_KEY   = process.env.PPLX_KEY;
const GEMINI_KEY = 'AIzaSyC7ZuNR0TvV5gC6m37XNfkBtkZQW91kpEA';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CACHE ────────────────────────────────────────────────────────────────────
const TTL = 5 * 60 * 1000; // 5 min
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(url, opts).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
  });
}

function cleanAndParse(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON found');
  let raw = match[0];
  raw = raw.replace(/:\s*"\$?([\d.]+)"/g, ': $1');
  raw = raw.replace(/:\s*\$\s*([\d.]+)/g, ': $1');
  raw = raw.replace(/,\s*([}\]])/g, '$1');
  raw = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  raw = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return JSON.parse(raw);
}

// ─── PERPLEXITY ───────────────────────────────────────────────────────────────
async function askPerplexity(prompt, recency = 'day') {
  if (!PPLX_KEY) throw new Error('No PPLX_KEY');
  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'You are a data API. Return ONLY valid JSON, no markdown, no explanation.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 1000, search_recency_filter: recency,
    }),
  }, 20000);
  if (!r.ok) throw new Error(`Perplexity ${r.status}`);
  const d = await r.json();
  return cleanAndParse(d.choices?.[0]?.message?.content || '');
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────
async function askGemini(prompt) {
  // Tenta com Google Search grounding
  try {
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Return ONLY valid JSON, no markdown.\n\n${prompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
          tools: [{ googleSearch: {} }],
        }),
      }, 20000);
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const d = await r.json();
    return cleanAndParse(d.candidates?.[0]?.content?.parts?.[0]?.text || '');
  } catch(e) {
    console.warn(`    ⚠️ Gemini grounding failed (${e.message}), trying standard...`);
    // Fallback sem grounding
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Return ONLY valid JSON, no markdown.\n\n${prompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
        }),
      }, 15000);
    if (!r.ok) throw new Error(`Gemini std ${r.status}`);
    const d = await r.json();
    return cleanAndParse(d.candidates?.[0]?.content?.parts?.[0]?.text || '');
  }
}

// ─── OFFSETS ──────────────────────────────────────────────────────────────────
const STATE_DIESEL_OFFSETS = {
  CT:+0.12,ME:+0.08,MA:+0.14,NH:+0.06,RI:+0.10,VT:+0.08,NY:+0.16,NJ:+0.10,PA:+0.06,
  DE:+0.04,MD:+0.06,DC:+0.08,VA:+0.02,WV:-0.02,NC:-0.04,
  IL:+0.04,IN:+0.00,IA:-0.04,KS:-0.06,KY:-0.02,MI:+0.04,MN:+0.02,MO:-0.04,
  NE:-0.06,ND:-0.04,OH:+0.02,SD:-0.04,WI:+0.02,
  AL:-0.02,AR:-0.04,FL:+0.04,GA:-0.02,LA:-0.06,MS:-0.06,NM:-0.04,OK:-0.08,
  TN:-0.04,TX:-0.08,SC:-0.02,CO:+0.02,ID:+0.04,MT:+0.02,UT:+0.00,WY:-0.04,
  AK:+0.55,AZ:-0.06,CA:+0.48,HI:+1.20,NV:-0.02,OR:+0.12,WA:+0.14,
};

const STATE_REEFER_OFFSETS = {
  CA:+0.28,WA:+0.10,OR:+0.06,NV:-0.04,AZ:-0.02,ID:-0.14,MT:-0.20,WY:-0.20,UT:-0.10,CO:-0.06,
  ND:-0.26,SD:-0.26,NE:-0.20,KS:-0.16,OK:-0.08,NM:-0.12,TX:-0.06,
  MN:-0.12,IA:-0.16,MO:-0.12,WI:-0.06,IL:-0.02,IN:-0.06,MI:-0.02,OH:-0.02,KY:-0.06,
  TN:-0.06,AR:-0.12,LA:-0.06,MS:-0.12,AL:-0.06,GA:+0.04,FL:+0.08,SC:-0.02,NC:-0.02,
  VA:+0.00,WV:-0.12,PA:+0.04,NY:+0.14,NJ:+0.12,CT:+0.12,MA:+0.16,ME:+0.08,
  NH:+0.06,VT:+0.02,RI:+0.08,DE:+0.04,MD:+0.06,DC:+0.08,AK:+0.54,
};

const ALL_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
const HEAT_ORDER = ['WA','OR','CA','NV','ID','MT','WY','UT','CO','AZ','ND','SD','NE','KS','OK','TX','NM','MN','IA','MO','WI','IL','IN','MI','OH','KY','TN','AR','LA','MS','AL','GA','FL','SC','NC','VA','WV','PA','NY','NJ','ME','NH','VT','MA','RI','CT','DE','MD','DC','AK'];

function buildDieselStates(nat) {
  const s = {};
  ALL_STATES.forEach(st => { s[st] = parseFloat((nat + (STATE_DIESEL_OFFSETS[st]||0)).toFixed(3)); });
  return s;
}
function buildHeatmap(nat) {
  return HEAT_ORDER.map(abbr => ({ abbr, rate: parseFloat((nat + (STATE_REEFER_OFFSETS[abbr]||0)).toFixed(2)) }));
}
function calcFuelSurcharge(d) { return d > 1.20 ? parseFloat(((d-1.20)/0.06).toFixed(1)) : 0; }

// ─── 1. DIESEL — Perplexity + Gemini em paralelo, AAA ─────────────────────────
async function fetchDiesel() {
  console.log('  ⛽ Diesel...');

  const prompt = `Go to https://gasprices.aaa.com right now and find the "Current Avg." price for Diesel.
The page shows a table with Regular, Mid-Grade, Premium, Diesel, E85.
Find the exact Diesel "Current Avg." number shown today.
Return ONLY: {"national": 4.892}
Do NOT return the weekly EIA number. Do NOT estimate. Use the exact AAA number shown right now.`;

  const [rP, rG] = await Promise.allSettled([
    askPerplexity(prompt, 'day'),
    askGemini(prompt),
  ]);

  // Pega o primeiro valor válido
  for (const r of [rP, rG]) {
    if (r.status === 'fulfilled') {
      const nat = parseFloat(r.value?.national);
      if (nat >= 3.50 && nat <= 7.00) {
        console.log(`  ✅ Diesel: ${nat}`);
        return { national: nat, states: buildDieselStates(nat) };
      }
      console.warn(`  ⚠️ Diesel invalid value: ${nat}`);
    }
  }

  console.warn('  ❌ Diesel: both AIs failed');
  return { national: null, states: {} };
}

// ─── 2. SPOT RATES — Gemini Google Search ─────────────────────────────────────
async function fetchSpotRates() {
  console.log('  📊 Spot rates...');
  const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  try {
    const d = await askGemini(
      `Search Google for the most recent US truck spot rates per loaded mile published this week (${today}).
Search: "DAT spot rates" site:freightwaves.com OR site:ajot.com OR site:dat.com
Find national average reefer, dry van, flatbed rates per loaded mile.
Valid ranges: reefer $1.80-$2.60, dryvan $1.50-$2.30, flatbed $1.70-$2.45.
Return ONLY JSON (numbers only):
{"reefer":{"current":2.28,"high7d":2.60,"low7d":1.90,"changeWow":0.05,"loads":4500,"topMarket":"Chicago, IL"},"dryvan":{"current":1.92,"high7d":2.20,"low7d":1.60,"changeWow":0.08,"loads":6200,"topMarket":"Atlanta, GA"},"flatbed":{"current":2.15,"high7d":2.50,"low7d":1.80,"changeWow":0.07,"loads":2900,"topMarket":"Dallas, TX"}}`);

    const RNG = { reefer:[1.80,2.60], dryvan:[1.50,2.30], flatbed:[1.70,2.45] };
    const result = {};
    let anyValid = false;
    ['reefer','dryvan','flatbed'].forEach(t => {
      const v = parseFloat(d?.[t]?.current);
      if (v >= RNG[t][0] && v <= RNG[t][1]) {
        result[t] = { ...d[t], current: v };
        anyValid = true;
        console.log(`    📌 ${t}: $${v} ✅`);
      } else {
        result[t] = { current: null, high7d: null, low7d: null, changeWow: null, loads: null, topMarket: '–' };
        console.log(`    📌 ${t}: N/A (got ${v})`);
      }
    });
    return result;
  } catch(e) {
    console.warn(`  ⚠️ Spot rates failed: ${e.message}`);
    return {
      reefer:  { current: null, high7d: null, low7d: null, changeWow: null, loads: null, topMarket: '–' },
      dryvan:  { current: null, high7d: null, low7d: null, changeWow: null, loads: null, topMarket: '–' },
      flatbed: { current: null, high7d: null, low7d: null, changeWow: null, loads: null, topMarket: '–' },
    };
  }
}

// ─── 3. STATS — Gemini Google Search ──────────────────────────────────────────
async function fetchMarketStats() {
  console.log('  📈 Stats...');
  const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  try {
    const d = await askGemini(
      `Search Google for current US trucking market stats today (${today}).
Find: 1) DAT reefer truck-to-load ratio today. 2) Total loads posted on US loadboards last 24h.
Search: "DAT reefer truck load ratio today" and "total loads posted DAT today"
Valid: T/L ratio 2.0-8.0, total loads 150000-400000.
Return ONLY: {"totalLoads": 285000, "reeferTLRatio": 3.8, "source": "site"}`);

    const tl = parseFloat(d?.reeferTLRatio);
    const ld = parseInt(d?.totalLoads);
    const finalTL    = (tl >= 2.0 && tl <= 8.0)         ? tl  : null;
    const finalLoads = (ld >= 150000 && ld <= 400000)    ? ld  : null;
    console.log(`    📌 T/L: ${finalTL ?? 'N/A'} | Loads: ${finalLoads ?? 'N/A'} (${d?.source||'?'})`);
    return { totalLoads: finalLoads, reeferTLRatio: finalTL };
  } catch(e) {
    console.warn(`  ⚠️ Stats failed: ${e.message}`);
    return { totalLoads: null, reeferTLRatio: null };
  }
}

// ─── 4. NEWS — Perplexity ─────────────────────────────────────────────────────
async function fetchNews() {
  console.log('  📰 News...');
  const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  try {
    const d = await askPerplexity(
      `Search FreightWaves.com for the 5 most recent news articles published today or yesterday (${today}).
Only real news impacting US trucking: rates, capacity, fuel, FMCSA, ports, bankruptcies.
impact: "up"=good for carriers, "down"=bad, "neutral"=regulatory.
Return ONLY: {"news":[{"headline":"...","time":"2h ago","url":"https://www.freightwaves.com/news/...","impact":"up"}]}`, 'day');
    const arr = (d?.news||[]).filter(n => n?.headline?.length > 20).slice(0,7).map((n,i) => ({...n, breaking: i===0}));
    if (arr.length > 0) { console.log(`  ✅ News: ${arr.length}`); return arr; }
    throw new Error('empty');
  } catch(e) {
    console.warn(`  ⚠️ News PPLX failed: ${e.message}, trying Gemini...`);
    try {
      const d = await askGemini(
        `Search for 5 recent FreightWaves news articles about US trucking market (last 48h).
Return ONLY: {"news":[{"headline":"...","time":"2h ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"}]}`);
      const arr = (d?.news||[]).filter(n => n?.headline?.length > 20).slice(0,7).map((n,i) => ({...n, breaking: i===0}));
      if (arr.length > 0) { console.log(`  ✅ News Gemini: ${arr.length}`); return arr; }
    } catch(e2) { console.warn(`  ⚠️ News Gemini failed: ${e2.message}`); }
    return [];
  }
}

// ─── BUILD ALL — paralelo mas com timeout geral de 55s ────────────────────────
async function buildData() {
  console.log('\n🔄 Building...');
  const start = Date.now();

  // Limita tempo total a 55s (Railway timeout é 60s)
  const withTimeout = (p, fallback) => Promise.race([
    p,
    new Promise(res => setTimeout(() => res(fallback), 55000))
  ]);

  const [diesel, rates, stats, news] = await Promise.all([
    withTimeout(fetchDiesel(),       { national: null, states: {} }),
    withTimeout(fetchSpotRates(),    { reefer:{current:null,high7d:null,low7d:null,changeWow:null,loads:null,topMarket:'–'}, dryvan:{current:null,high7d:null,low7d:null,changeWow:null,loads:null,topMarket:'–'}, flatbed:{current:null,high7d:null,low7d:null,changeWow:null,loads:null,topMarket:'–'} }),
    withTimeout(fetchMarketStats(),  { totalLoads: null, reeferTLRatio: null }),
    withTimeout(fetchNews(),         []),
  ]);

  const heatmap = rates.reefer.current ? buildHeatmap(rates.reefer.current) : [];

  console.log(`✅ ${((Date.now()-start)/1000).toFixed(1)}s — diesel=${diesel.national??'N/A'} reefer=${rates.reefer.current??'N/A'}`);

  return {
    ok: true,
    diesel: { national: diesel.national },
    rates: {
      reefer:  { current: rates.reefer.current,  high: rates.reefer.high7d,  low: rates.reefer.low7d,  change: rates.reefer.changeWow,  loads: rates.reefer.loads,  best: rates.reefer.topMarket  },
      dryvan:  { current: rates.dryvan.current,  high: rates.dryvan.high7d,  low: rates.dryvan.low7d,  change: rates.dryvan.changeWow,  loads: rates.dryvan.loads,  best: rates.dryvan.topMarket  },
      flatbed: { current: rates.flatbed.current, high: rates.flatbed.high7d, low: rates.flatbed.low7d, change: rates.flatbed.changeWow, loads: rates.flatbed.loads, best: rates.flatbed.topMarket },
    },
    heatmap,
    news,
    stats: {
      national:      diesel.national,
      totalLoads:    stats.totalLoads,
      tlRatio:       stats.reeferTLRatio,
      fuelSurcharge: diesel.national ? calcFuelSurcharge(diesel.national) : null,
    },
    source: 'Perplexity AI + Gemini Search',
    ts: new Date().toISOString(),
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/data:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.json({ ok: true, diesel:{national:null,states:{}}, rates:{reefer:{current:null},dryvan:{current:null},flatbed:{current:null}}, heatmap:[], news:[], stats:{national:null,totalLoads:null,tlRatio:null,fuelSurcharge:null}, ts: new Date().toISOString() });
  }
});

app.post('/api/refresh', async (req, res) => {
  console.log('🔁 REFRESH');
  cache = { data: null, ts: 0 };
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/refresh:', e.message);
    res.json({ ok: true, diesel:{national:null,states:{}}, rates:{reefer:{current:null},dryvan:{current:null},flatbed:{current:null}}, heatmap:[], news:[], stats:{national:null,totalLoads:null,tlRatio:null,fuelSurcharge:null}, ts: new Date().toISOString() });
  }
});

app.post('/api/force-rates', async (req, res) => {
  console.log('⚡ Force rates');
  try {
    const r = await fetchSpotRates();
    const rates = {
      reefer:  { current: r.reefer.current,  high: r.reefer.high7d,  low: r.reefer.low7d,  change: r.reefer.changeWow,  loads: r.reefer.loads,  best: r.reefer.topMarket  },
      dryvan:  { current: r.dryvan.current,  high: r.dryvan.high7d,  low: r.dryvan.low7d,  change: r.dryvan.changeWow,  loads: r.dryvan.loads,  best: r.dryvan.topMarket  },
      flatbed: { current: r.flatbed.current, high: r.flatbed.high7d, low: r.flatbed.low7d, change: r.flatbed.changeWow, loads: r.flatbed.loads, best: r.flatbed.topMarket },
    };
    if (cache.data) { cache.data.rates = rates; cache.data.heatmap = r.reefer.current ? buildHeatmap(r.reefer.current) : []; }
    res.json({ ok: true, rates, ts: new Date().toISOString() });
  } catch(e) {
    console.error('❌ /api/force-rates:', e.message);
    res.json({ ok: true, rates: { reefer:{current:null}, dryvan:{current:null}, flatbed:{current:null} }, ts: new Date().toISOString() });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY, hasGemini: !!GEMINI_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse on port ${PORT}`));
