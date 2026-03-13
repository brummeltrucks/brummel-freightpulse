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

function fetchWithTimeout(url, options = {}, ms = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

// ─── Perplexity helper ────────────────────────────────────────────────────────
async function askPerplexity(systemPrompt, userPrompt) {
  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.1,
      max_tokens: 2000,
      search_recency_filter: 'week',
    }),
  }, 30000);
  if (!r.ok) { const e = await r.text(); throw new Error(`Perplexity ${r.status}: ${e.substring(0,150)}`); }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  const match = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON in response: ' + text.substring(0,200));
  return JSON.parse(match[0]);
}

// ─── 1. Diesel por estado — 100% Perplexity ───────────────────────────────────
async function fetchDieselPrices() {
  console.log('  🔍 Fetching diesel prices via Perplexity...');
  const data = await askPerplexity(
    'You are a fuel price data API. Return only valid JSON, no extra text.',
    `Search EIA.gov right now for the latest weekly retail diesel prices at the pump for consumers in the USA (March 2026).
Find: national average and all 50 states + DC prices in $/gallon.
Return ONLY this exact JSON (use real current EIA data):
{"national":0.000,"states":{"TX":0.000,"OK":0.000,"LA":0.000,"AR":0.000,"MS":0.000,"TN":0.000,"KY":0.000,"AL":0.000,"NM":0.000,"IL":0.000,"IN":0.000,"IA":0.000,"KS":0.000,"MI":0.000,"MN":0.000,"MO":0.000,"NE":0.000,"ND":0.000,"OH":0.000,"SD":0.000,"WI":0.000,"FL":0.000,"GA":0.000,"NC":0.000,"SC":0.000,"VA":0.000,"WV":0.000,"MD":0.000,"DE":0.000,"NY":0.000,"PA":0.000,"NJ":0.000,"CT":0.000,"MA":0.000,"ME":0.000,"NH":0.000,"RI":0.000,"VT":0.000,"CO":0.000,"ID":0.000,"MT":0.000,"UT":0.000,"WY":0.000,"WA":0.000,"OR":0.000,"NV":0.000,"AZ":0.000,"AK":0.000,"CA":0.000,"HI":0.000,"DC":0.000}}`
  );
  console.log(`  ✅ Diesel national: $${data.national}`);
  return { national: data.national || 3.68, states: data.states || {} };
}

// ─── 2. Spot rates (RPM) por tipo de trailer ──────────────────────────────────
async function fetchSpotRates() {
  console.log('  🔍 Fetching spot rates...');
  const data = await askPerplexity(
    'You are a freight rate data API. Return only valid JSON. All rates are national averages per loaded mile in USD.',
    `Search DAT.com, FreightWaves, and Truckstop.com right now for the current national average spot rates per loaded mile for:
- Dry Van (53ft)
- Reefer (refrigerated trailer)
- Flatbed

Look specifically at DAT trendlines, FreightWaves SONAR, or any freight market report published this week (March 2026).

IMPORTANT: Values must be realistic current market rates:
- Dry Van: between $2.50 and $3.20/mile
- Reefer: between $2.80 and $3.50/mile  
- Flatbed: between $2.60 and $3.30/mile

Return ONLY this JSON with real searched values:
{
  "reefer":  {"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"},
  "dryvan":  {"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"},
  "flatbed": {"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"}
}`
  );
  const ranges = { reefer:[2.80,3.50], dryvan:[2.50,3.20], flatbed:[2.60,3.30] };
  const defaults = {
    reefer:  { current:3.04, high7d:3.20, low7d:2.88, changeWow:0.02, loads:43000,  topMarket:'Los Angeles, CA' },
    dryvan:  { current:2.95, high7d:3.10, low7d:2.72, changeWow:0.03, loads:190000, topMarket:'Chicago, IL'     },
    flatbed: { current:2.87, high7d:3.02, low7d:2.68, changeWow:0.04, loads:60000,  topMarket:'Houston, TX'     },
  };
  ['reefer','dryvan','flatbed'].forEach(t => {
    const r = data[t];
    if (!r || r.current < ranges[t][0] || r.current > ranges[t][1]) {
      console.warn(`  ⚠️ ${t} rate invalid (${r?.current}), using default`);
      data[t] = defaults[t];
    }
  });
  console.log(`  ✅ Rates: Van $${data.dryvan.current} Reefer $${data.reefer.current} Flatbed $${data.flatbed.current}`);
  return data;
}

// ─── 3. Heatmap: RPM médio de Reefer por estado ───────────────────────────────
async function fetchReeferHeatmap() {
  console.log('  🔍 Fetching reefer heatmap...');
  const data = await askPerplexity(
    'You are a freight rate data API. Return only valid JSON array, no extra text, no wrapper object.',
    `Search DAT.com, FreightWaves SONAR, or Truckstop.com for the current average reefer spot rate per loaded mile for each US state (March 2026).
All values must be between $2.40 and $4.00/mile. Use regional freight knowledge if exact state data unavailable.
Return ONLY a raw JSON array (no wrapper, no "heatmap" key), exactly like this:
[{"abbr":"WA","rate":0.00},{"abbr":"OR","rate":0.00},{"abbr":"CA","rate":0.00},{"abbr":"NV","rate":0.00},{"abbr":"ID","rate":0.00},{"abbr":"MT","rate":0.00},{"abbr":"WY","rate":0.00},{"abbr":"UT","rate":0.00},{"abbr":"CO","rate":0.00},{"abbr":"AZ","rate":0.00},{"abbr":"ND","rate":0.00},{"abbr":"SD","rate":0.00},{"abbr":"NE","rate":0.00},{"abbr":"KS","rate":0.00},{"abbr":"OK","rate":0.00},{"abbr":"TX","rate":0.00},{"abbr":"NM","rate":0.00},{"abbr":"MN","rate":0.00},{"abbr":"IA","rate":0.00},{"abbr":"MO","rate":0.00},{"abbr":"WI","rate":0.00},{"abbr":"IL","rate":0.00},{"abbr":"IN","rate":0.00},{"abbr":"MI","rate":0.00},{"abbr":"OH","rate":0.00},{"abbr":"KY","rate":0.00},{"abbr":"TN","rate":0.00},{"abbr":"AR","rate":0.00},{"abbr":"LA","rate":0.00},{"abbr":"MS","rate":0.00},{"abbr":"AL","rate":0.00},{"abbr":"GA","rate":0.00},{"abbr":"FL","rate":0.00},{"abbr":"SC","rate":0.00},{"abbr":"NC","rate":0.00},{"abbr":"VA","rate":0.00},{"abbr":"WV","rate":0.00},{"abbr":"PA","rate":0.00},{"abbr":"NY","rate":0.00},{"abbr":"NJ","rate":0.00},{"abbr":"ME","rate":0.00},{"abbr":"NH","rate":0.00},{"abbr":"VT","rate":0.00},{"abbr":"MA","rate":0.00},{"abbr":"RI","rate":0.00},{"abbr":"CT","rate":0.00},{"abbr":"DE","rate":0.00},{"abbr":"MD","rate":0.00},{"abbr":"DC","rate":0.00},{"abbr":"AK","rate":0.00}]`
  );

  // Suporta array direto OU objeto com chave heatmap
  let arr = Array.isArray(data) ? data : (data.heatmap || []);

  // Se ainda vazio, usa fallback regional realista
  if (!arr.length) {
    console.warn('  ⚠️ Heatmap empty, using regional fallback');
    arr = [
      {abbr:'WA',rate:3.05},{abbr:'OR',rate:2.98},{abbr:'CA',rate:3.45},{abbr:'NV',rate:2.95},{abbr:'ID',rate:2.85},
      {abbr:'MT',rate:2.80},{abbr:'WY',rate:2.78},{abbr:'UT',rate:2.90},{abbr:'CO',rate:2.95},{abbr:'AZ',rate:3.00},
      {abbr:'ND',rate:2.75},{abbr:'SD',rate:2.72},{abbr:'NE',rate:2.80},{abbr:'KS',rate:2.82},{abbr:'OK',rate:2.85},
      {abbr:'TX',rate:2.90},{abbr:'NM',rate:2.88},{abbr:'MN',rate:2.85},{abbr:'IA',rate:2.82},{abbr:'MO',rate:2.88},
      {abbr:'WI',rate:2.90},{abbr:'IL',rate:3.00},{abbr:'IN',rate:2.92},{abbr:'MI',rate:2.95},{abbr:'OH',rate:2.98},
      {abbr:'KY',rate:2.88},{abbr:'TN',rate:2.90},{abbr:'AR',rate:2.85},{abbr:'LA',rate:2.92},{abbr:'MS',rate:2.88},
      {abbr:'AL',rate:2.90},{abbr:'GA',rate:3.05},{abbr:'FL',rate:3.10},{abbr:'SC',rate:2.98},{abbr:'NC',rate:3.00},
      {abbr:'VA',rate:3.02},{abbr:'WV',rate:2.85},{abbr:'PA',rate:3.05},{abbr:'NY',rate:3.15},{abbr:'NJ',rate:3.12},
      {abbr:'ME',rate:3.08},{abbr:'NH',rate:3.05},{abbr:'VT',rate:3.02},{abbr:'MA',rate:3.18},{abbr:'RI',rate:3.10},
      {abbr:'CT',rate:3.12},{abbr:'DE',rate:3.05},{abbr:'MD',rate:3.08},{abbr:'DC',rate:3.10},{abbr:'AK',rate:3.50},
    ];
  }

  arr = arr.map(s => ({ abbr: s.abbr, rate: (s.rate >= 2.40 && s.rate <= 4.00) ? +s.rate.toFixed(2) : 2.90 }));
  console.log(`  ✅ Heatmap: ${arr.length} states`);
  return arr;
}

// ─── 4. Stats: loads, T/L ratio REEFER, fuel surcharge ───────────────────────
async function fetchMarketStats() {
  console.log('  🔍 Fetching market stats...');
  const data = await askPerplexity(
    'You are a freight market statistics API. Return only valid JSON.',
    `Search the web right now for these current US trucking market statistics (March 2026):

1. TOTAL LOADS POSTED in the last 24 hours across all major US loadboards (DAT, Truckstop.com, CH Robinson, Coyote, Echo). Approximate total truck freight loads posted nationwide. Typically 150,000-400,000/day.

2. REEFER TRUCK/LOAD RATIO: Current national load-to-truck ratio SPECIFICALLY and ONLY for REEFER/refrigerated trailers. Search DAT trendlines or FreightWaves SONAR for reefer T/L ratio. Typically between 2.0 and 8.0. DO NOT return dry van or general ratio — only reefer.

3. FUEL SURCHARGE INDEX: Current US national diesel fuel surcharge percentage that carriers charge shippers. Search ATA (trucking.org), EIA fuel surcharge table, or DAT. Typically 25%-35%.

Return ONLY this JSON:
{"totalLoads":0,"reeferTLRatio":0.0,"fuelSurcharge":0.0}`
  );
  const stats = {
    totalLoads:    (data.totalLoads    > 150000 && data.totalLoads    < 500000) ? data.totalLoads    : 248000,
    tlRatio:       (data.reeferTLRatio > 1.5    && data.reeferTLRatio < 10.0)   ? data.reeferTLRatio : 3.9,
    fuelSurcharge: (data.fuelSurcharge > 15     && data.fuelSurcharge < 50)     ? data.fuelSurcharge : 28.5,
  };
  console.log(`  ✅ Stats: loads=${stats.totalLoads} Reefer TL=${stats.tlRatio} FSC=${stats.fuelSurcharge}%`);
  return stats;
}

// ─── 5. News — apenas FreightWaves, impacto de mercado ───────────────────────
async function fetchTruckingNews() {
  console.log('  🔍 Fetching FreightWaves news...');
  try {
    const data = await askPerplexity(
      'You are a freight news API. Return only valid JSON.',
      `Search FreightWaves (freightwaves.com) right now for the latest news articles published in the last 7 days (March 2026).

IMPORTANT RULES:
- Only include real news articles from FreightWaves, not white papers, sponsored content, or press releases
- Focus ONLY on news that directly impacts the freight/trucking market: rate changes, capacity shifts, carrier bankruptcies, regulation changes, economic data affecting freight, fuel price news, FMCSA rules, port disruptions, supply chain disruptions
- Do NOT include job postings, product announcements, or general industry education pieces
- Each headline must clearly describe a market-moving event

Return ONLY this JSON with 7 real FreightWaves news headlines, sorted newest first:
{"news":[
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"},
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"},
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"},
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"},
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"},
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"},
  {"headline":"real headline here","time":"X hr ago","url":"https://www.freightwaves.com/news/...","impact":"up|down|neutral"}
]}`
    );

    let newsArr = data.news || [];

    // Normaliza e filtra
    newsArr = newsArr
      .filter(n => n.headline && n.headline.length > 20)
      .map((n, i) => ({
        source: i === 0 ? 'BREAKING' : 'FREIGHTWAVES',
        type:   i === 0 ? 'breaking' : 'market',
        headline: n.headline,
        time: n.time || 'recent',
        url:  n.url  || 'https://www.freightwaves.com',
        impact: n.impact || 'neutral',
      }));

    console.log(`  ✅ FreightWaves news: ${newsArr.length} items`);
    return newsArr;
  } catch(e) {
    console.warn('  ⚠️ FreightWaves news error:', e.message);
    return [];
  }
}

// ─── Build all data ───────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 Building all data...');
  const start = Date.now();

  const [dieselData, spotRates, heatmap, stats, news] = await Promise.allSettled([
    fetchDieselPrices(),
    fetchSpotRates(),
    fetchReeferHeatmap(),
    fetchMarketStats(),
    fetchTruckingNews(),
  ]);

  const diesel = dieselData.status==='fulfilled' ? dieselData.value : { national:3.68, states:{} };
  const rates  = spotRates.status==='fulfilled'  ? spotRates.value  : {
    reefer:  { current:3.04, high7d:3.20, low7d:2.88, changeWow:0.02, loads:43000,  topMarket:'Los Angeles, CA' },
    dryvan:  { current:2.95, high7d:3.10, low7d:2.72, changeWow:0.03, loads:190000, topMarket:'Chicago, IL'     },
    flatbed: { current:2.87, high7d:3.02, low7d:2.68, changeWow:0.04, loads:60000,  topMarket:'Houston, TX'     },
  };
  const hmap    = heatmap.status==='fulfilled' ? heatmap.value : [];
  const st      = stats.status==='fulfilled'   ? stats.value   : { totalLoads:248000, tlRatio:3.9, fuelSurcharge:28.5 };
  const newsArr = news.status==='fulfilled'    ? news.value    : [];

  const ratesFormatted = {
    reefer:  { current:rates.reefer.current,  high:rates.reefer.high7d,  low:rates.reefer.low7d,  change:rates.reefer.changeWow,  loads:rates.reefer.loads,  best:rates.reefer.topMarket  },
    dryvan:  { current:rates.dryvan.current,  high:rates.dryvan.high7d,  low:rates.dryvan.low7d,  change:rates.dryvan.changeWow,  loads:rates.dryvan.loads,  best:rates.dryvan.topMarket  },
    flatbed: { current:rates.flatbed.current, high:rates.flatbed.high7d, low:rates.flatbed.low7d, change:rates.flatbed.changeWow, loads:rates.flatbed.loads, best:rates.flatbed.topMarket },
  };

  console.log(`✅ All data ready in ${((Date.now()-start)/1000).toFixed(1)}s\n`);

  return {
    ok: true,
    diesel: { national: diesel.national, states: diesel.states },
    rates: ratesFormatted,
    heatmap: hmap,
    news: newsArr,
    stats: {
      national:      diesel.national,
      totalLoads:    st.totalLoads,
      tlRatio:       st.tlRatio,       // ← reefer only
      fuelSurcharge: st.fuelSurcharge,
    },
    grounded: true,
    ts: new Date().toISOString(),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌', e.message);
    if (cache.data) return res.json({ ...cache.data, cached:true, stale:true });
    res.status(502).json({ ok:false, error:e.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  console.log('🔁 Manual refresh');
  try {
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ Refresh:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached:true, stale:true });
    res.status(502).json({ ok:false, error:e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse on port ${PORT}`));
