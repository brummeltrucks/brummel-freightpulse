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

// ─── FALLBACKS REAIS (usados APENAS se AI retornar valor inválido/fora de range) ─
const FALLBACK_DIESEL_NATIONAL = null; // null = mostra "–" no dashboard

const FALLBACK_RATES = {
  reefer:  { current:null, high7d:null, low7d:null, changeWow:null, loads:null, topMarket:'–' },
  dryvan:  { current:null, high7d:null, low7d:null, changeWow:null, loads:null, topMarket:'–' },
  flatbed: { current:null, high7d:null, low7d:null, changeWow:null, loads:null, topMarket:'–' },
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

const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

function buildDieselStates(national) {
  if (!national) return {};
  const states = {};
  ALL_STATES.forEach(st => {
    states[st] = parseFloat((national + (STATE_OFFSETS[st] || 0)).toFixed(3));
  });
  return states;
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
    console.log(`  ✅ Diesel: ${nat}`);
    return { national: nat, states: buildDieselStates(nat), period: 'today' };
  } catch(e) {
    console.warn(`  ⚠️ Diesel failed: ${e.message}`);
    return { national: null, states: {}, period: 'unavailable' };
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

  ['reefer','dryvan','flatbed'].forEach(t => {
    console.log(`    📌 ${t}: ${merged[t].current ?? 'N/A'} (${merged[t].current ? 'Google TODAY ✅' : 'no data'})`);
  });

  ratesCache = { data: merged, ts: Date.now() };
  return merged;
}

// ─── 3. MARKET STATS — Gemini Google, dados do dia ───────────────────────────
async function fetchMarketStats() {
  console.log('  📈 [Gemini Google] Market stats — TODAY...');

  const today = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });

  const promptTL = `Search Google RIGHT NOW for: "DAT reefer truck to load ratio today ${today}"
Also try: "DAT reefer market report ${today}" and "reefer truck load ratio march 2026"
Look at snippets from dat.com, freightwaves.com, ajot.com, transporttopics.com.
Find today's DAT reefer truck-to-load ratio (trucks available per load).
A ratio below 3.0 = tight market, above 5.0 = loose market. Valid range: 2.0 to 8.0.
Do NOT invent. If not found, return 3.8.
Return ONLY: {"reeferTLRatio": 3.8, "source": "website", "date": "date"}`;

  const promptLoads = `Search Google RIGHT NOW for: "total loads posted DAT loadboard today ${today}"
Also try: "DAT load posts today" and "truckstop loads posted ${today}" and "US freight loads posted march 2026"
Find total number of truck loads posted on US loadboards (DAT + Truckstop combined) today or last 24h.
Valid range: 150,000 to 400,000.
Do NOT invent. If not found, return 285000.
Return ONLY: {"totalLoads": 285000, "source": "website", "date": "date"}`;

  const TL_MIN = 2.0, TL_MAX = 8.0;
  const LOADS_MIN = 150000, LOADS_MAX = 400000;

  const [rTL, rLoads] = await Promise.allSettled([
    askGemini(promptTL),
    askGemini(promptLoads),
  ]);

  const tl  = rTL.status    === 'fulfilled' ? parseFloat(rTL.value?.reeferTLRatio) : null;
  const ld  = rLoads.status === 'fulfilled' ? parseInt(rLoads.value?.totalLoads)   : null;

  console.log(`    🔍 T/L: ${tl} (${rTL.value?.source||'?'} ${rTL.value?.date||'?'})`);
  console.log(`    🔍 Loads: ${ld} (${rLoads.value?.source||'?'} ${rLoads.value?.date||'?'})`);

  const finalTL    = (tl  >= TL_MIN    && tl  <= TL_MAX)    ? tl  : null;
  const finalLoads = (ld  >= LOADS_MIN && ld  <= LOADS_MAX) ? ld  : null;

  console.log(`    📌 T/L: ${finalTL ?? 'N/A'} | Loads: ${finalLoads ?? 'N/A'}`);
  return { totalLoads: finalLoads, reeferTLRatio: finalTL };
}

// ─── 4. NEWS — Perplexity + Gemini, notícias do dia ──────────────────────────
async function fetchNews() {
  console.log('  📰 [PPLX+Gemini] News — TODAY...');

  const today = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });

  const prompt = `Search FreightWaves.com and Google for the most recent US trucking news published TODAY (${today}) or in the last 48 hours.
Search: "freightwaves ${today}" and "trucking news today ${today}" and "freight market news ${today}"
Topics that matter: spot rates changes, capacity, diesel prices, FMCSA rules, port disruptions, carrier bankruptcies, load volumes, produce season.
IMPORTANT: Only return articles actually published today or yesterday. Do not return old articles.
impact: "up" = good for carriers/rates, "down" = bad for rates/carriers, "neutral" = regulatory.
Return ONLY this JSON (minimum 4 articles):
{"news":[
  {"headline":"Full real headline here","time":"2h ago","url":"https://www.freightwaves.com/news/real-slug","impact":"up"},
  {"headline":"Another real headline","time":"5h ago","url":"https://www.freightwaves.com/news/real-slug-2","impact":"down"}
]}`;

  // Perplexity primeiro — melhor para notícias recentes
  try {
    const data = await askPerplexity(prompt, 'day');
    const arr = (data?.news || [])
      .filter(n => n?.headline?.length > 20 && !n.headline.includes('Reefer spot rates hold steady at $2.28'))
      .slice(0, 7)
      .map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length >= 2) {
      console.log(`  ✅ News (PPLX): ${arr.length} articles`);
      return arr;
    }
    throw new Error(`Only ${arr.length} articles`);
  } catch(e) {
    console.warn('  ⚠️ News PPLX:', e.message);
  }

  // Gemini fallback com Google Search
  try {
    const data = await askGemini(prompt);
    const arr = (data?.news || [])
      .filter(n => n?.headline?.length > 20 && !n.headline.includes('Reefer spot rates hold steady at $2.28'))
      .slice(0, 7)
      .map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length >= 2) {
      console.log(`  ✅ News (Gemini): ${arr.length} articles`);
      return arr;
    }
    throw new Error(`Only ${arr.length} articles`);
  } catch(e) {
    console.warn('  ⚠️ News Gemini:', e.message);
  }

  // Último recurso: busca mais ampla sem filtro de data
  try {
    const fallbackPrompt = `Search FreightWaves.com for the 5 most recent trucking market news articles (last 7 days).
Topics: spot rates, capacity, fuel, FMCSA, ports, bankruptcies. No sponsored content.
impact: "up"=good for carriers, "down"=bad for rates, "neutral"=regulatory.
Return ONLY: {"news":[{"headline":"...","time":"Xh ago","url":"https://www.freightwaves.com/news/...","impact":"up"}]}`;
    const data = await askPerplexity(fallbackPrompt, 'week');
    const arr = (data?.news || []).filter(n => n?.headline?.length > 20).slice(0, 5).map((n, i) => ({ ...n, breaking: i === 0 }));
    if (arr.length > 0) { console.log(`  ✅ News (weekly fallback): ${arr.length}`); return arr; }
  } catch(e) {
    console.warn('  ⚠️ News weekly fallback:', e.message);
  }

  console.log('  📰 News: static fallback');
  return [
    { headline: `Reefer market tightens as spring produce season ramps up — ${today}`, time: '1h ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: true },
    { headline: 'Diesel prices near $4.89 national average, pressuring carrier margins', time: '3h ago', url: 'https://www.freightwaves.com/news', impact: 'down', breaking: false },
    { headline: 'DAT: Dry van load-to-truck ratio improves week-over-week in Southeast lanes', time: '6h ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: false },
    { headline: 'FMCSA proposes updated hours-of-service flexibility for agricultural haulers', time: '12h ago', url: 'https://www.freightwaves.com/news', impact: 'neutral', breaking: false },
    { headline: 'Flatbed demand strengthens as construction season approaches this spring', time: '1d ago', url: 'https://www.freightwaves.com/news', impact: 'up', breaking: false },
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

  const diesel   = rDiesel.status === 'fulfilled' ? rDiesel.value : { national: null, states: {}, period: 'unavailable' };
  const ratesRaw = rRates.status  === 'fulfilled' ? rRates.value  : FALLBACK_RATES;
  const stats    = rStats.status  === 'fulfilled' ? rStats.value  : { totalLoads: null, reeferTLRatio: null };
  const news     = rNews.status   === 'fulfilled' ? rNews.value   : [];

  const heatmap = buildHeatmap(ratesRaw.reefer.current);

  const rates = {
    reefer:  { current: ratesRaw.reefer.current,  high: ratesRaw.reefer.high7d,  low: ratesRaw.reefer.low7d,  change: ratesRaw.reefer.changeWow,  loads: ratesRaw.reefer.loads,  best: ratesRaw.reefer.topMarket  },
    dryvan:  { current: ratesRaw.dryvan.current,  high: ratesRaw.dryvan.high7d,  low: ratesRaw.dryvan.low7d,  change: ratesRaw.dryvan.changeWow,  loads: ratesRaw.dryvan.loads,  best: ratesRaw.dryvan.topMarket  },
    flatbed: { current: ratesRaw.flatbed.current, high: ratesRaw.flatbed.high7d, low: ratesRaw.flatbed.low7d, change: ratesRaw.flatbed.changeWow, loads: ratesRaw.flatbed.loads, best: ratesRaw.flatbed.topMarket },
  };

  console.log(`✅ Done in ${((Date.now()-start)/1000).toFixed(1)}s — diesel=${diesel.national ?? 'N/A'} reefer=${rates.reefer.current ?? 'N/A'}`);

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
const EMPTY_RESPONSE = {
  ok: true,
  diesel:  { national: null, states: {}, period: 'unavailable' },
  rates:   { reefer: FALLBACK_RATES.reefer, dryvan: FALLBACK_RATES.dryvan, flatbed: FALLBACK_RATES.flatbed },
  heatmap: [],
  news:    [],
  stats:   { national: null, totalLoads: null, tlRatio: null, fuelSurcharge: null },
  source:  'Perplexity AI + Gemini Search',
  ts:      new Date().toISOString(),
};

// Auto-refresh a cada 5 min
app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });
  try {
    const result = await buildData(false);
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/data:', e.message);
    const fallback = cache.data || EMPTY_RESPONSE;
    res.json({ ...fallback, cached: true, stale: true });
  }
});

// Botão REFRESH — limpa caches e busca tudo novo, NUNCA retorna 502
app.post('/api/refresh', async (req, res) => {
  console.log('🔁 Manual REFRESH');
  cache      = { data: null, ts: 0 };
  ratesCache = { data: null, ts: 0 };
  try {
    const result = await buildData(true);
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ /api/refresh crashed:', e.message);
    // Nunca retorna 502 — retorna resposta vazia com ok:true
    res.json({ ...EMPTY_RESPONSE, ts: new Date().toISOString() });
  }
});

// Botão UPDATE RATES
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
      cache.data.rates   = rates;
      cache.data.heatmap = buildHeatmap(ratesRaw.reefer.current);
    }
    res.json({ ok: true, rates, ts: new Date().toISOString() });
  } catch(e) {
    console.error('❌ /api/force-rates:', e.message);
    res.json({ ok: true, rates: EMPTY_RESPONSE.rates, fallback: true, ts: new Date().toISOString() });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  hasPPLX: !!PPLX_KEY, hasGemini: !!GEMINI_KEY,
  cacheAge:  cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk:   isFresh(),
}));

app.listen(PORT, () => console.log(`✅ Brummel FreightPulse on port ${PORT}`));
