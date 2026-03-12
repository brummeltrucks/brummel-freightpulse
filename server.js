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

// POST /api/data — tudo via Gemini + Google Search
app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });

  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const prompt = `Today is ${today}.

Search the web RIGHT NOW and return ONLY a raw JSON object. No markdown, no backticks, no explanation before or after — just the JSON.

Search these sources:
- EIA (eia.gov) for diesel prices
- DAT Freight & Analytics (dat.com) for spot rates
- FreightWaves (freightwaves.com) for market data
- FMCSA (fmcsa.dot.gov), DOT (transportation.gov), ATA (trucking.org), TTNews (ttnews.com) for news

STRICT RULES:
- diesel.national = EIA weekly on-highway retail diesel national average ($/gallon)
- diesel.states = EIA PADD region prices mapped to all 50 states with small sub-regional variation (+-$0.02-0.08)
- rates = DAT national spot rates per loaded mile, all-in excluding fuel surcharge
- stats.tlRatio = DAT national dry van load-to-truck ratio
- stats.totalLoads = DAT loads posted last 24 hours
- stats.fuelSurcharge = current fuel surcharge % from ATA or EIA
- heatmap = reefer RPM per state from DAT/FreightWaves or PADD interpolation
- news = REAL headlines published today or this week, real URLs
- All numbers as plain floats. Use 0 if not found. Do NOT fabricate.

{
  "diesel": {
    "national": 0.000,
    "states": {
      "TX": 0.000, "OK": 0.000, "LA": 0.000, "AR": 0.000, "MS": 0.000,
      "TN": 0.000, "KY": 0.000, "AL": 0.000, "NM": 0.000,
      "IL": 0.000, "IN": 0.000, "IA": 0.000, "KS": 0.000, "MI": 0.000,
      "MN": 0.000, "MO": 0.000, "NE": 0.000, "ND": 0.000, "OH": 0.000,
      "SD": 0.000, "WI": 0.000,
      "FL": 0.000, "GA": 0.000, "NC": 0.000, "SC": 0.000, "VA": 0.000,
      "WV": 0.000, "MD": 0.000, "DE": 0.000,
      "NY": 0.000, "PA": 0.000, "NJ": 0.000,
      "CT": 0.000, "MA": 0.000, "ME": 0.000, "NH": 0.000, "RI": 0.000, "VT": 0.000,
      "CO": 0.000, "ID": 0.000, "MT": 0.000, "UT": 0.000, "WY": 0.000,
      "WA": 0.000, "OR": 0.000, "NV": 0.000, "AZ": 0.000, "AK": 0.000,
      "CA": 0.000, "HI": 0.000, "DC": 0.000
    }
  },
  "rates": {
    "reefer":  { "current": 0.00, "high": 0.00, "low": 0.00, "change": 0.00, "loads": 0, "best": "City, ST" },
    "dryvan":  { "current": 0.00, "high": 0.00, "low": 0.00, "change": 0.00, "loads": 0, "best": "City, ST" },
    "flatbed": { "current": 0.00, "high": 0.00, "low": 0.00, "change": 0.00, "loads": 0, "best": "City, ST" }
  },
  "heatmap": [
    {"abbr":"WA","rate":0.00},{"abbr":"OR","rate":0.00},{"abbr":"CA","rate":0.00},{"abbr":"NV","rate":0.00},{"abbr":"ID","rate":0.00},{"abbr":"MT","rate":0.00},{"abbr":"WY","rate":0.00},{"abbr":"UT","rate":0.00},{"abbr":"CO","rate":0.00},{"abbr":"AZ","rate":0.00},
    {"abbr":"ND","rate":0.00},{"abbr":"SD","rate":0.00},{"abbr":"NE","rate":0.00},{"abbr":"KS","rate":0.00},{"abbr":"OK","rate":0.00},{"abbr":"TX","rate":0.00},{"abbr":"NM","rate":0.00},{"abbr":"MN","rate":0.00},{"abbr":"IA","rate":0.00},{"abbr":"MO","rate":0.00},
    {"abbr":"WI","rate":0.00},{"abbr":"IL","rate":0.00},{"abbr":"IN","rate":0.00},{"abbr":"MI","rate":0.00},{"abbr":"OH","rate":0.00},{"abbr":"KY","rate":0.00},{"abbr":"TN","rate":0.00},{"abbr":"AR","rate":0.00},{"abbr":"LA","rate":0.00},{"abbr":"MS","rate":0.00},
    {"abbr":"AL","rate":0.00},{"abbr":"GA","rate":0.00},{"abbr":"FL","rate":0.00},{"abbr":"SC","rate":0.00},{"abbr":"NC","rate":0.00},{"abbr":"VA","rate":0.00},{"abbr":"WV","rate":0.00},{"abbr":"PA","rate":0.00},{"abbr":"NY","rate":0.00},{"abbr":"NJ","rate":0.00},
    {"abbr":"ME","rate":0.00},{"abbr":"NH","rate":0.00},{"abbr":"VT","rate":0.00},{"abbr":"MA","rate":0.00},{"abbr":"RI","rate":0.00},{"abbr":"CT","rate":0.00},{"abbr":"DE","rate":0.00},{"abbr":"MD","rate":0.00},{"abbr":"DC","rate":0.00},{"abbr":"AK","rate":0.00}
  ],
  "news": [
    {"source":"BREAKING","type":"breaking","headline":"real headline","time":"X min ago","url":"https://..."},
    {"source":"FMCSA","type":"fmcsa","headline":"real headline","time":"X hr ago","url":"https://..."},
    {"source":"DOT","type":"dot","headline":"real headline","time":"X hr ago","url":"https://..."},
    {"source":"MARKET","type":"market","headline":"real headline","time":"X hr ago","url":"https://..."},
    {"source":"ATA","type":"ata","headline":"real headline","time":"X hr ago","url":"https://..."},
    {"source":"FMCSA","type":"fmcsa","headline":"real headline","time":"X hr ago","url":"https://..."},
    {"source":"DOT","type":"dot","headline":"real headline","time":"X hr ago","url":"https://..."},
    {"source":"MARKET","type":"market","headline":"real headline","time":"X hr ago","url":"https://..."}
  ],
  "stats": {
    "national": 0.000,
    "totalLoads": 0,
    "tlRatio": 0.0,
    "fuelSurcharge": 0.0
  }
}`;

    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 4000 },
        }),
        timeout: 55000,
      }
    );

    if (!gRes.ok) {
      const err = await gRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Gemini HTTP ' + gRes.status);
    }

    const gData = await gRes.json();
    const text = (gData.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('');

    if (!text) throw new Error('Gemini returned empty response');

    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Gemini response');

    const parsed = JSON.parse(match[0]);

    if (!parsed.diesel || !parsed.rates || !parsed.stats) {
      throw new Error('Gemini JSON missing required fields');
    }

    ['reefer', 'dryvan', 'flatbed'].forEach(t => {
      const r = parsed.rates[t];
      if (r && (r.current < 1.0 || r.current > 9.0)) r.current = 0;
    });

    const grounded = !!gData.candidates?.[0]?.groundingMetadata;
    const result = { ok: true, ...parsed, grounded, ts: new Date().toISOString() };

    cache = { data: result, ts: Date.now() };
    res.json(result);

  } catch (e) {
    console.error('Gemini error:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({
  ok: true,
  ts: new Date().toISOString(),
  cacheAge: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) + 's' : 'empty',
}));

app.listen(PORT, () => console.log(`✅ FreightPulse on port ${PORT}`));
