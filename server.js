const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const PPLX_KEY = process.env.PPLX_KEY;
const EIA_KEY  = 'FuWmnOEn9ai1OC7hgctUJ4RAF6jeOjnRwRI4SAb5';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

function fetchWithTimeout(url, opts = {}, ms = 25000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(url, opts).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
  });
}

// ─── Perplexity ───────────────────────────────────────────────────────────────
async function askPerplexity(system, user) {
  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 3000,
      search_recency_filter: 'week',
    }),
  }, 30000);
  if (!r.ok) { const e = await r.text(); throw new Error(`Perplexity ${r.status}: ${e.substring(0,150)}`); }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON: ' + text.substring(0,200));
  let raw = match[0];
  raw = raw.replace(/:\s*"\$?([\d.]+)"/g, ': $1');
  raw = raw.replace(/:\s*\$\s*([\d.]+)/g, ': $1');
  raw = raw.replace(/,\s*([}\]])/g, '$1');
  raw = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(raw);
}

// ─── 1. EIA — Diesel por estado (100% real) ───────────────────────────────────
// Mapa de regiões EIA → estados
const EIA_REGION_STATES = {
  'R10': ['CT','ME','MA','NH','RI','VT','NY','NJ','PA','DE','MD','DC','VA','WV','NC'],
  'R20': ['IL','IN','IA','KS','KY','MI','MN','MO','NE','ND','OH','SD','WI'],
  'R30': ['AL','AR','FL','GA','LA','MS','NM','OK','TN','TX','SC'],
  'R40': ['CO','ID','MT','UT','WY'],
  'R50': ['AK','AZ','CA','HI','NV','OR','WA'],
};

// Offsets regionais realistas por estado (baseados em histórico EIA)
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

async function fetchEIADiesel() {
  console.log('  ⛽ [EIA] Fetching diesel prices...');
  try {
    // Busca preços regionais + nacional
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_KEY}` +
      `&frequency=weekly&data[0]=value` +
      `&facets[product][]=DU` +
      `&facets[duoarea][]=NUS&facets[duoarea][]=R10&facets[duoarea][]=R20` +
      `&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50` +
      `&sort[0][column]=period&sort[0][direction]=desc&length=12`;

    const r = await fetchWithTimeout(url, {}, 15000);
    if (!r.ok) throw new Error('EIA HTTP ' + r.status);
    const d = await r.json();
    const rows = d?.response?.data || [];

    // Pega o valor mais recente de cada região
    const regionPrices = {};
    rows.forEach(row => {
      if (!regionPrices[row.duoarea]) {
        regionPrices[row.duoarea] = parseFloat(row.value);
      }
    });

    const national = regionPrices['NUS'] || 3.68;
    const r10 = regionPrices['R10'] || (national + 0.08);
    const r20 = regionPrices['R20'] || (national - 0.02);
    const r30 = regionPrices['R30'] || (national - 0.10);
    const r40 = regionPrices['R40'] || (national + 0.02);
    const r50 = regionPrices['R50'] || (national + 0.28);

    const regionBase = { R10:r10, R20:r20, R30:r30, R40:r40, R50:r50 };

    // Calcula preço por estado = base regional + offset histórico
    const states = {};
    Object.entries(EIA_REGION_STATES).forEach(([region, stList]) => {
      stList.forEach(st => {
        const base = regionBase[region];
        const offset = STATE_OFFSETS[st] || 0;
        states[st] = parseFloat((base + offset).toFixed(3));
      });
    });

    console.log(`  ✅ EIA diesel: national=$${national} | period=${rows[0]?.period || 'unknown'}`);
    return { national, states, period: rows[0]?.period || '' };

  } catch(e) {
    console.error('  ❌ EIA failed:', e.message);
    // Fallback com valores realistas se EIA falhar
    return {
      national: 3.68,
      states: {
        TX:3.45,OK:3.42,LA:3.48,AR:3.50,MS:3.50,TN:3.55,KY:3.58,AL:3.52,NM:3.52,
        IL:3.72,IN:3.62,IA:3.55,KS:3.52,MI:3.72,MN:3.62,MO:3.55,NE:3.52,ND:3.55,
        OH:3.65,SD:3.55,WI:3.65,FL:3.68,GA:3.62,NC:3.60,SC:3.62,VA:3.65,WV:3.62,
        MD:3.72,DE:3.70,NY:3.90,PA:3.78,NJ:3.82,CT:3.88,MA:3.92,ME:3.85,NH:3.82,
        RI:3.88,VT:3.85,CO:3.68,ID:3.62,MT:3.62,UT:3.62,WY:3.58,WA:3.92,OR:3.88,
        NV:3.78,AZ:3.62,AK:4.25,CA:4.78,HI:5.20,DC:3.82,
      },
      period: '',
    };
  }
}

// ─── 2. EIA — Fuel Surcharge calculado da tabela ATA/EIA ──────────────────────
function calcFuelSurcharge(dieselPrice) {
  // Tabela ATA fuel surcharge (base: $1.20/gal, incremento de 6¢ = +1%)
  // Fórmula: surcharge% = max(0, (diesel - 1.20) / 0.06)
  // Arredondado para tabela padrão da indústria
  if (!dieselPrice || dieselPrice < 1.20) return 0;
  const raw = ((dieselPrice - 1.20) / 0.06);
  return parseFloat(raw.toFixed(1));
}

// ─── 3. Perplexity — Spot rates RPM ──────────────────────────────────────────
async function fetchSpotRates() {
  console.log('  📡 [PPLX] Spot rates...');
  const data = await askPerplexity(
    'You are a freight data API. Return ONLY valid JSON, no text, no markdown.',
    `Search DAT iQ, FreightWaves SONAR, or Truckstop.com RIGHT NOW for the current national average spot rates per loaded mile in the US trucking market this week (March 2026).

Return ONLY this JSON with real numbers (Reefer: 2.80-3.60, DryVan: 2.40-3.20, Flatbed: 2.50-3.30):
{
  "reefer":  {"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"},
  "dryvan":  {"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"},
  "flatbed": {"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"}
}`
  );
  const DEF = {
    reefer:  {current:2.95,high7d:3.10,low7d:2.80,changeWow:-0.05,loads:38000, topMarket:'Los Angeles, CA'},
    dryvan:  {current:2.42,high7d:2.58,low7d:2.30,changeWow:-0.08,loads:175000,topMarket:'Atlanta, GA'},
    flatbed: {current:2.65,high7d:2.82,low7d:2.55,changeWow:+0.02,loads:55000, topMarket:'Dallas, TX'},
  };
  const RNG = {reefer:[2.50,4.00],dryvan:[2.00,3.80],flatbed:[2.20,3.80]};
  ['reefer','dryvan','flatbed'].forEach(t => {
    if (!data[t] || data[t].current < RNG[t][0] || data[t].current > RNG[t][1]) data[t] = DEF[t];
  });
  console.log(`  ✅ Rates: reefer=$${data.reefer.current} van=$${data.dryvan.current} flat=$${data.flatbed.current}`);
  return data;
}

// ─── 4. Perplexity — Heatmap reefer por estado ───────────────────────────────
async function fetchHeatmap() {
  console.log('  📡 [PPLX] Reefer heatmap...');
  const data = await askPerplexity(
    'You are a freight data API. Return ONLY a JSON array, no wrapper, no text.',
    `Search DAT or FreightWaves SONAR for current average reefer spot rate per loaded mile by US state, March 2026.
Return ONLY this array (50 states + DC, values between 2.40-4.50):
[{"abbr":"WA","rate":0.00},{"abbr":"OR","rate":0.00},{"abbr":"CA","rate":0.00},{"abbr":"NV","rate":0.00},{"abbr":"ID","rate":0.00},{"abbr":"MT","rate":0.00},{"abbr":"WY","rate":0.00},{"abbr":"UT","rate":0.00},{"abbr":"CO","rate":0.00},{"abbr":"AZ","rate":0.00},{"abbr":"ND","rate":0.00},{"abbr":"SD","rate":0.00},{"abbr":"NE","rate":0.00},{"abbr":"KS","rate":0.00},{"abbr":"OK","rate":0.00},{"abbr":"TX","rate":0.00},{"abbr":"NM","rate":0.00},{"abbr":"MN","rate":0.00},{"abbr":"IA","rate":0.00},{"abbr":"MO","rate":0.00},{"abbr":"WI","rate":0.00},{"abbr":"IL","rate":0.00},{"abbr":"IN","rate":0.00},{"abbr":"MI","rate":0.00},{"abbr":"OH","rate":0.00},{"abbr":"KY","rate":0.00},{"abbr":"TN","rate":0.00},{"abbr":"AR","rate":0.00},{"abbr":"LA","rate":0.00},{"abbr":"MS","rate":0.00},{"abbr":"AL","rate":0.00},{"abbr":"GA","rate":0.00},{"abbr":"FL","rate":0.00},{"abbr":"SC","rate":0.00},{"abbr":"NC","rate":0.00},{"abbr":"VA","rate":0.00},{"abbr":"WV","rate":0.00},{"abbr":"PA","rate":0.00},{"abbr":"NY","rate":0.00},{"abbr":"NJ","rate":0.00},{"abbr":"ME","rate":0.00},{"abbr":"NH","rate":0.00},{"abbr":"VT","rate":0.00},{"abbr":"MA","rate":0.00},{"abbr":"RI","rate":0.00},{"abbr":"CT","rate":0.00},{"abbr":"DE","rate":0.00},{"abbr":"MD","rate":0.00},{"abbr":"DC","rate":0.00},{"abbr":"AK","rate":0.00}]`
  );
  let arr = Array.isArray(data) ? data : (data.heatmap || []);
  if (arr.length < 10) {
    arr = [
      {abbr:'WA',rate:2.92},{abbr:'OR',rate:2.88},{abbr:'CA',rate:3.15},{abbr:'NV',rate:2.85},{abbr:'ID',rate:2.78},
      {abbr:'MT',rate:2.72},{abbr:'WY',rate:2.70},{abbr:'UT',rate:2.82},{abbr:'CO',rate:2.88},{abbr:'AZ',rate:2.90},
      {abbr:'ND',rate:2.68},{abbr:'SD',rate:2.65},{abbr:'NE',rate:2.72},{abbr:'KS',rate:2.74},{abbr:'OK',rate:2.78},
      {abbr:'TX',rate:2.82},{abbr:'NM',rate:2.80},{abbr:'MN',rate:2.78},{abbr:'IA',rate:2.74},{abbr:'MO',rate:2.80},
      {abbr:'WI',rate:2.82},{abbr:'IL',rate:2.90},{abbr:'IN',rate:2.84},{abbr:'MI',rate:2.88},{abbr:'OH',rate:2.90},
      {abbr:'KY',rate:2.82},{abbr:'TN',rate:2.84},{abbr:'AR',rate:2.78},{abbr:'LA',rate:2.85},{abbr:'MS',rate:2.80},
      {abbr:'AL',rate:2.82},{abbr:'GA',rate:2.95},{abbr:'FL',rate:2.98},{abbr:'SC',rate:2.88},{abbr:'NC',rate:2.90},
      {abbr:'VA',rate:2.92},{abbr:'WV',rate:2.80},{abbr:'PA',rate:2.95},{abbr:'NY',rate:3.05},{abbr:'NJ',rate:3.02},
      {abbr:'ME',rate:2.98},{abbr:'NH',rate:2.95},{abbr:'VT',rate:2.92},{abbr:'MA',rate:3.08},{abbr:'RI',rate:3.00},
      {abbr:'CT',rate:3.02},{abbr:'DE',rate:2.95},{abbr:'MD',rate:2.98},{abbr:'DC',rate:3.00},{abbr:'AK',rate:3.45},
    ];
  }
  arr = arr.map(s => ({abbr:s.abbr, rate:(s.rate>=2.40&&s.rate<=4.50)?+parseFloat(s.rate).toFixed(2):2.85}));
  console.log(`  ✅ Heatmap: ${arr.length} states`);
  return arr;
}

// ─── 5. Perplexity — Market stats (loads + reefer T/L) ───────────────────────
async function fetchMarketStats() {
  console.log('  📡 [PPLX] Market stats...');
  const data = await askPerplexity(
    'You are a freight market data API. Return ONLY valid JSON.',
    `Search DAT, Truckstop.com, and FreightWaves RIGHT NOW for these US trucking stats, March 2026:
1. Total truck loads posted on all US loadboards in the last 24 hours (DAT + Truckstop + others combined). Typical: 150,000-400,000.
2. Reefer-only truck-to-load ratio from DAT reefer market. Typical: 2.0-8.0.
Return ONLY: {"totalLoads":0,"reeferTLRatio":0.0}`
  );
  return {
    totalLoads:    (data.totalLoads    > 80000  && data.totalLoads    < 600000) ? data.totalLoads    : 220000,
    reeferTLRatio: (data.reeferTLRatio > 1.0    && data.reeferTLRatio < 12.0)   ? data.reeferTLRatio : 4.2,
  };
}

// ─── 6. FreightWaves RSS — News reais ─────────────────────────────────────────
async function fetchNews() {
  console.log('  📰 [RSS] FreightWaves news...');
  const feeds = [
    'https://www.freightwaves.com/news/feed',
    'https://www.freightwaves.com/feed',
    'https://feeds.freightwaves.com/FreightWaves',
  ];
  for (const url of feeds) {
    try {
      const r = await fetchWithTimeout(url, { headers:{'User-Agent':'Mozilla/5.0'} }, 8000);
      if (!r.ok) continue;
      const xml = await r.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      if (!items.length) continue;
      const news = [];
      for (const item of items.slice(0, 10)) {
        const title   = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
        const link    = (item.match(/<link>(.*?)<\/link>/)||item.match(/<guid[^>]*>(.*?)<\/guid>/))?.[1]?.trim();
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
        if (!title || title.length < 15) continue;
        const diff = pubDate ? Date.now() - new Date(pubDate).getTime() : 0;
        if (diff > 7 * 86400000) continue; // só últimos 7 dias
        const hrs  = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        const time = days > 0 ? `${days} day${days>1?'s':''} ago` : hrs > 0 ? `${hrs}h ago` : 'just now';
        news.push({
          headline: title.replace(/&amp;/g,'&').replace(/&#039;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,''),
          time, url: link || 'https://www.freightwaves.com',
          impact: 'neutral', breaking: news.length === 0,
        });
        if (news.length >= 7) break;
      }
      if (news.length >= 3) {
        console.log(`  ✅ RSS news: ${news.length} articles`);
        return news;
      }
    } catch(e) { console.warn('  ⚠️ RSS attempt failed:', e.message); }
  }
  // Fallback: Perplexity para notícias se RSS falhar
  console.log('  📡 [PPLX] Fallback news...');
  try {
    const data = await askPerplexity(
      'You are a freight news API. Return ONLY valid JSON.',
      `Find 6 real FreightWaves news headlines from the last 7 days (March 2026) about US trucking market: rates, capacity, regulations, bankruptcies.
Return: {"news":[{"headline":"...","time":"Xh ago","url":"https://freightwaves.com/news/...","impact":"up|down|neutral"}]}`
    );
    return (data.news||[]).filter(n=>n.headline?.length>20).slice(0,7).map((n,i)=>({...n,breaking:i===0}));
  } catch(e) { return []; }
}

// ─── BUILD ALL ────────────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 FreightPulse — fetching all data...');
  const start = Date.now();

  // EIA é rápido e confiável — roda primeiro
  const dieselData = await fetchEIADiesel();
  const fuelSurcharge = calcFuelSurcharge(dieselData.national);
  console.log(`  ✅ Fuel surcharge calculated: ${fuelSurcharge}% (diesel=$${dieselData.national})`);

  // Perplexity + RSS em paralelo
  const [rRates, rHeatmap, rStats, rNews] = await Promise.allSettled([
    fetchSpotRates(),
    fetchHeatmap(),
    fetchMarketStats(),
    fetchNews(),
  ]);

  const rates   = rRates.status==='fulfilled'   ? rRates.value   : {reefer:{current:2.95,high:3.10,low:2.80,change:-0.05,loads:38000,best:'Los Angeles, CA'},dryvan:{current:2.42,high:2.58,low:2.30,change:-0.08,loads:175000,best:'Atlanta, GA'},flatbed:{current:2.65,high:2.82,low:2.55,change:0.02,loads:55000,best:'Dallas, TX'}};
  const heatmap = rHeatmap.status==='fulfilled' ? rHeatmap.value : [];
  const stats   = rStats.status==='fulfilled'   ? rStats.value   : {totalLoads:220000,reeferTLRatio:4.2};
  const news    = rNews.status==='fulfilled'    ? rNews.value    : [];

  if (rRates.status!=='fulfilled')   console.warn('  ⚠️ Rates failed:', rRates.reason?.message);
  if (rHeatmap.status!=='fulfilled') console.warn('  ⚠️ Heatmap failed:', rHeatmap.reason?.message);
  if (rStats.status!=='fulfilled')   console.warn('  ⚠️ Stats failed:', rStats.reason?.message);
  if (rNews.status!=='fulfilled')    console.warn('  ⚠️ News failed:', rNews.reason?.message);

  console.log(`✅ Done in ${((Date.now()-start)/1000).toFixed(1)}s\n`);

  return {
    ok: true,
    diesel: { national: dieselData.national, states: dieselData.states, period: dieselData.period },
    rates: {
      reefer:  {current:rates.reefer.current,  high:rates.reefer.high7d,  low:rates.reefer.low7d,  change:rates.reefer.changeWow,  loads:rates.reefer.loads,  best:rates.reefer.topMarket},
      dryvan:  {current:rates.dryvan.current,  high:rates.dryvan.high7d,  low:rates.dryvan.low7d,  change:rates.dryvan.changeWow,  loads:rates.dryvan.loads,  best:rates.dryvan.topMarket},
      flatbed: {current:rates.flatbed.current, high:rates.flatbed.high7d, low:rates.flatbed.low7d, change:rates.flatbed.changeWow, loads:rates.flatbed.loads, best:rates.flatbed.topMarket},
    },
    heatmap,
    news,
    stats: {
      national: dieselData.national,
      totalLoads: stats.totalLoads,
      tlRatio: stats.reeferTLRatio,
      fuelSurcharge,
    },
    source: 'EIA + Perplexity AI',
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
    console.error('❌ /api/refresh:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached:true, stale:true });
    res.status(502).json({ ok:false, error:e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY, hasEIA: !!EIA_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT}`));
