const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache 10 minutos
const TTL = 10 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

// Fetch com timeout manual (node-fetch v2 não suporta AbortController nativamente)
function fetchWithTimeout(url, options, ms = 55000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timeout')), ms);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });

  if (!GEMINI_KEY) {
    return res.status(500).json({ ok: false, error: 'GEMINI_KEY not configured' });
  }

  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const prompt = `Today is ${today}.

Search the web and return ONLY a raw JSON object. No markdown, no backticks, no explanation — just valid JSON.

Find current data from:
- EIA (eia.gov) for diesel prices
- DAT Freight & Analytics (dat.com) for spot rates
- FreightWaves (freightwaves.com) for market data
- FMCSA, DOT, ATA, TTNews for news headlines

Rules:
- diesel.national = EIA weekly on-highway diesel national average ($/gallon)
- diesel.states = approximate prices for all 50 states + DC based on PADD regions (small +-$0.05 variation)
- rates = DAT national spot rates per loaded mile (all-in, excluding fuel surcharge)
- stats.tlRatio = DAT dry van load-to-truck ratio (typically 2.0-6.0)
- stats.totalLoads = loads posted last 24h on DAT (typically 100000-500000)
- stats.fuelSurcharge = current fuel surcharge % (typically 20-35)
- heatmap = reefer RPM per state (typically $2.50-$3.80)
- news = real recent headlines with real URLs
- All numbers as plain floats. Use realistic estimates if exact data unavailable. Never use 0.

Return exactly this structure:
{
  "diesel": {
    "national": 3.650,
    "states": {
      "TX": 3.45, "OK": 3.48, "LA": 3.50, "AR": 3.52, "MS": 3.53,
      "TN": 3.54, "KY": 3.58, "AL": 3.51, "NM": 3.49,
      "IL": 3.62, "IN": 3.60, "IA": 3.58, "KS": 3.55, "MI": 3.65,
      "MN": 3.60, "MO": 3.57, "NE": 3.56, "ND": 3.59, "OH": 3.63,
      "SD": 3.58, "WI": 3.61,
      "FL": 3.55, "GA": 3.53, "NC": 3.57, "SC": 3.55, "VA": 3.62,
      "WV": 3.65, "MD": 3.70, "DE": 3.72,
      "NY": 3.85, "PA": 3.78, "NJ": 3.80,
      "CT": 3.88, "MA": 3.90, "ME": 3.82, "NH": 3.80, "RI": 3.85, "VT": 3.83,
      "CO": 3.65, "ID": 3.70, "MT": 3.68, "UT": 3.67, "WY": 3.63,
      "WA": 3.95, "OR": 3.90, "NV": 3.85, "AZ": 3.72, "AK": 4.20,
      "CA": 4.50, "HI": 4.80, "DC": 3.75
    }
  },
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
  "news": [
    {"source":"BREAKING","type":"breaking","headline":"real headline here","time":"2 min ago","url":"https://freightwaves.com"},
    {"source":"FMCSA","type":"fmcsa","headline":"real headline here","time":"1 hr ago","url":"https://fmcsa.dot.gov"},
    {"source":"DOT","type":"dot","headline":"real headline here","time":"3 hr ago","url":"https://transportation.gov"},
    {"source":"MARKET","type":"market","headline":"real headline here","time":"4 hr ago","url":"https://freightwaves.com"},
    {"source":"ATA","type":"ata","headline":"real headline here","time":"5 hr ago","url":"https://trucking.org"},
    {"source":"FMCSA","type":"fmcsa","headline":"real headline here","time":"6 hr ago","url":"https://fmcsa.dot.gov"},
    {"source":"DOT","type":"dot","headline":"real headline here","time":"8 hr ago","url":"https://transportation.gov"},
    {"source":"MARKET","type":"market","headline":"real headline here","time":"12 hr ago","url":"https://ttnews.com"}
  ],
  "stats": {
    "national": 3.650,
    "totalLoads": 250000,
    "tlRatio": 3.5,
    "fuelSurcharge": 27.5
  }
}`;

    const gRes = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      },
      55000
    );

    if (!gRes.ok) {
      const errBody = await gRes.text();
      let errMsg = `Gemini HTTP ${gRes.status}`;
      try { errMsg = JSON.parse(errBody).error?.message || errMsg; } catch {}
      throw new Error(errMsg);
    }

    const gData = await gRes.json();

    const text = (gData.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('');

    if (!text) {
      const finishReason = gData.candidates?.[0]?.finishReason;
      throw new Error(`Gemini returned empty response. finishReason: ${finishReason}`);
    }

    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in Gemini response');

    const parsed = JSON.parse(match[0]);

    if (!parsed.diesel || !parsed.rates || !parsed.stats) {
      throw new Error('Gemini JSON missing required fields: diesel, rates or stats');
    }

    ['reefer', 'dryvan', 'flatbed'].forEach(t => {
      const r = parsed.rates[t];
      if (r && (r.current < 1.0 || r.current > 9.0)) {
        console.warn(`Rate ${t} out of range (${r.current}), zeroing`);
        r.current = 0;
      }
    });

    const grounded = !!gData.candidates?.[0]?.groundingMetadata;
    const result = { ok: true, ...parsed, grounded, ts: new Date().toISOString() };

    cache = { data: result, ts: Date.now() };
    console.log(`✅ Data refreshed. Grounded: ${grounded}`);
    res.json(result);

  } catch (e) {
    console.error('❌ Gemini error:', e.message);
    if (cache.data) {
      console.log('⚠️  Returning stale cache');
      return res.json({ ...cache.data, cached: true, stale: true });
    }
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true,
  ts: new Date().toISOString(),
  hasKey: !!GEMINI_KEY,
  cacheAge: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) + 's' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse running on port ${PORT}`));
