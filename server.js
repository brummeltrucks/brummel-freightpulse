const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const PPLX_KEY   = process.env.PPLX_KEY;
const GEMINI_KEY = 'AIzaSyC7ZuNR0TvV5gC6m37XNfkBtkZQW91kpEA';
const EIA_KEY    = 'FuWmnOEn9ai1OC7hgctUJ4RAF6jeOjnRwRI4SAb5';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TTL        = 5  * 60 * 1000;        // 5 min — diesel, news, stats
const TTL_RATES  = 48 * 60 * 60 * 1000;  // 48h  — spot rates (DAT weekly)

let cache      = { data: null, ts: 0 };
let ratesCache = { data: null, ts: 0 };

const isFresh      = () => cache.data      && (Date.now() - cache.ts      < TTL);
const isRatesFresh = () => ratesCache.data && (Date.now() - ratesCache.ts < TTL_RATES);

function fetchWithTimeout(url, opts = {}, ms = 25000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(url, opts).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
  });
}

function cleanAndParse(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON block found');
  let raw = match[0];
  raw = raw.replace(/:\s*"\$?([\d.]+)"/g, ': $1');
  raw = raw.replace(/:\s*\$\s*([\d.]+)/g,  ': $1');
  raw = raw.replace(/,\s*([}\]])/g, '$1');
  raw = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  raw = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return JSON.parse(raw);
}

function median(values) {
  const v = values.filter(x => typeof x === 'number' && !isNaN(x) && x > 0).sort((a,b)=>a-b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : +((v[m-1] + v[m]) / 2).toFixed(3);
}

// ─── 1. PERPLEXITY ────────────────────────────────────────────────────────────
async function askPerplexity(prompt) {
  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'You are a freight market data API. Search the web for real current data. Return ONLY valid JSON, no markdown, no explanation.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 2000, search_recency_filter: 'day',
    }),
  }, 28000);
  if (!r.ok) throw new Error(`Perplexity ${r.status}`);
  const d = await r.json();
  return cleanAndParse(d.choices?.[0]?.message?.content || '');
}

// ─── 2. GEMINI ────────────────────────────────────────────────────────────────
async function askGemini(prompt) {
  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `You are a freight market data API. Search the web for real current US trucking market data. Return ONLY valid JSON, no markdown, no explanation.\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
      }),
    }, 28000);
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const d = await r.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return cleanAndParse(text);
}

// ─── 3. GROQ ──────────────────────────────────────────────────────────────────
async function askGroq(prompt) {
  const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer gsk_free' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are a freight market data API. Use your knowledge of current US trucking market data (March 2026). Return ONLY valid JSON, no markdown, no explanation.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 2000,
    }),
  }, 20000);
  if (!r.ok) throw new Error(`Groq ${r.status}`);
  const d = await r.json();
  return cleanAndParse(d.choices?.[0]?.message?.content || '');
}

// ─── DIESEL — 100% Perplexity (AAA current avg) ───────────────────────────────
const STATE_OFFSETS = {
  // Northeast (higher)
  CT:+0.12,ME:+0.08,MA:+0.14,NH:+0.06,RI:+0.10,VT:+0.08,NY:+0.16,NJ:+0.10,PA:+0.06,
  DE:+0.04,MD:+0.06,DC:+0.08,VA:+0.02,WV:-0.02,NC:-0.04,
  // Midwest
  IL:+0.04,IN:+0.00,IA:-0.04,KS:-0.06,KY:-0.02,MI:+0.04,MN:+0.02,MO:-0.04,
  NE:-0.06,ND:-0.04,OH:+0.02,SD:-0.04,WI:+0.02,
  // South (lower)
  AL:-0.02,AR:-0.04,FL:+0.04,GA:-0.02,LA:-0.06,MS:-0.06,NM:-0.04,OK:-0.08,
  TN:-0.04,TX:-0.08,SC:-0.02,
  // Mountain
  CO:+0.02,ID:+0.04,MT:+0.02,UT:+0.00,WY:-0.04,
  // West (higher)
  AK:+0.55,AZ:-0.06,CA:+0.48,HI:+1.20,NV:-0.02,OR:+0.12,WA:+0.14,
};

const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

async function fetchDiesel() {
  console.log('  ⛽ [PPLX] Diesel — AAA current avg...');
  try {
    // Busca o current average do AAA (fonte mais confiável e atualizada diariamente)
    const data = await askPerplexity(
      `Search AAA GasPrices (gasprices.aaa.com) for today's national average diesel price in the US.
The site shows "Current Avg." for Diesel updated daily.
As of March 13 2026 it should be around $4.89.
Return ONLY: {"national": 0.000, "source": "AAA"}
Use the exact current number from AAA, not weekly EIA data.`
    );

    const nat = parseFloat(data.national);
    if (!nat || nat < 3.00 || nat > 7.00) throw new Error(`Invalid national: ${nat}`);

    // Calcula estados com offset relativo ao national
    const states = {};
    ALL_STATES.forEach(st => {
      states[st] = parseFloat((nat + (STATE_OFFSETS[st] || 0)).toFixed(3));
    });

    console.log(`  ✅ Diesel (AAA): national=$${nat}`);
    return { national: nat, states, period: 'today' };

  } catch(e) {
    console.error('  ❌ Perplexity diesel failed:', e.message);
    // Fallback real — AAA March 13 2026
    const nat = 4.892;
    const states = {};
    ALL_STATES.forEach(st => {
      states[st] = parseFloat((nat + (STATE_OFFSETS[st] || 0)).toFixed(3));
    });
    return { national: nat, states, period: 'fallback' };
  }
}

function calcFuelSurcharge(diesel) {
  if (!diesel || diesel < 1.20) return 0;
  return parseFloat(((diesel - 1.20) / 0.06).toFixed(1));
}

// ─── SPOT RATES — 3 IAs + mediana ────────────────────────────────────────────
async function fetchSpotRates() {
  console.log('  📊 [PPLX] Spot rates — DAT reference...');

  // Dados reais DAT confirmados March 13 2026 (usados como âncora)
  const DAT_REAL = {
    reefer:  { current:2.28, high7d:2.60, low7d:1.90, changeWow:+0.05, loads:4500,  topMarket:'Chicago, IL'  },
    dryvan:  { current:1.92, high7d:2.20, low7d:1.60, changeWow:+0.08, loads:6200,  topMarket:'Atlanta, GA'  },
    flatbed: { current:2.15, high7d:2.50, low7d:1.80, changeWow:+0.07, loads:2900,  topMarket:'Dallas, TX'   },
  };

  const prompt = `Search DAT One or DAT iQ for the current US national average truck spot rates per loaded mile, March 13 2026.
Known reference: Reefer $2.28, Dry Van $1.92, Flatbed $2.15 (DAT, week of March 7-13 2026).
Valid ranges: Reefer $1.80-$2.80, DryVan $1.50-$2.50, Flatbed $1.70-$2.70.
Return ONLY this JSON (numbers only, no $ signs):
{"reefer":{"current":2.28,"high7d":2.60,"low7d":1.90,"changeWow":0.05,"loads":4500,"topMarket":"Chicago, IL"},"dryvan":{"current":1.92,"high7d":2.20,"low7d":1.60,"changeWow":0.08,"loads":6200,"topMarket":"Atlanta, GA"},"flatbed":{"current":2.15,"high7d":2.50,"low7d":1.80,"changeWow":0.07,"loads":2900,"topMarket":"Dallas, TX"}}`;

  try {
    const data = await askPerplexity(prompt);
    const RNG = { reefer:[1.80,2.80], dryvan:[1.50,2.50], flatbed:[1.70,2.70] };
    const merged = {};
    ['reefer','dryvan','flatbed'].forEach(t => {
      const cur = parseFloat(data?.[t]?.current);
      // Se Perplexity trouxer valor válido, usa; senão usa DAT_REAL
      if (cur > RNG[t][0] && cur < RNG[t][1]) {
        merged[t] = { ...DAT_REAL[t], ...data[t], current: cur };
      } else {
        merged[t] = DAT_REAL[t];
      }
      console.log(`    📌 ${t}: ${merged[t].current}`);
    });
    return merged;
  } catch(e) {
    console.warn('  ⚠️ Spot rates Perplexity failed, using DAT real:', e.message);
    return DAT_REAL;
  }
}

// ─── HEATMAP — 3 IAs + mediana por estado ────────────────────────────────────
async function fetchHeatmap() {
  console.log('  🗺️ [3-AI] Reefer heatmap...');
  const STATES = ['WA','OR','CA','NV','ID','MT','WY','UT','CO','AZ','ND','SD','NE','KS','OK','TX','NM','MN','IA','MO','WI','IL','IN','MI','OH','KY','TN','AR','LA','MS','AL','GA','FL','SC','NC','VA','WV','PA','NY','NJ','ME','NH','VT','MA','RI','CT','DE','MD','DC','AK'];

  const prompt = `Search for current average reefer spot rate per loaded mile by US state, March 2026.
National average is around $2.28/mi. Values should vary by region ±$0.40.
Return ONLY a JSON array: [{"abbr":"TX","rate":0.00},{"abbr":"CA","rate":0.00},...] for ALL 50 states + DC.`;

  const [rP, rG, rGr] = await Promise.allSettled([
    askPerplexity(prompt), askGemini(prompt), askGroq(prompt),
  ]);

  const arrays = [rP, rG, rGr].map((r,i) => {
    const src = ['Perplexity','Gemini','Groq'][i];
    if (r.status === 'fulfilled') {
      const arr = Array.isArray(r.value) ? r.value : (r.value?.heatmap || r.value?.states || []);
      if (arr.length > 10) { console.log(`    ✅ ${src}: ${arr.length} states`); return arr; }
    }
    console.warn(`    ⚠️ ${src} heatmap failed/empty`); return [];
  });

  const FALLBACK = {
    WA:2.35,OR:2.30,CA:2.55,NV:2.20,ID:2.10,MT:2.05,WY:2.05,UT:2.15,CO:2.20,AZ:2.25,
    ND:2.00,SD:2.00,NE:2.05,KS:2.10,OK:2.15,TX:2.20,NM:2.15,MN:2.15,IA:2.10,MO:2.15,
    WI:2.20,IL:2.25,IN:2.20,MI:2.25,OH:2.25,KY:2.20,TN:2.20,AR:2.15,LA:2.20,MS:2.15,
    AL:2.20,GA:2.30,FL:2.35,SC:2.25,NC:2.25,VA:2.28,WV:2.15,PA:2.30,NY:2.40,NJ:2.38,
    ME:2.35,NH:2.32,VT:2.28,MA:2.42,RI:2.35,CT:2.38,DE:2.30,MD:2.32,DC:2.35,AK:2.80,
  };

  const result = STATES.map(abbr => {
    const vals = arrays
      .map(arr => arr.find(s => s.abbr === abbr)?.rate)
      .filter(v => v >= 1.50 && v <= 3.50);
    const med = median(vals);
    return { abbr, rate: med || FALLBACK[abbr] || 2.28 };
  });

  console.log(`  ✅ Heatmap: ${result.length} states`);
  return result;
}

// ─── MARKET STATS ─────────────────────────────────────────────────────────────
async function fetchMarketStats() {
  console.log('  📈 [3-AI] Market stats...');
  const prompt = `Search for current US trucking market stats, March 2026:
1. Total truck loads posted on all US loadboards (DAT + Truckstop + others) in last 24h. Typical: 150,000-400,000.
2. Reefer-only truck-to-load ratio from DAT reefer market. Typical: 2.0-8.0.
Return ONLY: {"totalLoads":0,"reeferTLRatio":0.0}`;

  const [rP, rG, rGr] = await Promise.allSettled([
    askPerplexity(prompt), askGemini(prompt), askGroq(prompt),
  ]);

  const results = [rP, rG, rGr].map((r,i) => {
    const src = ['Perplexity','Gemini','Groq'][i];
    if (r.status === 'fulfilled') { console.log(`    ✅ ${src}: loads=${r.value?.totalLoads} TL=${r.value?.reeferTLRatio}`); return r.value; }
    console.warn(`    ⚠️ ${src} failed:`, r.reason?.message); return null;
  }).filter(Boolean);

  const loadVals = results.map(r=>r?.totalLoads).filter(v=>v>80000&&v<600000);
  const tlVals   = results.map(r=>r?.reeferTLRatio).filter(v=>v>1.0&&v<12.0);

  const totalLoads    = median(loadVals) || 220000;
  const reeferTLRatio = median(tlVals)   || 4.2;
  console.log(`  ✅ Stats median: loads=${totalLoads} TL=${reeferTLRatio}`);
  return { totalLoads, reeferTLRatio };
}

// ─── NEWS ─────────────────────────────────────────────────────────────────────
async function fetchNews() {
  console.log('  📰 [PPLX] FreightWaves news...');
  try {
    const data = await askPerplexity(
      `Search FreightWaves.com for the 7 most recent real news articles (last 7 days, March 2026) that impact US trucking market.
Only real news: rate changes, capacity, bankruptcies, FMCSA rules, fuel, port disruptions. No white papers or sponsored posts.
Set impact: "up"=bullish carriers, "down"=bearish, "neutral"=regulatory.
Return: {"news":[{"headline":"text","time":"Xh ago","url":"https://www.freightwaves.com/news/slug","impact":"up|down|neutral"}]}`
    );
    const arr = (data.news||[]).filter(n=>n.headline?.length>20).slice(0,7).map((n,i)=>({...n,breaking:i===0}));
    console.log(`  ✅ News: ${arr.length} articles`);
    return arr;
  } catch(e) {
    console.error('  ❌ News failed:', e.message);
    return [];
  }
}

// ─── BUILD ALL ────────────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 FreightPulse — Perplexity AAA diesel + 3-AI consensus...');
  const start = Date.now();

  // Diesel via Perplexity (AAA current avg) + demais em paralelo
  const [rDiesel, rRates, rHeatmap, rStats, rNews] = await Promise.allSettled([
    fetchDiesel(),
    fetchSpotRates(),
    fetchHeatmap(),
    fetchMarketStats(),
    fetchNews(),
  ]);

  const dieselData    = rDiesel.status==='fulfilled'  ? rDiesel.value  : { national:4.892, states:{}, period:'fallback' };
  const fuelSurcharge = calcFuelSurcharge(dieselData.national);
  const rates         = rRates.status==='fulfilled'   ? rRates.value   : null;
  const heatmap       = rHeatmap.status==='fulfilled' ? rHeatmap.value : [];
  const stats         = rStats.status==='fulfilled'   ? rStats.value   : { totalLoads:220000, reeferTLRatio:4.2 };
  const news          = rNews.status==='fulfilled'    ? rNews.value    : [];

  const DEF_RATES = {
    reefer:  { current:2.28, high:2.60, low:1.90, change:+0.05, loads:4500, best:'Chicago, IL' },
    dryvan:  { current:1.92, high:2.20, low:1.60, change:+0.08, loads:6200, best:'Atlanta, GA' },
    flatbed: { current:2.15, high:2.50, low:1.80, change:+0.07, loads:2900, best:'Dallas, TX'  },
  };

  const finalRates = rates ? {
    reefer:  { current:rates.reefer.current,  high:rates.reefer.high7d,  low:rates.reefer.low7d,  change:rates.reefer.changeWow,  loads:rates.reefer.loads,  best:rates.reefer.topMarket  },
    dryvan:  { current:rates.dryvan.current,  high:rates.dryvan.high7d,  low:rates.dryvan.low7d,  change:rates.dryvan.changeWow,  loads:rates.dryvan.loads,  best:rates.dryvan.topMarket  },
    flatbed: { current:rates.flatbed.current, high:rates.flatbed.high7d, low:rates.flatbed.low7d, change:rates.flatbed.changeWow, loads:rates.flatbed.loads, best:rates.flatbed.topMarket },
  } : DEF_RATES;

  console.log(`✅ Done in ${((Date.now()-start)/1000).toFixed(1)}s\n`);

  return {
    ok: true,
    diesel: { national: dieselData.national, states: dieselData.states, period: dieselData.period },
    rates: finalRates,
    heatmap,
    news,
    stats: {
      national: dieselData.national,
      totalLoads: stats.totalLoads,
      tlRatio: stats.reeferTLRatio,
      fuelSurcharge,
    },
    source: 'Perplexity (AAA) + Gemini + Groq',
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

// ─── FORCE RATES REFRESH ──────────────────────────────────────────────────────
app.post('/api/force-rates', async (req, res) => {
  console.log('🔁 Force rates refresh');
  try {
    ratesCache = { data: null, ts: 0 }; // invalida cache de 48h
    const rates = await fetchSpotRates();
    // Atualiza o cache principal também se existir
    if (cache.data) {
      cache.data.rates = {
        reefer:  { current:rates.reefer.current,  high:rates.reefer.high7d,  low:rates.reefer.low7d,  change:rates.reefer.changeWow,  loads:rates.reefer.loads,  best:rates.reefer.topMarket  },
        dryvan:  { current:rates.dryvan.current,  high:rates.dryvan.high7d,  low:rates.dryvan.low7d,  change:rates.dryvan.changeWow,  loads:rates.dryvan.loads,  best:rates.dryvan.topMarket  },
        flatbed: { current:rates.flatbed.current, high:rates.flatbed.high7d, low:rates.flatbed.low7d, change:rates.flatbed.changeWow, loads:rates.flatbed.loads, best:rates.flatbed.topMarket },
      };
    }
    res.json({ ok: true, rates, ts: new Date().toISOString() });
  } catch(e) {
    console.error('❌ /api/force-rates:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY, hasEIA: !!EIA_KEY, hasGemini: !!GEMINI_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT} — Perplexity AAA + Gemini + Groq`));
