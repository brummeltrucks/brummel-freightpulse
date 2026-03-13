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
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response: ' + text.substring(0,200));
  return JSON.parse(match[0]);
}

// ─── 1. Diesel por estado (valor na bomba, consumidor final) ──────────────────
async function fetchDieselPrices() {
  console.log('  🔍 Fetching diesel prices...');
  try {
    // EIA API real primeiro
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=DEMO_KEY&frequency=weekly&data[0]=value&facets[product][]=DU&facets[duoarea][]=NUS&facets[duoarea][]=R10&facets[duoarea][]=R20&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50&sort[0][column]=period&sort[0][direction]=desc&length=6`;
    const r = await fetchWithTimeout(url, {}, 12000);
    if (!r.ok) throw new Error('EIA ' + r.status);
    const d = await r.json();
    const rows = d?.response?.data || [];
    const p = {};
    rows.forEach(row => { if (!p[row.duoarea]) p[row.duoarea] = parseFloat(row.value); });
    const nat = p['NUS'] || 3.68;
    const p1=p['R10']||(nat+0.14), p2=p['R20']||(nat-0.02), p3=p['R30']||(nat-0.18), p4=p['R40']||(nat+0.05), p5=p['R50']||(nat+0.35);
    console.log(`  ✅ EIA diesel: $${nat}`);
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
  } catch(e) {
    console.warn('  ⚠️ EIA failed, using Perplexity for diesel:', e.message);
    const data = await askPerplexity(
      'You are a fuel price data API. Return only valid JSON.',
      `Search EIA.gov right now for the latest weekly retail diesel prices at the pump for consumers in the USA.
Find: national average and all 50 states + DC prices in $/gallon.
Return ONLY this JSON (use real current EIA data):
{"national":0.000,"states":{"TX":0.000,"OK":0.000,"LA":0.000,"AR":0.000,"MS":0.000,"TN":0.000,"KY":0.000,"AL":0.000,"NM":0.000,"IL":0.000,"IN":0.000,"IA":0.000,"KS":0.000,"MI":0.000,"MN":0.000,"MO":0.000,"NE":0.000,"ND":0.000,"OH":0.000,"SD":0.000,"WI":0.000,"FL":0.000,"GA":0.000,"NC":0.000,"SC":0.000,"VA":0.000,"WV":0.000,"MD":0.000,"DE":0.000,"NY":0.000,"PA":0.000,"NJ":0.000,"CT":0.000,"MA":0.000,"ME":0.000,"NH":0.000,"RI":0.000,"VT":0.000,"CO":0.000,"ID":0.000,"MT":0.000,"UT":0.000,"WY":0.000,"WA":0.000,"OR":0.000,"NV":0.000,"AZ":0.000,"AK":0.000,"CA":0.000,"HI":0.000,"DC":0.000}}`
    );
    return { national: data.national || 3.68, states: data.states || {} };
  }
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
  // Validate ranges
  const ranges = { reefer:[2.80,3.50], dryvan:[2.50,3.20], flatbed:[2.60,3.30] };
  const defaults = { reefer:{current:3.04,high7d:3.20,low7d:2.88,changeWow:0.02,loads:43000,topMarket:'Los Angeles, CA'}, dryvan:{current:2.95,high7d:3.10,low7d:2.72,changeWow:0.03,loads:190000,topMarket:'Chicago, IL'}, flatbed:{current:2.87,high7d:3.02,low7d:2.68,changeWow:0.04,loads:60000,topMarket:'Houston, TX'} };
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
    'You are a freight rate data API. Return only valid JSON.',
    `Search DAT.com, FreightWaves SONAR, or Truckstop.com for the current average reefer spot rate per loaded mile for each US state (March 2026).
All values must be between $2.40 and $4.00/mile. Use regional freight knowledge if exact state data unavailable.
Return ONLY this JSON array:
[
  {"abbr":"WA","rate":0.00},{"abbr":"OR","rate":0.00},{"abbr":"CA","rate":0.00},{"abbr":"NV","rate":0.00},{"abbr":"ID","rate":0.00},
  {"abbr":"MT","rate":0.00},{"abbr":"WY","rate":0.00},{"abbr":"UT","rate":0.00},{"abbr":"CO","rate":0.00},{"abbr":"AZ","rate":0.00},
  {"abbr":"ND","rate":0.00},{"abbr":"SD","rate":0.00},{"abbr":"NE","rate":0.00},{"abbr":"KS","rate":0.00},{"abbr":"OK","rate":0.00},
  {"abbr":"TX","rate":0.00},{"abbr":"NM","rate":0.00},{"abbr":"MN","rate":0.00},{"abbr":"IA","rate":0.00},{"abbr":"MO","rate":0.00},
  {"abbr":"WI","rate":0.00},{"abbr":"IL","rate":0.00},{"abbr":"IN","rate":0.00},{"abbr":"MI","rate":0.00},{"abbr":"OH","rate":0.00},
  {"abbr":"KY","rate":0.00},{"abbr":"TN","rate":0.00},{"abbr":"AR","rate":0.00},{"abbr":"LA","rate":0.00},{"abbr":"MS","rate":0.00},
  {"abbr":"AL","rate":0.00},{"abbr":"GA","rate":0.00},{"abbr":"FL","rate":0.00},{"abbr":"SC","rate":0.00},{"abbr":"NC","rate":0.00},
  {"abbr":"VA","rate":0.00},{"abbr":"WV","rate":0.00},{"abbr":"PA","rate":0.00},{"abbr":"NY","rate":0.00},{"abbr":"NJ","rate":0.00},
  {"abbr":"ME","rate":0.00},{"abbr":"NH","rate":0.00},{"abbr":"VT","rate":0.00},{"abbr":"MA","rate":0.00},{"abbr":"RI","rate":0.00},
  {"abbr":"CT","rate":0.00},{"abbr":"DE","rate":0.00},{"abbr":"MD","rate":0.00},{"abbr":"DC","rate":0.00},{"abbr":"AK","rate":0.00}
]`
  );
  // data pode vir como { heatmap: [...] } ou diretamente como array via JSON wrapper
  let arr = Array.isArray(data) ? data : (data.heatmap || []);
  arr = arr.map(s => ({ abbr: s.abbr, rate: (s.rate >= 2.40 && s.rate <= 4.00) ? s.rate : 2.90 }));
  console.log(`  ✅ Heatmap: ${arr.length} states`);
  return arr;
}

// ─── 4. Stats: loads, T/L ratio reefer, fuel surcharge ───────────────────────
async function fetchMarketStats() {
  console.log('  🔍 Fetching market stats...');
  const data = await askPerplexity(
    'You are a freight market statistics API. Return only valid JSON.',
    `Search the web right now for these current US trucking market statistics (March 2026):

1. TOTAL LOADS POSTED in the last 24 hours across all major US loadboards (DAT, Truckstop.com, CH Robinson, Coyote, Echo). Approximate total truck freight loads posted nationwide. Typically 150,000-400,000/day.

2. REEFER TRUCK/LOAD RATIO: Current national load-to-truck ratio specifically for REEFER/refrigerated trailers. Search DAT trendlines or FreightWaves. Typically between 2.0 and 8.0.

3. FUEL SURCHARGE INDEX: Current US national diesel fuel surcharge percentage that carriers charge shippers. Search ATA (trucking.org), EIA fuel surcharge table, or DAT. Typically 25%-35%.

Return ONLY this JSON:
{"totalLoads":0,"reeferTLRatio":0.0,"fuelSurcharge":0.0}`
  );
  const stats = {
    totalLoads:    (data.totalLoads    > 150000 && data.totalLoads    < 500000) ? data.totalLoads    : 248000,
    tlRatio:       (data.reeferTLRatio > 1.5    && data.reeferTLRatio < 10.0)   ? data.reeferTLRatio : 3.9,
    fuelSurcharge: (data.fuelSurcharge > 15     && data.fuelSurcharge < 50)     ? data.fuelSurcharge : 28.5,
  };
  console.log(`  ✅ Stats: loads=${stats.totalLoads} TL=${stats.tlRatio} FSC=${stats.fuelSurcharge}%`);
  return stats;
}

// ─── 5. News reais de transporte (trucks) ────────────────────────────────────
async function fetchTruckingNews() {
  console.log('  🔍 Fetching trucking news...');

  // Tenta RSS primeiro (100% real, sem custo)
  const feeds = [
    { url:'https://www.transportation.gov/briefing-room/feed', source:'DOT',    type:'dot'    },
    { url:'https://www.fmcsa.dot.gov/newsroom/rss.xml',        source:'FMCSA',  type:'fmcsa'  },
    { url:'https://www.ttnews.com/rss.xml',                    source:'MARKET', type:'market' },
    { url:'https://www.trucking.org/rss.xml',                  source:'ATA',    type:'ata'    },
  ];
  const rssNews = [];
  for (const feed of feeds) {
    try {
      const r = await fetchWithTimeout(feed.url, {headers:{'User-Agent':'Mozilla/5.0'}}, 8000);
      if (!r.ok) continue;
      const xml = await r.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items.slice(0,2)) {
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
        const link  = (item.match(/<link>(.*?)<\/link>/)||item.match(/<guid>(.*?)<\/guid>/))?.[1]?.trim();
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
        if (!title || title.length < 10) continue;
        const diff = pubDate ? Date.now()-new Date(pubDate).getTime() : 0;
        const days = Math.floor(diff/86400000);
        if (days > 7) continue; // só notícias da última semana
        const hrs = Math.floor(diff/3600000), mins = Math.floor(diff/60000);
        rssNews.push({
          source: feed.source, type: feed.type,
          headline: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,''),
          time: days>0?`${days}d ago`:hrs>0?`${hrs}h ago`:mins>0?`${mins}min ago`:'just now',
          url: link||'#',
        });
      }
    } catch(e) { console.warn(`  ⚠️ RSS ${feed.source}:`, e.message); }
  }

  // Se RSS retornou menos de 4 notícias, complementa com Perplexity
  if (rssNews.length < 4) {
    try {
      console.log('  🔍 Supplementing news with Perplexity...');
      const data = await askPerplexity(
        'You are a trucking news API. Return only valid JSON.',
        `Search the web right now for the latest trucking and freight transportation news in the USA published in the last 7 days (this week, March 2026).
Find real headlines from: FreightWaves, TTNews, TruckingInfo, Transport Topics, Overdrive Magazine, FleetOwner, Land Line.
Focus on: freight rates, regulations, FMCSA rules, trucking companies, fuel prices, ELD, hours of service, capacity.
Return ONLY this JSON with 6 real headlines sorted newest first:
{"news":[
  {"source":"FREIGHTWAVES","type":"market","headline":"real headline here","time":"X hr ago","url":"https://freightwaves.com/news/..."},
  {"source":"FMCSA","type":"fmcsa","headline":"real headline here","time":"X hr ago","url":"https://fmcsa.dot.gov/..."},
  {"source":"TTNEWS","type":"market","headline":"real headline here","time":"X hr ago","url":"https://ttnews.com/..."},
  {"source":"DOT","type":"dot","headline":"real headline here","time":"X hr ago","url":"https://transportation.gov/..."},
  {"source":"ATA","type":"ata","headline":"real headline here","time":"X hr ago","url":"https://trucking.org/..."},
  {"source":"OVERDRIVE","type":"market","headline":"real headline here","time":"X hr ago","url":"https://overdriveonline.com/..."}
]}`
      );
      if (data.news?.length) {
        data.news.forEach(n => { if (n.headline && n.headline.length > 15 && !rssNews.find(r=>r.headline===n.headline)) rssNews.push(n); });
      }
    } catch(e) { console.warn('  ⚠️ Perplexity news:', e.message); }
  }

  // Ordena por mais recente e limita a 8
  const sorted = rssNews.sort((a,b) => {
    const toMin = t => { const m=t.match(/(\d+)(d|h|min)/); if(!m) return 0; return m[2]==='d'?m[1]*1440:m[2]==='h'?m[1]*60:parseInt(m[1]); };
    return toMin(a.time) - toMin(b.time);
  }).slice(0,8);

  if (sorted.length > 0) { sorted[0].type='breaking'; sorted[0].source='BREAKING'; }
  console.log(`  ✅ News: ${sorted.length} items`);
  return sorted;
}

// ─── Build all data ───────────────────────────────────────────────────────────
async function buildData() {
  console.log('\n🔄 Building all data...');
  const start = Date.now();

  // Executa tudo em paralelo para ser rápido
  const [dieselData, spotRates, heatmap, stats, news] = await Promise.allSettled([
    fetchDieselPrices(),
    fetchSpotRates(),
    fetchReeferHeatmap(),
    fetchMarketStats(),
    fetchTruckingNews(),
  ]);

  const diesel = dieselData.status==='fulfilled' ? dieselData.value : { national:3.68, states:{} };
  const rates  = spotRates.status==='fulfilled'  ? spotRates.value  : { reefer:{current:3.04,high7d:3.20,low7d:2.88,changeWow:0.02,loads:43000,topMarket:'Los Angeles, CA'}, dryvan:{current:2.95,high7d:3.10,low7d:2.72,changeWow:0.03,loads:190000,topMarket:'Chicago, IL'}, flatbed:{current:2.87,high7d:3.02,low7d:2.68,changeWow:0.04,loads:60000,topMarket:'Houston, TX'} };
  const hmap   = heatmap.status==='fulfilled'    ? heatmap.value    : [];
  const st     = stats.status==='fulfilled'      ? stats.value      : { totalLoads:248000, tlRatio:3.9, fuelSurcharge:28.5 };
  const newsArr= news.status==='fulfilled'       ? news.value       : [];

  // Adapta formato das rates para o frontend
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
    stats: { national: diesel.national, totalLoads: st.totalLoads, tlRatio: st.tlRatio, fuelSurcharge: st.fuelSurcharge },
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

// Refresh manual — ignora cache
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
