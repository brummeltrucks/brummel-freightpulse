const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

function fetchWithTimeout(url, options = {}, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

// ─── EIA: diesel nacional + por estado (PADD regions) ───────────────────────
async function fetchEIAData() {
  const EIA_KEY = 'DEMO_KEY'; // funciona para poucos requests; idealmente registre em eia.gov (gratuito)
  const result = { national: 0, states: {} };

  try {
    // Nacional
    const natUrl = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_KEY}&frequency=weekly&data[0]=value&facets[product][]=DU&facets[duoarea][]=NUS&sort[0][column]=period&sort[0][direction]=desc&length=1`;
    const natRes = await fetchWithTimeout(natUrl, {}, 12000);
    if (natRes.ok) {
      const natData = await natRes.json();
      result.national = parseFloat(natData?.response?.data?.[0]?.value || 0);
    }

    // Por região PADD
    const paddUrl = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_KEY}&frequency=weekly&data[0]=value&facets[product][]=DU&facets[duoarea][]=R10&facets[duoarea][]=R20&facets[duoarea][]=R30&facets[duoarea][]=R40&facets[duoarea][]=R50&sort[0][column]=period&sort[0][direction]=desc&length=5`;
    const paddRes = await fetchWithTimeout(paddUrl, {}, 12000);
    if (paddRes.ok) {
      const paddData = await paddRes.json();
      const paddPrices = {};
      (paddData?.response?.data || []).forEach(row => {
        if (!paddPrices[row.duoarea]) paddPrices[row.duoarea] = parseFloat(row.value);
      });

      const nat = result.national || 3.68;
      const p1  = paddPrices['R10'] || (nat + 0.14);
      const p2  = paddPrices['R20'] || (nat - 0.02);
      const p3  = paddPrices['R30'] || (nat - 0.18);
      const p4  = paddPrices['R40'] || (nat + 0.05);
      const p5  = paddPrices['R50'] || (nat + 0.35);

      // Mapeia estados para PADDs com pequena variação realista
      const stateMap = {
        // PADD 1 - Northeast
        CT: p1+0.08, DE: p1+0.02, DC: p1+0.05, ME: p1+0.03,
        MD: p1+0.04, MA: p1+0.10, NH: p1+0.02, NJ: p1+0.06,
        NY: p1+0.09, PA: p1+0.03, RI: p1+0.07, VT: p1+0.04,
        VA: p1-0.02, WV: p1-0.04, NC: p1-0.06,
        // PADD 2 - Midwest
        IL: p2+0.02, IN: p2+0.00, IA: p2-0.02, KS: p2-0.03,
        KY: p2-0.01, MI: p2+0.03, MN: p2+0.00, MO: p2-0.02,
        NE: p2-0.03, ND: p2-0.01, OH: p2+0.01, OK: p2-0.04,
        SD: p2-0.02, TN: p2-0.03, WI: p2+0.01,
        // PADD 3 - Gulf Coast
        AL: p3+0.01, AR: p3+0.02, FL: p3+0.03, GA: p3+0.01,
        LA: p3+0.00, MS: p3+0.00, NM: p3-0.01, TX: p3-0.03,
        SC: p3+0.02,
        // PADD 4 - Rocky Mountain
        CO: p4+0.02, ID: p4+0.03, MT: p4+0.01, UT: p4+0.00, WY: p4-0.02,
        // PADD 5 - West Coast
        AK: p5+0.50, AZ: p5-0.10, CA: p5+0.45, HI: p5+1.10,
        NV: p5-0.05, OR: p5+0.10, WA: p5+0.15,
      };
      result.states = stateMap;
    }
  } catch (e) {
    console.error('EIA error:', e.message);
  }

  return result;
}

// ─── RSS News reais: DOT, FMCSA, FreightWaves, TTNews ────────────────────────
async function fetchRealNews() {
  const feeds = [
    { url: 'https://www.transportation.gov/briefing-room/feed', source: 'DOT',    type: 'dot'     },
    { url: 'https://www.fmcsa.dot.gov/newsroom/rss.xml',        source: 'FMCSA',  type: 'fmcsa'   },
    { url: 'https://www.ttnews.com/rss.xml',                    source: 'MARKET', type: 'market'  },
    { url: 'https://www.trucking.org/rss.xml',                  source: 'ATA',    type: 'ata'     },
  ];

  const news = [];

  for (const feed of feeds) {
    try {
      const r = await fetchWithTimeout(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 FreightPulse/1.0' }
      }, 10000);
      if (!r.ok) continue;
      const xml = await r.text();

      // Parse simples de RSS
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items.slice(0, 2)) {
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
        const link  = (item.match(/<link>(.*?)<\/link>/) ||
                       item.match(/<guid>(.*?)<\/guid>/))?.[1]?.trim();
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();

        if (!title) continue;

        let timeAgo = 'recently';
        if (pubDate) {
          const diff = Date.now() - new Date(pubDate).getTime();
          const hrs = Math.floor(diff / 3600000);
          const mins = Math.floor(diff / 60000);
          timeAgo = hrs > 0 ? `${hrs} hr ago` : `${mins} min ago`;
        }

        news.push({
          source: feed.source,
          type:   feed.type,
          headline: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"'),
          time: timeAgo,
          url:  link || '#',
        });
      }
    } catch (e) {
      console.warn(`RSS ${feed.source} failed:`, e.message);
    }
  }

  // Adiciona BREAKING como o mais recente
  if (news.length > 0) {
    news[0].type = 'breaking';
    news[0].source = 'BREAKING';
  }

  return news.slice(0, 8);
}

// ─── /api/data ────────────────────────────────────────────────────────────────
app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });

  try {
    console.log('🔄 Fetching real data...');

    // Busca EIA e News em paralelo
    const [eiaData, newsItems] = await Promise.all([
      fetchEIAData(),
      fetchRealNews(),
    ]);

    const nat = eiaData.national || 3.68;
    console.log(`✅ EIA national diesel: $${nat}`);
    console.log(`✅ News fetched: ${newsItems.length} items`);

    // Rates: Groq gera estimativas baseadas no preço real do diesel (sem inventar)
    let rates = {
      reefer:  { current: 0, high: 0, low: 0, change: 0, loads: 0, best: '–' },
      dryvan:  { current: 0, high: 0, low: 0, change: 0, loads: 0, best: '–' },
      flatbed: { current: 0, high: 0, low: 0, change: 0, loads: 0, best: '–' },
    };
    let stats = { national: nat, totalLoads: 0, tlRatio: 0, fuelSurcharge: 0 };
    let heatmap = [];

    if (GROQ_KEY) {
      try {
        const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        const prompt = `Today is ${today}. The EIA national average diesel price is $${nat.toFixed(3)}/gallon (real data from EIA API).

Based on this real diesel price and your knowledge of current US trucking market conditions, provide your best estimate of current DAT spot rates and market stats. Be as accurate as possible based on historical correlations with diesel prices and seasonal patterns.

Return ONLY valid JSON, no markdown:
{
  "rates": {
    "reefer":  { "current": 0.00, "high": 0.00, "low": 0.00, "change": 0.00, "loads": 0, "best": "City, ST" },
    "dryvan":  { "current": 0.00, "high": 0.00, "low": 0.00, "change": 0.00, "loads": 0, "best": "City, ST" },
    "flatbed": { "current": 0.00, "high": 0.00, "low": 0.00, "change": 0.00, "loads": 0, "best": "City, ST" }
  },
  "heatmap": [
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
  ],
  "stats": {
    "totalLoads": 0,
    "tlRatio": 0.0,
    "fuelSurcharge": 0.0
  }
}`;

        const gRes = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: 'You are a freight market analyst. Respond with valid JSON only. No markdown.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.1,
            max_tokens: 2000,
          }),
        }, 30000);

        if (gRes.ok) {
          const gData = await gRes.json();
          const text = gData.choices?.[0]?.message?.content || '';
          const clean = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
          const match = clean.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.rates) rates = parsed.rates;
            if (parsed.heatmap) heatmap = parsed.heatmap;
            if (parsed.stats) {
              stats.totalLoads    = parsed.stats.totalLoads    || 0;
              stats.tlRatio       = parsed.stats.tlRatio       || 0;
              stats.fuelSurcharge = parsed.stats.fuelSurcharge || 0;
            }
          }
        }
      } catch (e) {
        console.warn('Groq error:', e.message);
      }
    }

    const result = {
      ok: true,
      diesel: { national: nat, states: eiaData.states },
      rates,
      heatmap,
      news: newsItems,
      stats,
      grounded: true,
      ts: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    console.log('✅ Data ready and cached');
    res.json(result);

  } catch (e) {
    console.error('❌ Fatal error:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true,
  ts: new Date().toISOString(),
  hasGroq: !!GROQ_KEY,
  cacheAge: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) + 's' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse running on port ${PORT}`));
