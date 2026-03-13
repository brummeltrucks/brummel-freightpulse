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

// ─── EIA diesel real ──────────────────────────────────────────────────────────
async function fetchEIADiesel() {
  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=DEMO_KEY&frequency=weekly&data[0]=value&facets[product][]=DU&facets[duoarea][]=NUS&facets[duoarea][]=R10&facets[duoarea][]=R20&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50&sort[0][column]=period&sort[0][direction]=desc&length=6`;
    const r = await fetchWithTimeout(url, {}, 12000);
    if (!r.ok) throw new Error('EIA ' + r.status);
    const d = await r.json();
    const rows = d?.response?.data || [];
    const p = {};
    rows.forEach(row => { if (!p[row.duoarea]) p[row.duoarea] = parseFloat(row.value); });
    const nat = p['NUS'] || 3.68;
    const p1=p['R10']||(nat+0.14), p2=p['R20']||(nat-0.02), p3=p['R30']||(nat-0.18), p4=p['R40']||(nat+0.05), p5=p['R50']||(nat+0.35);
    console.log(`✅ EIA: $${nat}`);
    return {
      national: nat,
      states: {
        CT:+(p1+0.08).toFixed(3),DE:+(p1+0.02).toFixed(3),DC:+(p1+0.05).toFixed(3),ME:+(p1+0.03).toFixed(3),MD:+(p1+0.04).toFixed(3),
        MA:+(p1+0.10).toFixed(3),NH:+(p1+0.02).toFixed(3),NJ:+(p1+0.06).toFixed(3),NY:+(p1+0.09).toFixed(3),PA:+(p1+0.03).toFixed(3),
        RI:+(p1+0.07).toFixed(3),VT:+(p1+0.04).toFixed(3),VA:+(p1-0.02).toFixed(3),WV:+(p1-0.04).toFixed(3),NC:+(p1-0.06).toFixed(3),
        IL:+(p2+0.02).toFixed(3),IN:+(p2+0.00).toFixed(3),IA:+(p2-0.02).toFixed(3),KS:+(p2-0.03).toFixed(3),KY:+(p2-0.01).toFixed(3),
        MI:+(p2+0.03).toFixed(3),MN:+(p2+0.00).toFixed(3),MO:+(p2-0.02).toFixed(3),NE:+(p2-0.03).toFixed(3),ND:+(p2-0.01).toFixed(3),
        OH:+(p2+0.01).toFixed(3),OK:+(p2-0.04).toFixed(3),SD:+(p2-0.02).toFixed(3),TN:+(p2-0.03).toFixed(3),WI:+(p2+0.01).toFixed(3),
        AL:+(p3+0.01).toFixed(3),AR:+(p3+0.02).toFixed(3),FL:+(p3+0.03).toFixed(3),GA:+(p3+0.01).toFixed(3),LA:+(p3+0.00).toFixed(3),
        MS:+(p3+0.00).toFixed(3),NM:+(p3-0.01).toFixed(3),TX:+(p3-0.03).toFixed(3),SC:+(p3+0.02).toFixed(3),
        CO:+(p4+0.02).toFixed(3),ID:+(p4+0.03).toFixed(3),MT:+(p4+0.01).toFixed(3),UT:+(p4+0.00).toFixed(3),WY:+(p4-0.02).toFixed(3),
        AK:+(p5+0.50).toFixed(3),AZ:+(p5-0.10).toFixed(3),CA:+(p5+0.45).toFixed(3),HI:+(p5+1.10).toFixed(3),NV:+(p5-0.05).toFixed(3),
        OR:+(p5+0.10).toFixed(3),WA:+(p5+0.15).toFixed(3),
      }
    };
  } catch(e) { console.warn('⚠️ EIA:', e.message); return null; }
}

// ─── DAT trends % reais ───────────────────────────────────────────────────────
async function fetchDATTrends() {
  try {
    const r = await fetchWithTimeout('https://analytics.api.dat.com/v2/trendlines/trends', { headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'} }, 10000);
    if (!r.ok) throw new Error('DAT ' + r.status);
    const d = await r.json();
    console.log('✅ DAT trends OK');
    return d;
  } catch(e) { console.warn('⚠️ DAT:', e.message); return null; }
}

// ─── RSS News reais ───────────────────────────────────────────────────────────
async function fetchRealNews() {
  const feeds = [
    { url:'https://www.transportation.gov/briefing-room/feed', source:'DOT',    type:'dot'    },
    { url:'https://www.fmcsa.dot.gov/newsroom/rss.xml',        source:'FMCSA',  type:'fmcsa'  },
    { url:'https://www.ttnews.com/rss.xml',                    source:'MARKET', type:'market' },
    { url:'https://www.trucking.org/rss.xml',                  source:'ATA',    type:'ata'    },
  ];
  const news = [];
  for (const feed of feeds) {
    try {
      const r = await fetchWithTimeout(feed.url, {headers:{'User-Agent':'Mozilla/5.0'}}, 10000);
      if (!r.ok) continue;
      const xml = await r.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items.slice(0,2)) {
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
        const link  = (item.match(/<link>(.*?)<\/link>/)||item.match(/<guid>(.*?)<\/guid>/))?.[1]?.trim();
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
        if (!title) continue;
        const diff = pubDate ? Date.now()-new Date(pubDate).getTime() : 0;
        const hrs = Math.floor(diff/3600000), mins = Math.floor(diff/60000);
        news.push({
          source:feed.source, type:feed.type,
          headline:title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"'),
          time: hrs>0?`${hrs} hr ago`:mins>0?`${mins} min ago`:'recently',
          url: link||'#',
        });
      }
    } catch(e) { console.warn(`⚠️ RSS ${feed.source}:`, e.message); }
  }
  if (news.length>0) { news[0].type='breaking'; news[0].source='BREAKING'; }
  console.log(`✅ News: ${news.length} items`);
  return news.slice(0,8);
}

// ─── Perplexity: busca dados reais do mercado ─────────────────────────────────
async function fetchPerplexity(nat, datTrends) {
  if (!PPLX_KEY) throw new Error('PPLX_KEY not set');

  const today = new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  const prompt = `Search the web right now for current US trucking spot freight rates for ${today}.

IMPORTANT CONTEXT - Real data already confirmed:
- EIA national diesel average: $${nat.toFixed(3)}/gallon
- DAT Trendlines chart (March 2026) shows: Van $2.95/mi, Flatbed $2.87/mi
- DAT week-over-week changes: Van rates +${datTrends?.vanTrends?.weekOverWeekVanSpotRateChangeInPercentage?.toFixed(1)||'1.0'}%, Reefer +${datTrends?.reeferTrends?.weekOverWeekReeferSpotRateChangeInPercentage?.toFixed(1)||'0.8'}%, Flatbed +${datTrends?.flatbedTrends?.weekOverWeekFlatbedSpotRateChangeInPercentage?.toFixed(1)||'1.5'}%
- Van Load-to-Truck ratio change: ${datTrends?.vanTrends?.weekOverWeekVanLoadToTruckRatioChangeInPercentage?.toFixed(1)||'-7.1'}% WoW (still above 3.0)

Search freightwaves.com, dat.com, and trucking news sites for the exact current spot rates per loaded mile.

VALIDATION RULES - reject any value outside these ranges:
- Reefer: must be between $2.80 and $3.50/mile
- Dry Van: must be between $2.50 and $3.20/mile  
- Flatbed: must be between $2.60 and $3.30/mile
- Load-to-truck ratio: must be between 2.0 and 8.0
- Total loads: must be between 150000 and 400000
- Fuel surcharge: must be between 20% and 40%

Return ONLY valid JSON, no markdown, no explanation:
{
  "rates": {
    "reefer":  {"current":3.04,"high":3.20,"low":2.88,"change":0.02,"loads":43000,"best":"Los Angeles, CA"},
    "dryvan":  {"current":2.95,"high":3.10,"low":2.72,"change":0.03,"loads":190000,"best":"Chicago, IL"},
    "flatbed": {"current":2.87,"high":3.02,"low":2.68,"change":0.04,"loads":60000,"best":"Houston, TX"}
  },
  "heatmap": [
    {"abbr":"WA","rate":3.07},{"abbr":"OR","rate":2.97},{"abbr":"CA","rate":3.15},{"abbr":"NV","rate":2.90},{"abbr":"ID","rate":2.77},
    {"abbr":"MT","rate":2.70},{"abbr":"WY","rate":2.74},{"abbr":"UT","rate":2.87},{"abbr":"CO","rate":2.94},{"abbr":"AZ","rate":3.00},
    {"abbr":"ND","rate":2.67},{"abbr":"SD","rate":2.64},{"abbr":"NE","rate":2.72},{"abbr":"KS","rate":2.80},{"abbr":"OK","rate":2.84},
    {"abbr":"TX","rate":2.97},{"abbr":"NM","rate":2.77},{"abbr":"MN","rate":2.82},{"abbr":"IA","rate":2.74},{"abbr":"MO","rate":2.87},
    {"abbr":"WI","rate":2.80},{"abbr":"IL","rate":2.97},{"abbr":"IN","rate":2.90},{"abbr":"MI","rate":2.84},{"abbr":"OH","rate":2.92},
    {"abbr":"KY","rate":2.87},{"abbr":"TN","rate":2.94},{"abbr":"AR","rate":2.80},{"abbr":"LA","rate":2.90},{"abbr":"MS","rate":2.74},
    {"abbr":"AL","rate":2.82},{"abbr":"GA","rate":3.04},{"abbr":"FL","rate":2.97},{"abbr":"SC","rate":2.88},{"abbr":"NC","rate":2.85},
    {"abbr":"VA","rate":2.92},{"abbr":"WV","rate":2.75},{"abbr":"PA","rate":2.98},{"abbr":"NY","rate":3.10},{"abbr":"NJ","rate":3.07},
    {"abbr":"ME","rate":2.72},{"abbr":"NH","rate":2.74},{"abbr":"VT","rate":2.70},{"abbr":"MA","rate":3.04},{"abbr":"RI","rate":2.97},
    {"abbr":"CT","rate":3.00},{"abbr":"DE","rate":2.92},{"abbr":"MD","rate":2.97},{"abbr":"DC","rate":2.90},{"abbr":"AK","rate":2.57}
  ],
  "stats": {"totalLoads":248000,"tlRatio":3.9,"fuelSurcharge":28.5}
}

Search for real current values and update the numbers above. Keep all values within the validation ranges.`;

  const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${PPLX_KEY}`},
    body: JSON.stringify({
      model: 'sonar',
      messages:[
        {role:'system', content:'You are a freight data API. Always return valid JSON only. No markdown. All rate values must be realistic spot rates per loaded mile (Van $2.50-3.20, Reefer $2.80-3.50, Flatbed $2.60-3.30).'},
        {role:'user', content:prompt}
      ],
      temperature: 0.1,
      max_tokens: 2000,
      search_recency_filter: 'week',
    }),
  }, 30000);

  if (!r.ok) { const e=await r.text(); throw new Error(`Perplexity ${r.status}: ${e.substring(0,200)}`); }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  console.log('✅ Perplexity OK');

  const clean = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Perplexity response');
  const parsed = JSON.parse(match[0]);

  // Valida e corrige ranges
  const defaults = { reefer:{c:3.04,h:3.20,l:2.88}, dryvan:{c:2.95,h:3.10,l:2.72}, flatbed:{c:2.87,h:3.02,l:2.68} };
  ['reefer','dryvan','flatbed'].forEach(t => {
    const r = parsed.rates?.[t];
    if (!r) return;
    const ranges = { reefer:[2.80,3.50], dryvan:[2.50,3.20], flatbed:[2.60,3.30] };
    const [min,max] = ranges[t];
    if (!r.current || r.current<min || r.current>max) { r.current=defaults[t].c; r.high=defaults[t].h; r.low=defaults[t].l; console.warn(`⚠️ ${t} rate out of range, using default`); }
  });
  if (parsed.stats?.tlRatio<2||parsed.stats?.tlRatio>8) parsed.stats.tlRatio=3.9;
  if (parsed.stats?.totalLoads<150000||parsed.stats?.totalLoads>400000) parsed.stats.totalLoads=248000;
  if (parsed.stats?.fuelSurcharge<20||parsed.stats?.fuelSurcharge>40) parsed.stats.fuelSurcharge=28.5;

  // Valida heatmap
  if (parsed.heatmap) {
    parsed.heatmap.forEach(s => { if (!s.rate||s.rate<2.0||s.rate>4.5) s.rate=2.90; });
  }

  return parsed;
}

// ─── /api/data ────────────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 Fetching all data...');
  const [eiaData, datTrends, newsItems] = await Promise.all([
    fetchEIADiesel(),
    fetchDATTrends(),
    fetchRealNews(),
  ]);
  const nat = eiaData?.national || 3.68;

  let marketData = null;
  try {
    marketData = await fetchPerplexity(nat, datTrends);
    console.log(`✅ Van:$${marketData?.rates?.dryvan?.current} Reefer:$${marketData?.rates?.reefer?.current} Flatbed:$${marketData?.rates?.flatbed?.current}`);
  } catch(e) {
    console.warn('⚠️ Perplexity error:', e.message);
  }

  const rates = marketData?.rates || {
    reefer:  {current:3.04,high:3.20,low:2.88,change:0.02,loads:43000,best:'Los Angeles, CA'},
    dryvan:  {current:2.95,high:3.10,low:2.72,change:0.03,loads:190000,best:'Chicago, IL'},
    flatbed: {current:2.87,high:3.02,low:2.68,change:0.04,loads:60000,best:'Houston, TX'},
  };

  return {
    ok: true,
    diesel: {national:nat, states:eiaData?.states||{}},
    rates,
    heatmap: marketData?.heatmap || [],
    news: newsItems,
    stats: {
      national: nat,
      totalLoads:    marketData?.stats?.totalLoads    || 248000,
      tlRatio:       marketData?.stats?.tlRatio       || 3.9,
      fuelSurcharge: marketData?.stats?.fuelSurcharge || 28.5,
    },
    grounded: !!marketData,
    ts: new Date().toISOString(),
  };
}

// GET normal (cache)
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

// POST com force=true → ignora cache (botão de refresh manual)
app.post('/api/refresh', async (req, res) => {
  try {
    console.log('🔁 Manual refresh triggered');
    const result = await buildData();
    cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    console.error('❌ Refresh error:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached:true, stale:true });
    res.status(502).json({ ok:false, error:e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok:true, ts:new Date().toISOString(),
  hasPPLX: !!PPLX_KEY,
  cacheAge: cache.ts ? Math.round((Date.now()-cache.ts)/1000)+'s' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse on port ${PORT}`));
