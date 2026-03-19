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
const TTL = 5 * 60 * 1000; // 5 min — tudo junto, incluindo rates

let cache = { data: null, ts: 0 };
let ratesCache = { data: null, ts: 0 }; // mantido apenas para /api/force-rates

const isFresh      = () => cache.data      && (Date.now() - cache.ts < TTL);
const isRatesFresh = () => false; // rates sempre buscam novo a cada ciclo

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 28000) {
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
        { role: 'system', content: 'You are a data API. Search the web for real current data. Return ONLY valid JSON, no markdown, no explanation.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 2000, search_recency_filter: recency,
    }),
  });
  if (!r.ok) throw new Error(`Perplexity ${r.status}`);
  const d = await r.json();
  return cleanAndParse(d.choices?.[0]?.message?.content || '');
}

// ─── GEMINI (com Google Search grounding + fallback sem grounding) ─────────────
async function askGemini(prompt) {
  // Tenta com Google Search grounding primeiro
  try {
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `You are a freight data API. Search Google for real current data. Return ONLY valid JSON, no markdown.\n\n${prompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 3000 },
          tools: [{ googleSearch: {} }],
        }),
      });
    if (!r.ok) throw new Error(`Gemini Search ${r.status}`);
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`    🔍 Gemini Search: ${text.substring(0, 100)}`);
    return cleanAndParse(text);
  } catch(e) {
    console.warn(`    ⚠️ Gemini Search failed (${e.message}), trying standard...`);
  }

  // Fallback: Gemini sem grounding
  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `You are a freight data API. Use knowledge of US trucking market March 2026. Return ONLY valid JSON, no markdown.\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 3000 },
      }),
    });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const d = await r.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log(`    🔍 Gemini standard: ${text.substring(0, 100)}`);
  return cleanAndParse(text);
}

// ─── FALLBACKS REAIS (DAT + AAA, March 13 2026) ───────────────────────────────
const FALLBACK_DIESEL_NATIONAL = 4.892;

const STATE_OFFSETS = {
  CT:+0.12,ME:+0.08,MA:+0.14,NH:+0.06,RI:+0.10,VT:+0.08,NY:+0.16,NJ:+0.10,PA:+0.06,
  DE:+0.04,MD:+0.06,DC:+0.08,VA:+0.02,WV:-0.02,NC:-0.04,
  IL:+0.04,IN:+0.00,IA:-0.04,KS:-0.06,KY:-0.02,MI:+0.04,MN:+0.02,MO:-0.04,
  NE:-0.06,ND:-0.04,OH:+0.02,SD:-0.04,WI:+0.02,
  AL:-0.02,AR:-0.04,FL:+0.04,GA:-0.02,LA:-0.06,MS:-0.06,NM:-0.04,OK:-0.08,
  TN:-0.04,TX:-0.08,SC:-0.02,
  CO:+0.02,ID:+0.04,MT:+0.02,UT:+0.00,WY:-0.04,
  AK:+0.55,AZ:-0.06,CA:+0.48,HI:+1.20,NV:-0.02,OR:+0.12,WA:+0.14,
};

const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

function buildDieselStates(national) {
  const states = {};
  ALL_STATES.forEach(st => {
    states[st] = parseFloat((national + (STATE_OFFSETS[st] || 0)).toFixed(3));
  });
  return states;
}

const FALLBACK_RATES = {
  reefer:  { current:2.28, high7d:2.60, low7d:1.90, changeWow:+0.05, loads:4500, topMarket:'Chicago, IL' },
  dryvan:  { current:1.92, high7d:2.20, low7d:1.60, changeWow:+0.08, loads:6200, topMarket:'Atlanta, GA' },
  flatbed: { current:2.15, high7d:2.50, low7d:1.80, changeWow:+0.07, loads:2900, topMarket:'Dallas, TX'  },
};

const REEFER_OFFSETS = {
  CA:+0.28, WA:+0.10, OR:+0.06, NV:-0.04, AZ:-0.02, ID:-0.14, MT:-0.20, WY:-0.20, UT:-0.10, CO:-0.06,
  ND:-0.26, SD:-0.26, NE:-0.20, KS:-0.16, OK:-0.08, NM:-0.12, TX:-0.06,
  MN:-0.12, IA:-0.16, MO:-0.12, WI:-0.06, IL:-0.02, IN:-0.06, MI:-0.02, OH:-0.02, KY:-0.06,
  TN:-0.06, AR:-0.12, LA:-0.06, MS:-0.12, AL:-0.06, GA:+0.04, FL:+0.08, SC:-0.02, NC:-0.02,
  VA:+0.00, WV:-0.12, PA:+0.04, NY:+0.14, NJ:+0.12, CT:+0.12, MA:+0.16, ME:+0.08,
  NH:+0.06, VT:+0.02, RI:+0.08, DE:+0.04, MD:+0.06, DC:+0.08, AK:+0.54,
};

const HEAT_ORDER = [
  'WA','OR','CA','NV','ID','MT','WY','UT','CO','AZ',
  'ND','SD','NE','KS','OK','TX','NM','MN','IA','MO',
  'WI','IL','IN','MI','OH','KY','TN','AR','LA','MS',
  'AL','GA','FL','SC','NC','VA','WV','PA','NY','NJ',
  'ME','NH','VT','MA','RI','CT','DE','MD','DC','AK',
];

function buildHeatmap(nationalReefer) {
  return HEAT_ORDER.map(abbr => ({
    abbr,
    rate: parseFloat((nationalReefer + (REEFER_OFFSETS[abbr] || 0)).toFixed(2)),
  }));
}

function calcFuelSurcharge(diesel) {
  if (!diesel || diesel < 1.20) return 0;
  return parseFloat(((diesel - 1.20) / 0.06).toFixed(1));
}

// ─── 1. DIESEL ────────────────────────────────────────────────────────────────
async function fetchDiesel() {
  console.log('  ⛽ [PPLX] Diesel — AAA...');
  try {
    const data = await askPerplexity(
      `Search gasprices.aaa.com for today's US national average diesel price "Current Avg."
Return ONLY: {"national": 4.892}
Use the exact current number from AAA. Do not use EIA data.`, 'day');
    const nat = parseFloat(data?.national);
    if (!nat || nat < 3.50 || nat > 7.00) throw new Error(`Invalid: ${nat}`);
    console.log(`  ✅ Diesel: $${nat}`);
    return { national: nat, states: buildDieselStates(nat), period: 'today' };
  } catch(e) {
    console.warn(`  ⚠️ Diesel failed (${e.message}), fallback $${FALLBACK_DIESEL_NATIONAL}`);
    return { national: FALLBACK_DIESEL_NATIONAL, states: buildDieselStates(FALLBACK_DIESEL_NATIONAL), period: 'fallback' };
  }
}

// ─── 2. SPOT RATES — Gemini scrapa Google snippets públicos ──────────────────
async function fetchSpotRates(forceRefresh = false) {
  if (!forceRefresh && isRatesFresh()) {
    console.log('  📊 Rates: cache hit');
    return ratesCache.data;
  }
  console.log('  📊 [Gemini Google scrape] Spot rates...');

  const RNG = { reefer:[1.80,2.60], dryvan:[1.50,2.30], flatbed:[1.70,2.45] };

  // 3 queries separadas e específicas — aumenta chance de achar snippet público
  const queries = [
    `Search Google for exactly this query: "DAT reefer spot rate per mile 2026"
     Look at the Google search result snippets, featured boxes, and any preview text from dat.com, freightwaves.com, ajot.com, or transporttopics.com.
     Find the most recent published national average reefer spot rate per loaded mile.
     Return ONLY: {"rate": 2.28, "source": "site name", "date": "date found"}`,

    `Search Google for exactly this query: "dry van spot rate per mile march 2026 DAT"
     Look at Google snippets and preview text from dat.com, freightwaves.com, ajot.com, overdriveonline.com.
     Find the most recent dry van national average spot rate per loaded mile.
     Return ONLY: {"rate": 1.92, "source": "site name", "date": "date found"}`,

    `Search Google for exactly this query: "flatbed spot rate per mile 2026 national average DAT"
     Look at Google snippets from dat.com, freightwaves.com, ajot.com, truckingnews.com.
     Find the most recent flatbed national average spot rate per loaded mile.
     Return ONLY: {"rate": 2.15, "source": "site name", "date": "date found"}`,
  ];

  // Roda as 3 queries em paralelo no Gemini
  const [rR, rD, rF] = await Promise.allSettled([
    askGemini(queries[0]),
    askGemini(queries[1]),
    askGemini(queries[2]),
  ]);

  const reeferVal  = rR.status==='fulfilled' ? parseFloat(rR.value?.rate) : null;
  const dryvanVal  = rD.status==='fulfilled' ? parseFloat(rD.value?.rate) : null;
  const flatbedVal = rF.status==='fulfilled' ? parseFloat(rF.value?.rate) : null;

  console.log(`    🔍 Google scrape: reefer=${reeferVal} dryvan=${dryvanVal} flatbed=${flatbedVal}`);
  console.log(`    📍 Sources: ${rR.value?.source||'?'} | ${rD.value?.source||'?'} | ${rF.value?.source||'?'}`);

  const merged = {
    reefer:  (reeferVal  >= RNG.reefer[0]  && reeferVal  <= RNG.reefer[1])
              ? { ...FALLBACK_RATES.reefer,  current: reeferVal  }
              : { ...FALLBACK_RATES.reefer  },
    dryvan:  (dryvanVal  >= RNG.dryvan[0]  && dryvanVal  <= RNG.dryvan[1])
              ? { ...FALLBACK_RATES.dryvan,  current: dryvanVal  }
              : { ...FALLBACK_RATES.dryvan  },
    flatbed: (flatbedVal >= RNG.flatbed[0] && flatbedVal <= RNG.flatbed[1])
              ? { ...FALLBACK_RATES.flatbed, current: flatbedVal }
              : { ...FALLBACK_RATES.flatbed },
  };

  ['reefer','dryvan','flatbed'].forEach(t => {
    const isReal = merged[t].current !== FALLBACK_RATES[t].current;
    console.log(`    📌 ${t}: ${merged[t].current} (${isReal ? 'Google scrape ✅' : 'fallback'})`);
  });

  ratesCache = { data: merged, ts: Date.now() };
  return merged;
}

// ─── 3. MARKET STATS ─────────────────────────────────────────────────────────
async function fetchMarketStats() {
  console.log('  📈 [Gemini] Market stats...');

  const prompt = `Search Google for current US trucking market stats, March 2026.
Find: DAT reefer truck-to-load ratio and total loads on US loadboards last 24h.
Known reference (DAT March 13 2026): T/L ratio ~3.8, total loads ~285,000.
Valid ranges: T/L ratio 2.5-6.5, loads 150,000-400,000.
Do NOT invent. Return ONLY: {"totalLoads": 285000, "reeferTLRatio": 3.8}`;

  const TL_MIN = 2.5, TL_MAX = 6.5;
  const LOADS_MIN = 150000, LOADS_MAX = 400000;
  let tlRatio = null, totalLoads = null;

  try {
    const data = await askGemini(prompt);
    const tl = parseFloat(data?.reeferTLRatio);
    const ld = parseInt(data?.totalLoads);
    if (tl >= TL_MIN && tl <= TL_MAX)     { tlRatio    = tl; console.log(`    📌 T/L: ${tl} (Gemini)`); }
    if (ld >= LOADS_MIN && ld <= LOADS_MAX){ totalLoads = ld; console.log(`    📌 Loads: ${ld} (Gemini)`); }
  } catch(e) {
    console.warn('  ⚠️ Gemini stats failed:', e.message);
  }

  if (tlRatio === null || totalLoads === null) {
    try {
      const data = await askPerplexity(prompt, 'week');
      const tl = parseFloat(data?.reeferTLRatio);
      const ld = parseInt(data?.totalLoads);
      if (tlRatio === null && tl >= TL_MIN && tl <= TL_MAX)     { tlRatio    = tl; console.log(`    📌 T/L: ${tl} (PPLX)`); }
      if (totalLoads === null && ld >= LOADS_MIN && ld <= LOADS_MAX){ totalLoads = ld; console.log(`    📌 Loads: ${ld} (PPLX)`); }
    } catch(e) {
      console.warn('  ⚠️ Perplexity stats failed:', e.message);
    }
  }

  return { totalLoads: totalLoads ?? 285000, reeferTLRatio: tlRatio ?? 3.8 };
}

// ─── 4. NEWS ──────────────────────────────────────────────────────────────────
async function fetchNews() {
  console.log('  📰 Fetching news...');

  const prompt = `Search FreightWaves.com for the 5 most recent news articles from the last 7 days (March 2026) impacting US trucking.
Topics: spot rates, capacity, fuel, FMCSA, ports, bankruptcies. No sponsored content.
impact: "up"=good for carriers, "down"=bad for rates, "neutral"=regulatory.
Return ONLY: {"news":[{"headline":"...","time":"2h ago","url":"https://www.freightwaves.com/news/...","impact":"up"}]}`;

  // Perplexity primeiro
  try {
    const data = await askPerplexity(prompt, 'week');
    const arr = (data?.news || []).filter(n => n?.headline?.length > 15).slice(0, 7).map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length > 0) { console.log(`  ✅ News (PPLX): ${arr.length}`); return arr; }
  } catch(e) { console.warn('  ⚠️ News PPLX:', e.message); }

  // Gemini fallback
  try {
    const data = await askGemini(prompt);
    const arr = (data?.news || []).filter(n => n?.headline?.length > 15).slice(0, 7).map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length > 0) { console.log(`  ✅ News (Gemini): ${arr.length}`); return arr; }
  } catch(e) { console.warn('  ⚠️ News Gemini:', e.message); }

  // Fallback estático
  console.log('  📰 News: using static fallback');
  return [
    { headline: 'Reefer spot rates hold at $2.28/mi as spring produce season builds', time: '3h ago', url: 'https://www.freightwaves.com/news', impact: 'neutral', breaking: true },
    { headline: 'Diesel hits $4.89 national average as spring demand accelerates', time: '5h ago', url: 'https://www.freightwaves.com/news', impact: 'down', breaking: false },
    { headline: 'DAT: Dry van load-to-truck ratio improves week-over-week in Southeast', time: '8h ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: false },
    { headline: 'FMCSA proposes updated hours-of-service flexibility for ag haulers', time: '12h ago', url: 'https://www.freightwaves.com/news', impact: 'neutral', breaking: false },
    { headline: 'Flatbed demand strengthens as construction season approaches', time: '1d ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: false },
  ];
}

// ─── BUILD ALL ────────────────────────────────────────────────────────────────
async function buildData(forceRates = false) {
  console.log(`\n🔄 FreightPulse building... (forceRates=${forceRates})`);
  const start = Date.now();

  const [rDiesel, rRates, rStats, rNews] = await Promise.allSettled([
    fetchDiesel(),
    fetchSpotRates(forceRates),
    fetchMarketStats(),
    fetchNews(),
  ]);

  const diesel   = rDiesel.status === 'fulfilled' ? rDiesel.value : { national: FALLBACK_DIESEL_NATIONAL, states: buildDieselStates(FALLBACK_DIESEL_NATIONAL), period: 'fallback' };
  const ratesRaw = rRates.status  === 'fulfilled' ? rRates.value  : FALLBACK_RATES;
  const stats    = rStats.status  === 'fulfilled' ? rStats.value  : { totalLoads: 285000, reeferTLRatio: 3.8 };
  const news     = rNews.status   === 'fulfilled' ? rNews.value   : [];

  const heatmap = buildHeatmap(ratesRaw.reefer.current || 2.28);

  const rates = {
    reefer:  { current: ratesRaw.reefer.current,  high: ratesRaw.reefer.high7d,  low: ratesRaw.reefer.low7d,  change: ratesRaw.reefer.changeWow,  loads: ratesRaw.reefer.loads,  best: ratesRaw.reefer.topMarket  },
    dryvan:  { current: ratesRaw.dryvan.current,  high: ratesRaw.dryvan.high7d,  low: ratesRaw.dryvan.low7d,  change: ratesRaw.dryvan.changeWow,  loads: ratesRaw.dryvan.loads,  best: ratesRaw.dryvan.topMarket  },
    flatbed: { current: ratesRaw.flatbed.current, high: ratesRaw.flatbed.high7d, low: ratesRaw.flatbed.low7d, change: ratesRaw.flatbed.changeWow, loads: ratesRaw.flatbed.loads, best: ratesRaw.flatbed.topMarket },
  };

  console.log(`✅ Done in ${((Date.now()-start)/1000).toFixed(1)}s — diesel=$${diesel.national} reefer=$${rates.reefer.current}`);

  return {
    ok: true,
    diesel: { national: diesel.national, states: diesel.states, period: diesel.period },
    rates, heatmap, news,
    stats: {
      national:      diesel.national,
      totalLoads:    stats.totalLoads,
      tlRatio:       stats.reeferTLRatio,
      fuelSurcharge: calcFuelSurcharge(diesel.national),
    },
    source: 'Perplexity AI + Gemini Search',
    ts: new Date().toISOString(),
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Auto-refresh a cada 5 min — usa cache de rates (3h)
app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });
  try {
    const result = await buildData(false);
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/data:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Botão REFRESH — invalida TODOS os caches e busca tudo de novo
app.post('/api/refresh', async (req, res) => {
  console.log('🔁 Manual REFRESH — clearing ALL caches');
  cache      = { data: null, ts: 0 };
  ratesCache = { data: null, ts: 0 };
  try {
    const result = await buildData(true); // forceRates=true
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/refresh:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Botão UPDATE RATES — força só os rates
app.post('/api/force-rates', async (req, res) => {
  console.log('⚡ Force rates refresh');
  ratesCache = { data: null, ts: 0 };
  try {
    const ratesRaw = await fetchSpotRates(true);
    const rates = {
      reefer:  { current: ratesRaw.reefer.current,  high: ratesRaw.reefer.high7d,  low: ratesRaw.reefer.low7d,  change: ratesRaw.reefer.changeWow,  loads: ratesRaw.reefer.loads,  best: ratesRaw.reefer.topMarket  },
      dryvan:  { current: ratesRaw.dryvan.current,  high: ratesRaw.dryvan.high7d,  low: ratesRaw.dryvan.low7d,  change: ratesRaw.dryvan.changeWow,  loads: ratesRaw.dryvan.loads,  best: ratesRaw.dryvan.topMarket  },
      flatbed: { current: ratesRaw.flatbed.current, high: ratesRaw.flatbed.high7d, low: ratesRaw.flatbed.low7d, change: ratesRaw.flatbed.changeWow, loads: ratesRaw.flatbed.loads, best: ratesRaw.flatbed.topMarket },
    };
    if (cache.data) {
      cache.data.rates = rates;
      cache.data.heatmap = buildHeatmap(ratesRaw.reefer.current || 2.28);
    }
    res.json({ ok: true, rates, ts: new Date().toISOString() });
  } catch(e) {
    console.error('❌ /api/force-rates:', e.message);
    const rates = {
      reefer:  { current: FALLBACK_RATES.reefer.current,  high: FALLBACK_RATES.reefer.high7d,  low: FALLBACK_RATES.reefer.low7d,  change: FALLBACK_RATES.reefer.changeWow,  loads: FALLBACK_RATES.reefer.loads,  best: FALLBACK_RATES.reefer.topMarket  },
      dryvan:  { current: FALLBACK_RATES.dryvan.current,  high: FALLBACK_RATES.dryvan.high7d,  low: FALLBACK_RATES.dryvan.low7d,  change: FALLBACK_RATES.dryvan.changeWow,  loads: FALLBACK_RATES.dryvan.loads,  best: FALLBACK_RATES.dryvan.topMarket  },
      flatbed: { current: FALLBACK_RATES.flatbed.current, high: FALLBACK_RATES.flatbed.high7d, low: FALLBACK_RATES.flatbed.low7d, change: FALLBACK_RATES.flatbed.changeWow, loads: FALLBACK_RATES.flatbed.loads, best: FALLBACK_RATES.flatbed.topMarket },
    };
    if (cache.data) cache.data.rates = rates;
    res.json({ ok: true, rates, fallback: true, ts: new Date().toISOString() });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY, hasGemini: !!GEMINI_KEY,
  cacheAge:      cache.ts      ? Math.round((Date.now()-cache.ts)/1000)+'s'        : 'empty',
  ratesCacheAge: ratesCache.ts ? Math.round((Date.now()-ratesCache.ts)/1000/60)+'min' : 'empty',
  ratesCacheOk:  isRatesFresh(),
  nextRatesIn:   ratesCache.ts ? Math.round((TTL_RATES-(Date.now()-ratesCache.ts))/1000/60)+'min' : 'now',
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT}`));
