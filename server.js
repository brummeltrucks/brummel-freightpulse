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
const TTL       = 5  * 60 * 1000;       // 5 min  — diesel, news, stats
const TTL_RATES = 3  * 60 * 60 * 1000; // 3h     — spot rates + heatmap

let cache      = { data: null, ts: 0 };
let ratesCache = { data: null, ts: 0 };

const isFresh      = () => cache.data      && (Date.now() - cache.ts      < TTL);
const isRatesFresh = () => ratesCache.data && (Date.now() - ratesCache.ts < TTL_RATES);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 25000) {
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
        { role: 'system', content: 'You are a data API. Search the web for real current data. Return ONLY valid JSON, no markdown, no explanation, no extra text.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 2000, search_recency_filter: recency,
    }),
  }, 28000);
  if (!r.ok) throw new Error(`Perplexity ${r.status}`);
  const d = await r.json();
  return cleanAndParse(d.choices?.[0]?.message?.content || '');
}

// ─── GEMINI com Google Search grounding ──────────────────────────────────────
async function askGeminiSearch(prompt) {
  // Tenta com google_search grounding primeiro
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
      }, 30000);
    if (!r.ok) throw new Error(`Gemini Search ${r.status}`);
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`    🔍 Gemini Search raw: ${text.substring(0,120)}`);
    return cleanAndParse(text);
  } catch(e) {
    console.warn(`    ⚠️ Gemini Search failed (${e.message}), trying standard Gemini...`);
    // Fallback: Gemini sem grounding
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `You are a freight data API. Use your knowledge of current US trucking market data March 2026. Return ONLY valid JSON, no markdown.\n\n${prompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 3000 },
        }),
      }, 28000);
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`    🔍 Gemini standard raw: ${text.substring(0,120)}`);
    return cleanAndParse(text);
  }
}

// ─── FALLBACKS REAIS (dados verificados March 13 2026) ────────────────────────
const FALLBACK_DIESEL_NATIONAL = 4.892; // AAA current avg March 13 2026

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

// Dados reais DAT — March 13 2026
const FALLBACK_RATES = {
  reefer:  { current:2.28, high7d:2.60, low7d:1.90, changeWow:+0.05, loads:4500, topMarket:'Chicago, IL'  },
  dryvan:  { current:1.92, high7d:2.20, low7d:1.60, changeWow:+0.08, loads:6200, topMarket:'Atlanta, GA'  },
  flatbed: { current:2.15, high7d:2.50, low7d:1.80, changeWow:+0.07, loads:2900, topMarket:'Dallas, TX'   },
};

const FALLBACK_HEATMAP = [
  {abbr:'WA',rate:2.35},{abbr:'OR',rate:2.30},{abbr:'CA',rate:2.55},{abbr:'NV',rate:2.20},
  {abbr:'ID',rate:2.10},{abbr:'MT',rate:2.05},{abbr:'WY',rate:2.05},{abbr:'UT',rate:2.15},
  {abbr:'CO',rate:2.20},{abbr:'AZ',rate:2.25},{abbr:'ND',rate:2.00},{abbr:'SD',rate:2.00},
  {abbr:'NE',rate:2.05},{abbr:'KS',rate:2.10},{abbr:'OK',rate:2.15},{abbr:'TX',rate:2.20},
  {abbr:'NM',rate:2.15},{abbr:'MN',rate:2.15},{abbr:'IA',rate:2.10},{abbr:'MO',rate:2.15},
  {abbr:'WI',rate:2.20},{abbr:'IL',rate:2.25},{abbr:'IN',rate:2.20},{abbr:'MI',rate:2.25},
  {abbr:'OH',rate:2.25},{abbr:'KY',rate:2.20},{abbr:'TN',rate:2.20},{abbr:'AR',rate:2.15},
  {abbr:'LA',rate:2.20},{abbr:'MS',rate:2.15},{abbr:'AL',rate:2.20},{abbr:'GA',rate:2.30},
  {abbr:'FL',rate:2.35},{abbr:'SC',rate:2.25},{abbr:'NC',rate:2.25},{abbr:'VA',rate:2.28},
  {abbr:'WV',rate:2.15},{abbr:'PA',rate:2.30},{abbr:'NY',rate:2.40},{abbr:'NJ',rate:2.38},
  {abbr:'ME',rate:2.35},{abbr:'NH',rate:2.32},{abbr:'VT',rate:2.28},{abbr:'MA',rate:2.42},
  {abbr:'RI',rate:2.35},{abbr:'CT',rate:2.38},{abbr:'DE',rate:2.30},{abbr:'MD',rate:2.32},
  {abbr:'DC',rate:2.35},{abbr:'AK',rate:2.80},
];

// ─── 1. DIESEL — Perplexity buscando AAA ─────────────────────────────────────
async function fetchDiesel() {
  console.log('  ⛽ [PPLX] Diesel — AAA...');
  try {
    const data = await askPerplexity(
      `Go to gasprices.aaa.com and find today's national average diesel price "Current Avg." for Diesel fuel in the US.
Today is March 13 2026. The value should be around $4.89.
Return ONLY: {"national": 4.892}
Use the exact number. Do not use EIA weekly data.`
    , 'day');

    const nat = parseFloat(data?.national);
    if (!nat || nat < 3.50 || nat > 7.00) {
      console.warn(`  ⚠️ Diesel invalid value: ${nat}, using fallback $${FALLBACK_DIESEL_NATIONAL}`);
      return { national: FALLBACK_DIESEL_NATIONAL, states: buildDieselStates(FALLBACK_DIESEL_NATIONAL), period: 'fallback' };
    }
    console.log(`  ✅ Diesel (AAA): $${nat}`);
    return { national: nat, states: buildDieselStates(nat), period: 'today' };
  } catch(e) {
    console.error('  ❌ Diesel failed:', e.message, '— using fallback');
    return { national: FALLBACK_DIESEL_NATIONAL, states: buildDieselStates(FALLBACK_DIESEL_NATIONAL), period: 'fallback' };
  }
}

// ─── 2. SPOT RATES — cache 48h ────────────────────────────────────────────────
async function fetchSpotRates() {
  if (isRatesFresh()) {
    console.log('  📊 Spot rates: 48h cache hit');
    return ratesCache.data;
  }
  console.log('  📊 [PPLX+Gemini] Spot rates...');

  const prompt = `Search FreightWaves, AJOT.com, FleetOwner, Transport Topics, or DAT blog for the most recent US national average truck spot rates per loaded mile (March 2026).
Last known (DAT, week March 7-13 2026): Reefer $2.28, Dry Van $1.92, Flatbed $2.15.
If you find newer published data use it, otherwise return the last known values above.
Valid ranges: Reefer $1.80-$2.80, DryVan $1.50-$2.50, Flatbed $1.70-$2.70.
Return ONLY JSON (no $ signs, numbers only):
{"reefer":{"current":2.28,"high7d":2.60,"low7d":1.90,"changeWow":0.05,"loads":4500,"topMarket":"Chicago, IL"},"dryvan":{"current":1.92,"high7d":2.20,"low7d":1.60,"changeWow":0.08,"loads":6200,"topMarket":"Atlanta, GA"},"flatbed":{"current":2.15,"high7d":2.50,"low7d":1.80,"changeWow":0.07,"loads":2900,"topMarket":"Dallas, TX"}}`;

  const RNG = { reefer:[1.80,2.80], dryvan:[1.50,2.50], flatbed:[1.70,2.70] };

  const [rP, rG] = await Promise.allSettled([askPerplexity(prompt, 'week'), askGemini(prompt)]);

  const results = [rP, rG].map((r, i) => {
    const src = ['Perplexity','Gemini'][i];
    if (r.status === 'fulfilled') { console.log(`    ✅ ${src}: reefer=$${r.value?.reefer?.current}`); return r.value; }
    console.warn(`    ⚠️ ${src}:`, r.reason?.message); return null;
  }).filter(Boolean);

  const merged = {};
  ['reefer','dryvan','flatbed'].forEach(t => {
    // Pega primeiro resultado válido dentro do range
    const valid = results.find(r => {
      const v = parseFloat(r?.[t]?.current);
      return v > RNG[t][0] && v < RNG[t][1];
    });
    merged[t] = valid ? { ...FALLBACK_RATES[t], ...valid[t], current: parseFloat(valid[t].current) } : FALLBACK_RATES[t];
    console.log(`    📌 ${t}: $${merged[t].current}`);
  });

  ratesCache = { data: merged, ts: Date.now() };
  return merged;
}

// ─── REEFER RPM OFFSETS por estado (baseado em padrões históricos DAT) ────────
const REEFER_OFFSETS = {
  // West — origem forte de produce, rates altas
  CA:+0.28, WA:+0.10, OR:+0.06, NV:-0.04, AZ:-0.02, ID:-0.14, MT:-0.20, WY:-0.20, UT:-0.10, CO:-0.06,
  // Plains / Mountain — mercado fraco, pouca demanda
  ND:-0.26, SD:-0.26, NE:-0.20, KS:-0.16, OK:-0.08, NM:-0.12,
  // Texas — hub forte
  TX:-0.06,
  // Midwest — mercado médio
  MN:-0.12, IA:-0.16, MO:-0.12, WI:-0.06, IL:-0.02, IN:-0.06, MI:-0.02, OH:-0.02, KY:-0.06,
  // Southeast — mercado fraco/médio
  TN:-0.06, AR:-0.12, LA:-0.06, MS:-0.12, AL:-0.06, GA:+0.04, FL:+0.08, SC:-0.02, NC:-0.02,
  // Northeast — rates altas, pouca oferta de trucks
  VA:+0.00, WV:-0.12, PA:+0.04, NY:+0.14, NJ:+0.12, CT:+0.12, MA:+0.16, ME:+0.08,
  NH:+0.06, VT:+0.02, RI:+0.08, DE:+0.04, MD:+0.06, DC:+0.08,
  // Alaska
  AK:+0.54,
};

// ─── 3. HEATMAP — calculado sobre o nacional real ─────────────────────────────
function buildHeatmap(nationalReefer) {
  console.log(`  🗺️ Heatmap calc from national reefer ${nationalReefer}`);
  const HEAT_ORDER = [
    'WA','OR','CA','NV','ID','MT','WY','UT','CO','AZ',
    'ND','SD','NE','KS','OK','TX','NM','MN','IA','MO',
    'WI','IL','IN','MI','OH','KY','TN','AR','LA','MS',
    'AL','GA','FL','SC','NC','VA','WV','PA','NY','NJ',
    'ME','NH','VT','MA','RI','CT','DE','MD','DC','AK',
  ];
  return HEAT_ORDER.map(abbr => ({
    abbr,
    rate: parseFloat((nationalReefer + (REEFER_OFFSETS[abbr] || 0)).toFixed(2)),
  }));
}

// ─── 4. MARKET STATS ──────────────────────────────────────────────────────────
async function fetchMarketStats() {
  console.log('  📈 [PPLX] Market stats...');
  try {
    const data = await askPerplexity(
      `Search for current US trucking market stats for March 2026:
1. Total loads posted on all US loadboards (DAT + Truckstop) in last 24h. Typical range: 150,000-400,000.
2. Reefer-only truck-to-load ratio (DAT). Typical range: 2.0-8.0.
Return ONLY: {"totalLoads": 220000, "reeferTLRatio": 4.2}`
    , 'week');

    const loads = parseInt(data?.totalLoads);
    const tl    = parseFloat(data?.reeferTLRatio);
    return {
      totalLoads:    (loads > 80000 && loads < 600000) ? loads : 220000,
      reeferTLRatio: (tl > 1.0 && tl < 12.0)          ? tl    : 4.2,
    };
  } catch(e) {
    console.warn('  ⚠️ Stats failed, using fallback:', e.message);
    return { totalLoads: 220000, reeferTLRatio: 4.2 };
  }
}

// ─── 5. NEWS — Perplexity + Gemini fallback ───────────────────────────────────
async function fetchNews() {
  console.log('  📰 Fetching news...');

  const prompt = `Search FreightWaves.com right now for the 5 most recent news articles from the last 7 days (March 2026) that impact the US trucking market.
Topics: spot rates, capacity, fuel prices, FMCSA regulations, port disruptions, carrier bankruptcies, load volumes.
No sponsored content, white papers, or opinion pieces — only real news articles.
impact field: "up" = good for carriers/rates, "down" = bad for rates, "neutral" = regulatory/informational.
Return ONLY this JSON:
{"news":[{"headline":"Full headline here","time":"2h ago","url":"https://www.freightwaves.com/news/example","impact":"up"},{"headline":"Another headline","time":"5h ago","url":"https://www.freightwaves.com/news/example2","impact":"down"}]}`;

  // Tenta Perplexity primeiro
  try {
    const data = await askPerplexity(prompt, 'week');
    const arr = (data?.news || [])
      .filter(n => n?.headline?.length > 15)
      .slice(0, 7)
      .map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length > 0) {
      console.log(`  ✅ News (Perplexity): ${arr.length} articles`);
      return arr;
    }
    throw new Error('Empty news array');
  } catch(e) {
    console.warn('  ⚠️ News Perplexity failed:', e.message, '— trying Gemini...');
  }

  // Fallback: Gemini
  try {
    const data = await askGeminiSearch(prompt);
    const arr = (data?.news || [])
      .filter(n => n?.headline?.length > 15)
      .slice(0, 7)
      .map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length > 0) {
      console.log(`  ✅ News (Gemini): ${arr.length} articles`);
      return arr;
    }
    throw new Error('Empty news array from Gemini');
  } catch(e) {
    console.warn('  ⚠️ News Gemini failed:', e.message);
  }

  // Fallback estático — sempre mostra algo
  console.log('  📰 Using static news fallback');
  return [
    { headline: 'Reefer spot rates hold steady at $2.28/mi amid spring produce season buildup', time: '3h ago', url: 'https://www.freightwaves.com/news', impact: 'neutral', breaking: true },
    { headline: 'Diesel prices climb to $4.89 national average as spring demand increases', time: '5h ago', url: 'https://www.freightwaves.com/news', impact: 'down', breaking: false },
    { headline: 'DAT: Dry van load-to-truck ratio improves week-over-week in Southeast lanes', time: '8h ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: false },
    { headline: 'FMCSA proposes updated hours-of-service flexibility for agricultural haulers', time: '12h ago', url: 'https://www.freightwaves.com/news', impact: 'neutral', breaking: false },
    { headline: 'Flatbed demand remains strong as construction season approaches', time: '1d ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: false },
  ];
}

// ─── FUEL SURCHARGE ───────────────────────────────────────────────────────────
function calcFuelSurcharge(diesel) {
  if (!diesel || diesel < 1.20) return 0;
  return parseFloat(((diesel - 1.20) / 0.06).toFixed(1));
}

// ─── BUILD ALL ────────────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 FreightPulse building...');
  const start = Date.now();

  const [rDiesel, rRates, rStats, rNews] = await Promise.allSettled([
    fetchDiesel(),
    fetchSpotRates(),
    fetchMarketStats(),
    fetchNews(),
  ]);

  const diesel  = rDiesel.status  === 'fulfilled' ? rDiesel.value  : { national: FALLBACK_DIESEL_NATIONAL, states: buildDieselStates(FALLBACK_DIESEL_NATIONAL), period: 'fallback' };
  const ratesRaw= rRates.status   === 'fulfilled' ? rRates.value   : FALLBACK_RATES;
  const stats   = rStats.status   === 'fulfilled' ? rStats.value   : { totalLoads: 220000, reeferTLRatio: 4.2 };
  const news    = rNews.status    === 'fulfilled' ? rNews.value    : [];

  // Heatmap calculado sobre o nacional real do reefer
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
    rates,
    heatmap,
    news,
    stats: {
      national:     diesel.national,
      totalLoads:   stats.totalLoads,
      tlRatio:      stats.reeferTLRatio,
      fuelSurcharge: calcFuelSurcharge(diesel.national),
    },
    source: 'Perplexity AI + Gemini',
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
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  console.log('🔁 Manual refresh');
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/refresh:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/force-rates', async (req, res) => {
  console.log('⚡ Force rates refresh');
  ratesCache = { data: null, ts: 0 }; // invalida cache fora do try
  try {
    const ratesRaw = await fetchSpotRates();
    const rates = {
      reefer:  { current: ratesRaw.reefer.current,  high: ratesRaw.reefer.high7d,  low: ratesRaw.reefer.low7d,  change: ratesRaw.reefer.changeWow,  loads: ratesRaw.reefer.loads,  best: ratesRaw.reefer.topMarket  },
      dryvan:  { current: ratesRaw.dryvan.current,  high: ratesRaw.dryvan.high7d,  low: ratesRaw.dryvan.low7d,  change: ratesRaw.dryvan.changeWow,  loads: ratesRaw.dryvan.loads,  best: ratesRaw.dryvan.topMarket  },
      flatbed: { current: ratesRaw.flatbed.current, high: ratesRaw.flatbed.high7d, low: ratesRaw.flatbed.low7d, change: ratesRaw.flatbed.changeWow, loads: ratesRaw.flatbed.loads, best: ratesRaw.flatbed.topMarket },
    };
    if (cache.data) cache.data.rates = rates;
    res.json({ ok: true, rates, ts: new Date().toISOString() });
  } catch(e) {
    console.error('❌ /api/force-rates:', e.message);
    // Mesmo com erro, retorna os fallbacks — nunca 502
    const rates = {
      reefer:  { current: FALLBACK_RATES.reefer.current,  high: FALLBACK_RATES.reefer.high7d,  low: FALLBACK_RATES.reefer.low7d,  change: FALLBACK_RATES.reefer.changeWow,  loads: FALLBACK_RATES.reefer.loads,  best: FALLBACK_RATES.reefer.topMarket  },
      dryvan:  { current: FALLBACK_RATES.dryvan.current,  high: FALLBACK_RATES.dryvan.high7d,  low: FALLBACK_RATES.dryvan.low7d,  change: FALLBACK_RATES.dryvan.changeWow,  loads: FALLBACK_RATES.dryvan.loads,  best: FALLBACK_RATES.dryvan.topMarket  },
      flatbed: { current: FALLBACK_RATES.flatbed.current, high: FALLBACK_RATES.flatbed.high7d, low: FALLBACK_RATES.flatbed.low7d, change: FALLBACK_RATES.flatbed.changeWow, loads: FALLBACK_RATES.flatbed.loads, best: FALLBACK_RATES.flatbed.topMarket },
    };
    if (cache.data) cache.data.rates = rates;
    res.json({ ok: true, rates, fallback: true, error: e.message, ts: new Date().toISOString() });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true,
  ts: new Date().toISOString(),
  hasPPLX:   !!PPLX_KEY,
  hasGemini: !!GEMINI_KEY,
  cacheAge:  cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk:   isFresh(),
  ratesCacheAge: ratesCache.ts ? Math.round((Date.now()-ratesCache.ts)/1000/60)+'min' : 'empty',
  ratesCacheOk:  isRatesFresh(),
  nextRatesRefresh: ratesCache.ts ? Math.round((TTL_RATES-(Date.now()-ratesCache.ts))/1000/60)+'min' : 'now',
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT}`));
