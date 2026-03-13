const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const PPLX_KEY = process.env.PPLX_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

function fetchWithTimeout(url, opts = {}, ms = 28000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(url, opts).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
  });
}

async function askPerplexity(system, user, timeoutMs = 28000) {
  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 3000,
      search_recency_filter: 'week',
    }),
  }, timeoutMs);
  if (!r.ok) { const e = await r.text(); throw new Error(`Perplexity ${r.status}: ${e.substring(0, 150)}`); }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON: ' + text.substring(0, 200));
  return JSON.parse(match[0]);
}

// ─── CALL A: Diesel prices + National avg + Fuel surcharge ────────────────────
async function callA() {
  console.log('  📡 [A] Diesel + National + FSC...');
  const data = await askPerplexity(
    'You are a real-time fuel market data API. Search the web now and return ONLY valid JSON, no markdown, no explanation.',
    `Search the web RIGHT NOW for these US fuel market data points (current week, March 2026):

1. RETAIL DIESEL PUMP PRICES by state — what consumers actually pay at the pump per gallon in ALL 50 states + DC. Use AAA fuel gauge, GasBuddy, or EIA weekly retail prices.

2. NATIONAL AVERAGE diesel pump price (consumer price, not wholesale).

3. FUEL SURCHARGE INDEX — the current fuel surcharge % that US trucking carriers charge shippers based on current diesel prices (ATA/EIA surcharge table). Typical: 25-35%.

Return ONLY this exact JSON (fill ALL states with real current prices, realistic range $3.20-$5.50/gal):
{
  "national": 3.689,
  "fuelSurcharge": 28.5,
  "states": {
    "AL":3.52,"AK":4.10,"AZ":3.65,"AR":3.48,"CA":4.85,"CO":3.70,"CT":3.95,"DE":3.75,
    "FL":3.68,"GA":3.55,"HI":5.20,"ID":3.60,"IL":3.78,"IN":3.62,"IA":3.55,"KS":3.52,
    "KY":3.58,"LA":3.50,"ME":3.88,"MD":3.80,"MA":3.92,"MI":3.72,"MN":3.65,"MS":3.50,
    "MO":3.55,"MT":3.62,"NE":3.55,"NV":3.90,"NH":3.85,"NJ":3.88,"NM":3.55,"NY":4.05,
    "NC":3.60,"ND":3.52,"OH":3.65,"OK":3.45,"OR":3.95,"PA":3.82,"RI":3.90,"SC":3.58,
    "SD":3.55,"TN":3.58,"TX":3.48,"UT":3.68,"VT":3.88,"VA":3.65,"WA":4.00,"WV":3.62,
    "WI":3.68,"WY":3.58,"DC":3.95
  }
}`
  );
  return data;
}

// ─── CALL B: Spot rates + Heatmap + Market stats ──────────────────────────────
async function callB() {
  console.log('  📡 [B] Spot rates + Heatmap + Market stats...');
  const data = await askPerplexity(
    'You are a real-time freight market data API. Search the web now and return ONLY valid JSON, no markdown, no explanation.',
    `Search the web RIGHT NOW for these US trucking market data points (current week, March 2026):

1. SPOT RATES per loaded mile — national averages from DAT Trendlines, FreightWaves SONAR, or Truckstop.com:
   - Reefer (refrigerated trailer) RPM
   - Dry Van (53ft) RPM  
   - Flatbed RPM
   With 7-day high, 7-day low, week-over-week change, loads count, top market city.

2. REEFER RPM BY STATE — current average reefer spot rate per mile for each US state.

3. MARKET STATS:
   - Total truck loads posted across ALL US loadboards (DAT + Truckstop + 123Loadboard + others) in last 24h
   - Reefer truck-to-load ratio (ONLY reefer, not dry van)

Realistic ranges: Reefer $2.80-$3.50/mi, DryVan $2.50-$3.20/mi, Flatbed $2.60-$3.30/mi, Reefer T/L: 2.0-8.0

Return ONLY this exact JSON:
{
  "rates": {
    "reefer":  {"current":3.12,"high7d":3.28,"low7d":2.95,"changeWow":-0.08,"loads":43000,"topMarket":"Los Angeles, CA"},
    "dryvan":  {"current":2.78,"high7d":2.95,"low7d":2.62,"changeWow":-0.12,"loads":190000,"topMarket":"Atlanta, GA"},
    "flatbed": {"current":2.94,"high7d":3.15,"low7d":2.76,"changeWow":-0.05,"loads":60000,"topMarket":"Dallas, TX"}
  },
  "totalLoads": 248000,
  "reeferTLRatio": 3.90,
  "heatmap": [
    {"abbr":"WA","rate":2.85},{"abbr":"OR","rate":2.85},{"abbr":"CA","rate":2.90},{"abbr":"NV","rate":2.80},{"abbr":"ID","rate":2.75},
    {"abbr":"MT","rate":2.70},{"abbr":"WY","rate":2.70},{"abbr":"UT","rate":2.80},{"abbr":"CO","rate":2.75},{"abbr":"AZ","rate":2.85},
    {"abbr":"ND","rate":2.65},{"abbr":"SD","rate":2.65},{"abbr":"NE","rate":2.70},{"abbr":"KS","rate":2.70},{"abbr":"OK","rate":2.75},
    {"abbr":"TX","rate":2.80},{"abbr":"NM","rate":2.80},{"abbr":"MN","rate":2.70},{"abbr":"IA","rate":2.70},{"abbr":"MO","rate":2.70},
    {"abbr":"WI","rate":2.75},{"abbr":"IL","rate":2.75},{"abbr":"IN","rate":2.75},{"abbr":"MI","rate":2.75},{"abbr":"OH","rate":2.75},
    {"abbr":"KY","rate":2.75},{"abbr":"TN","rate":2.80},{"abbr":"AR","rate":2.75},{"abbr":"LA","rate":2.80},{"abbr":"MS","rate":2.75},
    {"abbr":"AL","rate":2.75},{"abbr":"GA","rate":2.75},{"abbr":"FL","rate":2.40},{"abbr":"SC","rate":2.70},{"abbr":"NC","rate":2.70},
    {"abbr":"VA","rate":2.70},{"abbr":"WV","rate":2.70},{"abbr":"PA","rate":2.75},{"abbr":"NY","rate":2.80},{"abbr":"NJ","rate":2.80},
    {"abbr":"ME","rate":2.85},{"abbr":"NH","rate":2.85},{"abbr":"VT","rate":2.85},{"abbr":"MA","rate":2.85},{"abbr":"RI","rate":2.85},
    {"abbr":"CT","rate":2.85},{"abbr":"DE","rate":2.80},{"abbr":"MD","rate":2.80},{"abbr":"DC","rate":2.80},{"abbr":"AK","rate":3.20}
  ]
}`
  );
  return data;
}

// ─── CALL C: FreightWaves news ────────────────────────────────────────────────
async function callC() {
  console.log('  📡 [C] FreightWaves news...');
  const data = await askPerplexity(
    'You are a freight news API. Return ONLY valid JSON, no markdown, no explanation.',
    `Search FreightWaves.com RIGHT NOW for the 7 most recent real news articles published in the last 7 days (March 2026) that directly impact the US trucking/freight market.

Focus on: spot rate changes, capacity news, carrier bankruptcies, FMCSA regulations, fuel prices impact, port disruptions, economic data affecting freight, load volumes.
NO white papers, NO sponsored content, NO job postings.

For each article set "impact":
- "up" = good for carriers (rates rising, tight capacity, strong demand)
- "down" = bad for carriers (rates falling, loose capacity, weak demand)  
- "neutral" = regulatory/informational

Return ONLY this JSON:
{"news":[
  {"headline":"real headline from FreightWaves","time":"1h ago","url":"https://www.freightwaves.com/news/slug","impact":"up"},
  {"headline":"real headline from FreightWaves","time":"2h ago","url":"https://www.freightwaves.com/news/slug","impact":"down"},
  {"headline":"real headline from FreightWaves","time":"1 day ago","url":"https://www.freightwaves.com/news/slug","impact":"neutral"},
  {"headline":"real headline from FreightWaves","time":"2 days ago","url":"https://www.freightwaves.com/news/slug","impact":"up"},
  {"headline":"real headline from FreightWaves","time":"3 days ago","url":"https://www.freightwaves.com/news/slug","impact":"down"},
  {"headline":"real headline from FreightWaves","time":"4 days ago","url":"https://www.freightwaves.com/news/slug","impact":"neutral"},
  {"headline":"real headline from FreightWaves","time":"5 days ago","url":"https://www.freightwaves.com/news/slug","impact":"neutral"}
]}`
  );
  return data;
}

// ─── BUILD ALL ────────────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 FreightPulse — 3 parallel Perplexity searches...');
  const start = Date.now();

  // 3 chamadas em paralelo (em vez de 8)
  const [rA, rB, rC] = await Promise.allSettled([
    callA(),
    callB(),
    callC(),
  ]);

  // ── Fallbacks ──
  const A = rA.status === 'fulfilled' ? rA.value : null;
  const B = rB.status === 'fulfilled' ? rB.value : null;
  const C = rC.status === 'fulfilled' ? rC.value : null;

  if (rA.status !== 'fulfilled') console.warn('  ⚠️ CallA failed:', rA.reason?.message);
  if (rB.status !== 'fulfilled') console.warn('  ⚠️ CallB failed:', rB.reason?.message);
  if (rC.status !== 'fulfilled') console.warn('  ⚠️ CallC failed:', rC.reason?.message);

  const national      = A?.national      > 3.0 ? A.national      : 3.689;
  const fuelSurcharge = A?.fuelSurcharge > 10  ? A.fuelSurcharge : 28.5;
  const states        = A?.states || {};

  const rates = B?.rates || {
    reefer:  { current:3.12, high7d:3.28, low7d:2.95, changeWow:-0.08, loads:43000,  topMarket:'Los Angeles, CA' },
    dryvan:  { current:2.78, high7d:2.95, low7d:2.62, changeWow:-0.12, loads:190000, topMarket:'Atlanta, GA'     },
    flatbed: { current:2.94, high7d:3.15, low7d:2.76, changeWow:-0.05, loads:60000,  topMarket:'Dallas, TX'      },
  };

  // Valida ranges dos rates
  const RANGES = { reefer:[2.50,4.00], dryvan:[2.20,3.80], flatbed:[2.30,3.80] };
  const DEFS   = {
    reefer:  { current:3.12, high7d:3.28, low7d:2.95, changeWow:-0.08, loads:43000,  topMarket:'Los Angeles, CA' },
    dryvan:  { current:2.78, high7d:2.95, low7d:2.62, changeWow:-0.12, loads:190000, topMarket:'Atlanta, GA'     },
    flatbed: { current:2.94, high7d:3.15, low7d:2.76, changeWow:-0.05, loads:60000,  topMarket:'Dallas, TX'      },
  };
  ['reefer','dryvan','flatbed'].forEach(t => {
    if (!rates[t] || rates[t].current < RANGES[t][0] || rates[t].current > RANGES[t][1]) rates[t] = DEFS[t];
  });

  let heatmap = B?.heatmap || [];
  if (!heatmap.length) {
    heatmap = [
      {abbr:'WA',rate:2.85},{abbr:'OR',rate:2.85},{abbr:'CA',rate:2.90},{abbr:'NV',rate:2.80},{abbr:'ID',rate:2.75},
      {abbr:'MT',rate:2.70},{abbr:'WY',rate:2.70},{abbr:'UT',rate:2.80},{abbr:'CO',rate:2.75},{abbr:'AZ',rate:2.85},
      {abbr:'ND',rate:2.65},{abbr:'SD',rate:2.65},{abbr:'NE',rate:2.70},{abbr:'KS',rate:2.70},{abbr:'OK',rate:2.75},
      {abbr:'TX',rate:2.80},{abbr:'NM',rate:2.80},{abbr:'MN',rate:2.70},{abbr:'IA',rate:2.70},{abbr:'MO',rate:2.70},
      {abbr:'WI',rate:2.75},{abbr:'IL',rate:2.75},{abbr:'IN',rate:2.75},{abbr:'MI',rate:2.75},{abbr:'OH',rate:2.75},
      {abbr:'KY',rate:2.75},{abbr:'TN',rate:2.80},{abbr:'AR',rate:2.75},{abbr:'LA',rate:2.80},{abbr:'MS',rate:2.75},
      {abbr:'AL',rate:2.75},{abbr:'GA',rate:2.75},{abbr:'FL',rate:2.40},{abbr:'SC',rate:2.70},{abbr:'NC',rate:2.70},
      {abbr:'VA',rate:2.70},{abbr:'WV',rate:2.70},{abbr:'PA',rate:2.75},{abbr:'NY',rate:2.80},{abbr:'NJ',rate:2.80},
      {abbr:'ME',rate:2.85},{abbr:'NH',rate:2.85},{abbr:'VT',rate:2.85},{abbr:'MA',rate:2.85},{abbr:'RI',rate:2.85},
      {abbr:'CT',rate:2.85},{abbr:'DE',rate:2.80},{abbr:'MD',rate:2.80},{abbr:'DC',rate:2.80},{abbr:'AK',rate:3.20},
    ];
  }
  heatmap = heatmap.map(s => ({ abbr: s.abbr, rate: (s.rate >= 2.40 && s.rate <= 4.50) ? +parseFloat(s.rate).toFixed(2) : 2.80 }));

  const totalLoads    = (B?.totalLoads > 100000 && B?.totalLoads < 600000) ? B.totalLoads : 248000;
  const reeferTLRatio = (B?.reeferTLRatio > 1.0 && B?.reeferTLRatio < 12.0) ? B.reeferTLRatio : 3.90;

  const news = (C?.news || []).filter(n => n.headline && n.headline.length > 20).map((n, i) => ({
    headline: n.headline,
    time: n.time || 'recent',
    url: n.url || 'https://www.freightwaves.com',
    impact: n.impact || 'neutral',
    breaking: i === 0,
  }));

  console.log(`✅ Done in ${((Date.now() - start) / 1000).toFixed(1)}s — diesel:$${national} reefer:$${rates.reefer.current} loads:${totalLoads} TL:${reeferTLRatio}\n`);

  return {
    ok: true,
    diesel: { national, states },
    rates: {
      reefer:  { current:rates.reefer.current,  high:rates.reefer.high7d,  low:rates.reefer.low7d,  change:rates.reefer.changeWow,  loads:rates.reefer.loads,  best:rates.reefer.topMarket  },
      dryvan:  { current:rates.dryvan.current,  high:rates.dryvan.high7d,  low:rates.dryvan.low7d,  change:rates.dryvan.changeWow,  loads:rates.dryvan.loads,  best:rates.dryvan.topMarket  },
      flatbed: { current:rates.flatbed.current, high:rates.flatbed.high7d, low:rates.flatbed.low7d, change:rates.flatbed.changeWow, loads:rates.flatbed.loads, best:rates.flatbed.topMarket },
    },
    heatmap,
    news,
    stats: { national, totalLoads, tlRatio: reeferTLRatio, fuelSurcharge },
    source: 'Perplexity AI',
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
  } catch (e) {
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
  } catch (e) {
    console.error('❌ /api/refresh:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY,
  cacheAge: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) + 's' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT} — Perplexity AI`));
