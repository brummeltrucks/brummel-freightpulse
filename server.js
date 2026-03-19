const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const PPLX_KEY = process.env.PPLX_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CACHE ────────────────────────────────────────────────────────────────────
const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

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

async function askPerplexity(prompt, recency = 'day') {
  if (!PPLX_KEY) throw new Error('No PPLX_KEY');
  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'You are a freight market data API. Search the web for real current data. Return ONLY valid JSON, no markdown, no explanation, no extra text.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 4000, search_recency_filter: recency,
    }),
  }, 25000);
  if (!r.ok) throw new Error(`Perplexity ${r.status}`);
  const d = await r.json();
  return cleanAndParse(d.choices?.[0]?.message?.content || '');
}

// ─── OFFSETS ──────────────────────────────────────────────────────────────────
const REEFER_OFFSETS = {
  CA:+0.28,WA:+0.10,OR:+0.06,NV:-0.04,AZ:-0.02,ID:-0.14,MT:-0.20,WY:-0.20,UT:-0.10,CO:-0.06,
  ND:-0.26,SD:-0.26,NE:-0.20,KS:-0.16,OK:-0.08,NM:-0.12,TX:-0.06,
  MN:-0.12,IA:-0.16,MO:-0.12,WI:-0.06,IL:-0.02,IN:-0.06,MI:-0.02,OH:-0.02,KY:-0.06,
  TN:-0.06,AR:-0.12,LA:-0.06,MS:-0.12,AL:-0.06,GA:+0.04,FL:+0.08,SC:-0.02,NC:-0.02,
  VA:+0.00,WV:-0.12,PA:+0.04,NY:+0.14,NJ:+0.12,CT:+0.12,MA:+0.16,ME:+0.08,
  NH:+0.06,VT:+0.02,RI:+0.08,DE:+0.04,MD:+0.06,DC:+0.08,AK:+0.54,
};
const HEAT_ORDER = ['WA','OR','CA','NV','ID','MT','WY','UT','CO','AZ','ND','SD','NE','KS','OK','TX','NM','MN','IA','MO','WI','IL','IN','MI','OH','KY','TN','AR','LA','MS','AL','GA','FL','SC','NC','VA','WV','PA','NY','NJ','ME','NH','VT','MA','RI','CT','DE','MD','DC','AK'];

function buildHeatmap(nat) {
  if (!nat) return [];
  return HEAT_ORDER.map(abbr => ({ abbr, rate: parseFloat((nat + (REEFER_OFFSETS[abbr]||0)).toFixed(2)) }));
}
function calcFuelSurcharge(d) { return d > 1.20 ? parseFloat(((d-1.20)/0.06).toFixed(1)) : null; }

// ─── FETCH ALL — uma única chamada Perplexity para tudo ───────────────────────
async function fetchAllMarketData() {
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  console.log(`\n📡 Fetching all market data for ${today}...`);

  const prompt = `Today is ${today}. Search the web RIGHT NOW and find these exact current US freight market data points:

1. AAA GasPrices (gasprices.aaa.com) national average diesel price TODAY — the "Current Avg." for Diesel
2. DAT spot rates per loaded mile this week: reefer, dry van, flatbed national averages
3. DAT reefer truck-to-load ratio today
4. Total loads posted on US loadboards (DAT + Truckstop) in last 24h
5. 4 recent FreightWaves news headlines from last 48h impacting trucking market

Search sources: gasprices.aaa.com, dat.com, freightwaves.com, ajot.com, transporttopics.com

Return ONLY this exact JSON structure (use null for any value you cannot find):
{
  "diesel": 4.89,
  "reefer": { "current": 2.28, "high7d": 2.60, "low7d": 1.90, "changeWow": 0.05, "loads": 4500, "topMarket": "Chicago, IL" },
  "dryvan": { "current": 1.92, "high7d": 2.20, "low7d": 1.60, "changeWow": 0.08, "loads": 6200, "topMarket": "Atlanta, GA" },
  "flatbed": { "current": 2.15, "high7d": 2.50, "low7d": 1.80, "changeWow": 0.07, "loads": 2900, "topMarket": "Dallas, TX" },
  "tlRatio": 3.8,
  "totalLoads": 285000,
  "news": [
    { "headline": "Real headline here", "time": "2h ago", "url": "https://www.freightwaves.com/news/slug", "impact": "up" }
  ]
}`;

  try {
    const data = await askPerplexity(prompt, 'day');
    console.log(`  ✅ Raw response keys: ${Object.keys(data||{}).join(', ')}`);
    console.log(`  📊 diesel=${data?.diesel} reefer=${data?.reefer?.current} dryvan=${data?.dryvan?.current} flatbed=${data?.flatbed?.current}`);
    console.log(`  📊 tlRatio=${data?.tlRatio} loads=${data?.totalLoads} news=${data?.news?.length||0}`);
    return data;
  } catch(e) {
    console.error(`  ❌ Perplexity batch failed: ${e.message}`);
    throw e;
  }
}

// ─── FETCH RATES SEPARADO ─────────────────────────────────────────────────────
async function fetchRatesOnly() {
  const today = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  console.log('  📊 Fetching rates separately...');
  const data = await askPerplexity(
    `Search the web for current US truck spot rates per loaded mile, week of ${today}.
Search: freightwaves.com, ajot.com, dat.com, transporttopics.com for "DAT spot rates" or "broker spot rates".
Find national averages for reefer, dry van, and flatbed.
Typical current ranges: reefer $2.10-$2.50, dry van $1.80-$2.20, flatbed $2.00-$2.40.
Return ONLY this JSON with real numbers (not null):
{"reefer":{"current":2.28,"high7d":2.60,"low7d":1.90,"changeWow":0.05,"loads":4500,"topMarket":"Chicago, IL"},"dryvan":{"current":1.92,"high7d":2.20,"low7d":1.60,"changeWow":0.08,"loads":6200,"topMarket":"Atlanta, GA"},"flatbed":{"current":2.15,"high7d":2.50,"low7d":1.80,"changeWow":0.07,"loads":2900,"topMarket":"Dallas, TX"}}`, 'week');
  console.log(`  📊 Rates: reefer=${data?.reefer?.current} dv=${data?.dryvan?.current} fb=${data?.flatbed?.current}`);
  return data;
}

// ─── FETCH NEWS SEPARADO ──────────────────────────────────────────────────────
async function fetchNewsOnly() {
  const today = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  console.log('  📰 Fetching news...');
  const d = await askPerplexity(
    `Search FreightWaves.com for 4 real news articles published this week (${today}) about US trucking.
Topics: spot rates, fuel prices, capacity, FMCSA, ports, bankruptcies.
impact: up=good for carriers, down=bad for rates, neutral=regulatory.
Return ONLY: {"news":[{"headline":"headline text","time":"2h ago","url":"https://www.freightwaves.com/news/slug","impact":"up"}]}`, 'week');
  return (d?.news || []).filter(n => n?.headline?.length > 20).slice(0, 5).map((n, i) => ({ ...n, breaking: i === 0 }));
}

// ─── VALIDATE ─────────────────────────────────────────────────────────────────
function validateNumber(val, min, max) {
  const n = parseFloat(val);
  return (!isNaN(n) && n >= min && n <= max) ? n : null;
}

// ─── BUILD ALL ────────────────────────────────────────────────────────────────
async function buildData() {
  const start = Date.now();

  // Roda as 3 chamadas em paralelo
  const [rMain, rRates, rNews] = await Promise.allSettled([
    fetchAllMarketData(),
    fetchRatesOnly(),
    fetchNewsOnly(),
  ]);

  const main  = rMain.status  === 'fulfilled' ? rMain.value  : null;
  const rates = rRates.status === 'fulfilled' ? rRates.value : null;
  const news  = rNews.status  === 'fulfilled' ? rNews.value  : [];

  // Diesel vem do batch principal
  const diesel = validateNumber(main?.diesel, 3.50, 7.00);

  // Rates: usa chamada dedicada, fallback para batch
  const reeferSrc  = rates?.reefer  || main?.reefer;
  const dryvanSrc  = rates?.dryvan  || main?.dryvan;
  const flatbedSrc = rates?.flatbed || main?.flatbed;

  const reeferCur  = validateNumber(reeferSrc?.current,  1.80, 2.80);
  const dryvanCur  = validateNumber(dryvanSrc?.current,  1.50, 2.50);
  const flatbedCur = validateNumber(flatbedSrc?.current, 1.70, 2.60);

  // Stats vêm do batch
  const tlRatio    = validateNumber(main?.tlRatio,    2.0, 8.0);
  const totalLoads = validateNumber(main?.totalLoads, 100000, 500000);

  console.log(`  ✅ Final: diesel=${diesel} reefer=${reeferCur} dv=${dryvanCur} fb=${flatbedCur} tl=${tlRatio} loads=${totalLoads} news=${news.length}`);

  const mkRate = (src, cur) => cur ? {
    current: cur,
    high:    validateNumber(src?.high7d,    cur, 3.50) || null,
    low:     validateNumber(src?.low7d,     1.20, cur) || null,
    change:  src?.changeWow != null ? parseFloat(src.changeWow) : null,
    loads:   parseInt(src?.loads) || null,
    best:    src?.topMarket || '–',
  } : { current: null, high: null, low: null, change: null, loads: null, best: '–' };

  console.log(`✅ Done in ${((Date.now()-start)/1000).toFixed(1)}s`);

  return {
    ok: true,
    diesel: { national: diesel },
    rates: {
      reefer:  mkRate(reeferSrc,  reeferCur),
      dryvan:  mkRate(dryvanSrc,  dryvanCur),
      flatbed: mkRate(flatbedSrc, flatbedCur),
    },
    heatmap: buildHeatmap(reeferCur),
    news,
    stats: {
      national:      diesel,
      totalLoads:    totalLoads || null,
      tlRatio:       tlRatio || null,
      fuelSurcharge: diesel ? calcFuelSurcharge(diesel) : null,
    },
    source: 'Perplexity AI (sonar-pro)',
    ts: new Date().toISOString(),
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
const EMPTY = { ok:true, diesel:{national:null}, rates:{reefer:{current:null},dryvan:{current:null},flatbed:{current:null}}, heatmap:[], news:[], stats:{national:null,totalLoads:null,tlRatio:null,fuelSurcharge:null}, ts:new Date().toISOString() };

app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/data:', e.message);
    res.json(cache.data ? { ...cache.data, cached:true, stale:true } : EMPTY);
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
    res.json(EMPTY);
  }
});

app.post('/api/force-rates', async (req, res) => {
  console.log('⚡ Force rates');
  cache = { data: null, ts: 0 };
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json({ ok: true, rates: result.rates, ts: result.ts });
  } catch(e) {
    res.json({ ok: true, rates: EMPTY.rates, ts: new Date().toISOString() });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse on port ${PORT}`));
