const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const PPLX_KEY = process.env.PPLX_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let cache = { data: null, ts: 0 };
const TTL = 5 * 60 * 1000;
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

// ─── PERPLEXITY ───────────────────────────────────────────────────────────────
async function pplx(prompt) {
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PPLX_KEY}` },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'You are a data API. Return ONLY raw JSON. No markdown. No backticks. No explanation. Just the JSON object.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 3000,
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  // Remove qualquer markdown que venha
  const clean = text.replace(/```json|```/gi, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in: ${clean.substring(0,100)}`);
  return JSON.parse(match[0]);
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ─── REEFER HEATMAP OFFSETS ───────────────────────────────────────────────────
const REEFER_OFF = {
  CA:+0.28,WA:+0.10,OR:+0.06,NV:-0.04,AZ:-0.02,ID:-0.14,MT:-0.20,WY:-0.20,UT:-0.10,CO:-0.06,
  ND:-0.26,SD:-0.26,NE:-0.20,KS:-0.16,OK:-0.08,NM:-0.12,TX:-0.06,
  MN:-0.12,IA:-0.16,MO:-0.12,WI:-0.06,IL:-0.02,IN:-0.06,MI:-0.02,OH:-0.02,KY:-0.06,
  TN:-0.06,AR:-0.12,LA:-0.06,MS:-0.12,AL:-0.06,GA:+0.04,FL:+0.08,SC:-0.02,NC:-0.02,
  VA:+0.00,WV:-0.12,PA:+0.04,NY:+0.14,NJ:+0.12,CT:+0.12,MA:+0.16,ME:+0.08,
  NH:+0.06,VT:+0.02,RI:+0.08,DE:+0.04,MD:+0.06,DC:+0.08,AK:+0.54,
};
const HEAT_ORDER = ['WA','OR','CA','NV','ID','MT','WY','UT','CO','AZ','ND','SD','NE','KS','OK','TX','NM','MN','IA','MO','WI','IL','IN','MI','OH','KY','TN','AR','LA','MS','AL','GA','FL','SC','NC','VA','WV','PA','NY','NJ','ME','NH','VT','MA','RI','CT','DE','MD','DC','AK'];

// ─── BUILD ────────────────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 Building...');
  const t0 = Date.now();

  // Roda tudo em paralelo
  const [rD, rR, rS, rN] = await Promise.allSettled([

    // 1. DIESEL
    pplx(`What is the current US national average diesel price today according to AAA GasPrices (gasprices.aaa.com)?
Return: {"diesel": 5.09}`),

    // 2. SPOT RATES
    pplx(`What are the current US national average truck spot rates per loaded mile this week according to DAT?
Search freightwaves.com or ajot.com for the latest DAT broker spot rates.
Return: {"reefer": {"rpm": 2.28, "high": 2.60, "low": 1.90, "wow": 0.05, "loads": 4500, "market": "Chicago, IL"}, "dryvan": {"rpm": 1.92, "high": 2.20, "low": 1.60, "wow": 0.08, "loads": 6200, "market": "Atlanta, GA"}, "flatbed": {"rpm": 2.15, "high": 2.50, "low": 1.80, "wow": 0.07, "loads": 2900, "market": "Dallas, TX"}}`),

    // 3. STATS
    pplx(`What is the current DAT reefer truck-to-load ratio and total loads posted on US loadboards today?
Return: {"tlRatio": 3.8, "totalLoads": 285000}`),

    // 4. NEWS
    pplx(`Find 4 real recent news headlines from FreightWaves about US trucking market this week.
Return: {"news": [{"headline": "text", "time": "2h ago", "url": "https://www.freightwaves.com/news/slug", "impact": "up"}]}`),

  ]);

  // Parse results
  const D = rD.status === 'fulfilled' ? rD.value : {};
  const R = rR.status === 'fulfilled' ? rR.value : {};
  const S = rS.status === 'fulfilled' ? rS.value : {};
  const N = rN.status === 'fulfilled' ? rN.value : {};

  console.log(`  D: ${JSON.stringify(D)}`);
  console.log(`  R: reefer=${R?.reefer?.rpm} dv=${R?.dryvan?.rpm} fb=${R?.flatbed?.rpm}`);
  console.log(`  S: tl=${S?.tlRatio} loads=${S?.totalLoads}`);
  console.log(`  N: ${N?.news?.length||0} articles`);
  if (rD.status === 'rejected') console.error('  ❌ Diesel:', rD.reason?.message);
  if (rR.status === 'rejected') console.error('  ❌ Rates:', rR.reason?.message);
  if (rS.status === 'rejected') console.error('  ❌ Stats:', rS.reason?.message);
  if (rN.status === 'rejected') console.error('  ❌ News:', rN.reason?.message);

  const diesel     = num(D?.diesel);
  const reeferRpm  = num(R?.reefer?.rpm);
  const dryvanRpm  = num(R?.dryvan?.rpm);
  const flatbedRpm = num(R?.flatbed?.rpm);
  const tlRatio    = num(S?.tlRatio);
  const totalLoads = num(S?.totalLoads);
  const news       = (N?.news || []).filter(n => n?.headline?.length > 10).slice(0,5).map((n,i) => ({...n, breaking: i===0}));

  const fuelSurcharge = diesel && diesel > 1.20 ? parseFloat(((diesel-1.20)/0.06).toFixed(1)) : null;

  const mkRate = (src, rpm) => ({
    current: rpm,
    high:    num(src?.high)   || null,
    low:     num(src?.low)    || null,
    change:  num(src?.wow)    ?? null,
    loads:   parseInt(src?.loads) || null,
    best:    src?.market      || '–',
  });

  console.log(`✅ Done ${((Date.now()-t0)/1000).toFixed(1)}s — diesel=$${diesel} reefer=$${reeferRpm}`);

  return {
    ok: true,
    diesel:  { national: diesel },
    rates: {
      reefer:  mkRate(R?.reefer,  reeferRpm),
      dryvan:  mkRate(R?.dryvan,  dryvanRpm),
      flatbed: mkRate(R?.flatbed, flatbedRpm),
    },
    heatmap: reeferRpm ? HEAT_ORDER.map(a => ({ abbr: a, rate: parseFloat((reeferRpm + (REEFER_OFF[a]||0)).toFixed(2)) })) : [],
    news,
    stats: { national: diesel, totalLoads, tlRatio, fuelSurcharge },
    ts: new Date().toISOString(),
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
const EMPTY = { ok:true, diesel:{national:null}, rates:{reefer:{current:null},dryvan:{current:null},flatbed:{current:null}}, heatmap:[], news:[], stats:{national:null,totalLoads:null,tlRatio:null,fuelSurcharge:null}, ts:'' };

app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });
  try {
    const d = await buildData();
    cache = { data: d, ts: Date.now() };
    res.json(d);
  } catch(e) {
    console.error('❌ /api/data:', e.message);
    res.json(cache.data || EMPTY);
  }
});

app.post('/api/refresh', async (req, res) => {
  console.log('🔁 REFRESH');
  cache = { data: null, ts: 0 };
  try {
    const d = await buildData();
    cache = { data: d, ts: Date.now() };
    res.json(d);
  } catch(e) {
    console.error('❌ /api/refresh:', e.message);
    res.json(EMPTY);
  }
});

app.post('/api/force-rates', async (req, res) => {
  cache = { data: null, ts: 0 };
  try {
    const d = await buildData();
    cache = { data: d, ts: Date.now() };
    res.json({ ok: true, rates: d.rates, ts: d.ts });
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
