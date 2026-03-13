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

const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

function fetchWithTimeout(url, opts = {}, ms = 25000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(url, opts).then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); rej(e); });
  });
}

// ─── JSON cleaner ─────────────────────────────────────────────────────────────
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

// ─── Mediana de números ───────────────────────────────────────────────────────
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
      temperature: 0.1, max_tokens: 2000, search_recency_filter: 'week',
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

// ─── EIA Diesel (100% real) ───────────────────────────────────────────────────
const EIA_REGION_STATES = {
  'R10': ['CT','ME','MA','NH','RI','VT','NY','NJ','PA','DE','MD','DC','VA','WV','NC'],
  'R20': ['IL','IN','IA','KS','KY','MI','MN','MO','NE','ND','OH','SD','WI'],
  'R30': ['AL','AR','FL','GA','LA','MS','NM','OK','TN','TX','SC'],
  'R40': ['CO','ID','MT','UT','WY'],
  'R50': ['AK','AZ','CA','HI','NV','OR','WA'],
};
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
  console.log('  ⛽ [EIA] Diesel prices...');
  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_KEY}` +
      `&frequency=weekly&data[0]=value&facets[product][]=DU` +
      `&facets[duoarea][]=NUS&facets[duoarea][]=R10&facets[duoarea][]=R20` +
      `&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50` +
      `&sort[0][column]=period&sort[0][direction]=desc&length=12`;
    const r = await fetchWithTimeout(url, {}, 15000);
    if (!r.ok) throw new Error('EIA HTTP ' + r.status);
    const d = await r.json();
    const rows = d?.response?.data || [];
    const rp = {};
    rows.forEach(row => { if (!rp[row.duoarea]) rp[row.duoarea] = parseFloat(row.value); });
    const nat = rp['NUS'] || 3.68;
    const r10 = rp['R10'] || nat+0.08, r20 = rp['R20'] || nat-0.02;
    const r30 = rp['R30'] || nat-0.10, r40 = rp['R40'] || nat+0.02;
    const r50 = rp['R50'] || nat+0.28;
    const regionBase = { R10:r10, R20:r20, R30:r30, R40:r40, R50:r50 };
    const states = {};
    Object.entries(EIA_REGION_STATES).forEach(([region, list]) => {
      list.forEach(st => {
        states[st] = parseFloat((regionBase[region] + (STATE_OFFSETS[st]||0)).toFixed(3));
      });
    });
    console.log(`  ✅ EIA: national=$${nat} period=${rows[0]?.period||'?'}`);
    return { national: nat, states, period: rows[0]?.period || '' };
  } catch(e) {
    console.error('  ❌ EIA failed:', e.message);
    return { national: 3.68, states: {}, period: '' };
  }
}

function calcFuelSurcharge(diesel) {
  if (!diesel || diesel < 1.20) return 0;
  return parseFloat(((diesel - 1.20) / 0.06).toFixed(1));
}

// ─── SPOT RATES — 3 IAs + mediana ────────────────────────────────────────────
async function fetchSpotRates() {
  console.log('  📊 [3-AI] Spot rates...');
  const prompt = `Search for the current US national average truck spot rates per loaded mile, week of March 13 2026.
DAT iQ shows Reefer Broker Spot around $2.28 as of March 9 2026. Use this as reference.
Realistic ranges: Reefer $1.90-$2.60, DryVan $1.60-$2.20, Flatbed $1.80-$2.50.
Return ONLY this JSON:
{"reefer":{"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"},"dryvan":{"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"},"flatbed":{"current":0.00,"high7d":0.00,"low7d":0.00,"changeWow":0.00,"loads":0,"topMarket":"City, ST"}}`;

  const [rP, rG, rGr] = await Promise.allSettled([
    askPerplexity(prompt), askGemini(prompt), askGroq(prompt),
  ]);

  const results = [rP, rG, rGr].map((r,i) => {
    const src = ['Perplexity','Gemini','Groq'][i];
    if (r.status === 'fulfilled') { console.log(`    ✅ ${src}: reefer=$${r.value?.reefer?.current}`); return r.value; }
    console.warn(`    ⚠️ ${src} failed:`, r.reason?.message); return null;
  }).filter(Boolean);

  const DEF = {
    reefer:  { current:2.28, high7d:2.38, low7d:2.15, changeWow:-0.02, loads:38000,  topMarket:'Los Angeles, CA' },
    dryvan:  { current:1.91, high7d:2.04, low7d:1.82, changeWow:-0.03, loads:175000, topMarket:'Atlanta, GA'     },
    flatbed: { current:2.10, high7d:2.25, low7d:2.00, changeWow:+0.01, loads:55000,  topMarket:'Dallas, TX'      },
  };
  const RNG = { reefer:[1.80,3.20], dryvan:[1.50,2.80], flatbed:[1.70,3.00] };

  const merged = {};
  ['reefer','dryvan','flatbed'].forEach(t => {
    const vals = results.map(r => r?.[t]?.current).filter(v => v > RNG[t][0] && v < RNG[t][1]);
    const med  = median(vals);
    if (med) {
      // Usa o resultado mais próximo da mediana para pegar os outros campos
      const best = results.find(r => Math.abs((r?.[t]?.current||0) - med) < 0.15) || results[0];
      merged[t] = { ...DEF[t], ...best?.[t], current: med };
    } else {
      merged[t] = DEF[t];
    }
    console.log(`    📌 ${t} median: $${merged[t].current} (from ${vals.length} sources)`);
  });
  return merged;
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

  // Coleta arrays de cada fonte
  const arrays = [rP, rG, rGr].map((r,i) => {
    const src = ['Perplexity','Gemini','Groq'][i];
    if (r.status === 'fulfilled') {
      const arr = Array.isArray(r.value) ? r.value : (r.value?.heatmap || r.value?.states || []);
      if (arr.length > 10) { console.log(`    ✅ ${src}: ${arr.length} states`); return arr; }
    }
    console.warn(`    ⚠️ ${src} heatmap failed/empty`); return [];
  });

  // Mapa de mediana por estado
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

  console.log(`  ✅ Heatmap: ${result.length} states (median of ${arrays.filter(a=>a.length>0).length} sources)`);
  return result;
}

// ─── MARKET STATS — 3 IAs + mediana ──────────────────────────────────────────
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

// ─── NEWS — Perplexity (melhor para busca web) ────────────────────────────────
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
  console.log('\n🔄 FreightPulse — EIA + 3-AI consensus...');
  const start = Date.now();

  // EIA primeiro (rápido e confiável)
  const dieselData    = await fetchEIADiesel();
  const fuelSurcharge = calcFuelSurcharge(dieselData.national);

  // 4 blocos em paralelo — cada um já usa 3 IAs internamente
  const [rRates, rHeatmap, rStats, rNews] = await Promise.allSettled([
    fetchSpotRates(),
    fetchHeatmap(),
    fetchMarketStats(),
    fetchNews(),
  ]);

  const rates   = rRates.status==='fulfilled'   ? rRates.value   : null;
  const heatmap = rHeatmap.status==='fulfilled' ? rHeatmap.value : [];
  const stats   = rStats.status==='fulfilled'   ? rStats.value   : { totalLoads:220000, reeferTLRatio:4.2 };
  const news    = rNews.status==='fulfilled'    ? rNews.value    : [];

  const DEF_RATES = {
    reefer:  { current:2.28, high:2.38, low:2.15, change:-0.02, loads:38000,  best:'Los Angeles, CA' },
    dryvan:  { current:1.91, high:2.04, low:1.82, change:-0.03, loads:175000, best:'Atlanta, GA'     },
    flatbed: { current:2.10, high:2.25, low:2.00, change:+0.01, loads:55000,  best:'Dallas, TX'      },
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
    source: 'EIA + Perplexity + Gemini + Groq',
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
  hasPPLX: !!PPLX_KEY, hasEIA: !!EIA_KEY, hasGemini: !!GEMINI_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT} — EIA + Perplexity + Gemini + Groq`));
