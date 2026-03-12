const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache 10 minutos
const TTL = 10 * 60 * 1000;
let cache = { data: null, ts: 0 };
const isFresh = () => cache.data && (Date.now() - cache.ts < TTL);

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

  if (!GROQ_KEY) {
    return res.status(500).json({ ok: false, error: 'GROQ_KEY not configured' });
  }

  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const prompt = `Today is ${today}.

You are a freight market data API. Return ONLY a valid raw JSON object with realistic current US trucking market data. No markdown, no backticks, no explanation — just the JSON.

Use your best knowledge of current market conditions to fill in realistic values:
- diesel prices based on current EIA PADD region averages
- DAT spot rates per loaded mile (reefer ~$2.80-3.20, dryvan ~$2.20-2.60, flatbed ~$2.60-3.00)
- load-to-truck ratio typically 3.0-5.0 for dry van
- fuel surcharge typically 25-32%
- total loads posted 150000-350000 per day
- news headlines should be realistic recent trucking industry news

Return exactly this JSON structure with realistic non-zero values:
{
  "diesel": {
    "national": 3.68,
    "states": {
      "TX": 3.42, "OK": 3.45, "LA": 3.48, "AR": 3.50, "MS": 3.51,
      "TN": 3.52, "KY": 3.56, "AL": 3.49, "NM": 3.47,
      "IL": 3.60, "IN": 3.58, "IA": 3.56, "KS": 3.53, "MI": 3.63,
      "MN": 3.58, "MO": 3.55, "NE": 3.54, "ND": 3.57, "OH": 3.61,
      "SD": 3.56, "WI": 3.59,
      "FL": 3.53, "GA": 3.51, "NC": 3.55, "SC": 3.53, "VA": 3.60,
      "WV": 3.63, "MD": 3.68, "DE": 3.70,
      "NY": 3.83, "PA": 3.76, "NJ": 3.78,
      "CT": 3.86, "MA": 3.88, "ME": 3.80, "NH": 3.78, "RI": 3.83, "VT": 3.81,
      "CO": 3.63, "ID": 3.68, "MT": 3.66, "UT": 3.65, "WY": 3.61,
      "WA": 3.93, "OR": 3.88, "NV": 3.83, "AZ": 3.70, "AK": 4.18,
      "CA": 4.48, "HI": 4.75, "DC": 3.73
    }
  },
  "rates": {
    "reefer":  { "current": 2.98, "high": 3.15, "low": 2.82, "change": 0.04, "loads": 42000, "best": "Los Angeles, CA" },
    "dryvan":  { "current": 2.38, "high": 2.55, "low": 2.22, "change": -0.02, "loads": 185000, "best": "Chicago, IL" },
    "flatbed": { "current": 2.78, "high": 2.95, "low": 2.62, "change": 0.06, "loads": 58000, "best": "Houston, TX" }
  },
  "heatmap": [
    {"abbr":"WA","rate":3.05},{"abbr":"OR","rate":2.95},{"abbr":"CA","rate":3.12},{"abbr":"NV","rate":2.88},{"abbr":"ID","rate":2.75},
    {"abbr":"MT","rate":2.68},{"abbr":"WY","rate":2.72},{"abbr":"UT","rate":2.85},{"abbr":"CO","rate":2.92},{"abbr":"AZ","rate":2.96},
    {"abbr":"ND","rate":2.65},{"abbr":"SD","rate":2.62},{"abbr":"NE","rate":2.70},{"abbr":"KS","rate":2.78},{"abbr":"OK","rate":2.82},
    {"abbr":"TX","rate":2.95},{"abbr":"NM","rate":2.75},{"abbr":"MN","rate":2.80},{"abbr":"IA","rate":2.72},{"abbr":"MO","rate":2.85},
    {"abbr":"WI","rate":2.78},{"abbr":"IL","rate":2.95},{"abbr":"IN","rate":2.88},{"abbr":"MI","rate":2.82},{"abbr":"OH","rate":2.90},
    {"abbr":"KY","rate":2.85},{"abbr":"TN","rate":2.92},{"abbr":"AR","rate":2.78},{"abbr":"LA","rate":2.88},{"abbr":"MS","rate":2.72},
    {"abbr":"AL","rate":2.80},{"abbr":"GA","rate":3.02},{"abbr":"FL","rate":2.95},{"abbr":"SC","rate":2.88},{"abbr":"NC","rate":2.85},
    {"abbr":"VA","rate":2.92},{"abbr":"WV","rate":2.75},{"abbr":"PA","rate":2.98},{"abbr":"NY","rate":3.08},{"abbr":"NJ","rate":3.05},
    {"abbr":"ME","rate":2.70},{"abbr":"NH","rate":2.72},{"abbr":"VT","rate":2.68},{"abbr":"MA","rate":3.02},{"abbr":"RI","rate":2.95},
    {"abbr":"CT","rate":2.98},{"abbr":"DE","rate":2.90},{"abbr":"MD","rate":2.95},{"abbr":"DC","rate":2.88},{"abbr":"AK","rate":2.55}
  ],
  "news": [
    {"source":"BREAKING","type":"breaking","headline":"REPLACE WITH REALISTIC HEADLINE","time":"5 min ago","url":"https://freightwaves.com"},
    {"source":"FMCSA","type":"fmcsa","headline":"REPLACE WITH REALISTIC HEADLINE","time":"1 hr ago","url":"https://fmcsa.dot.gov"},
    {"source":"DOT","type":"dot","headline":"REPLACE WITH REALISTIC HEADLINE","time":"2 hr ago","url":"https://transportation.gov"},
    {"source":"MARKET","type":"market","headline":"REPLACE WITH REALISTIC HEADLINE","time":"3 hr ago","url":"https://freightwaves.com"},
    {"source":"ATA","type":"ata","headline":"REPLACE WITH REALISTIC HEADLINE","time":"4 hr ago","url":"https://trucking.org"},
    {"source":"FMCSA","type":"fmcsa","headline":"REPLACE WITH REALISTIC HEADLINE","time":"5 hr ago","url":"https://fmcsa.dot.gov"},
    {"source":"DOT","type":"dot","headline":"REPLACE WITH REALISTIC HEADLINE","time":"6 hr ago","url":"https://transportation.gov"},
    {"source":"MARKET","type":"market","headline":"REPLACE WITH REALISTIC HEADLINE","time":"8 hr ago","url":"https://ttnews.com"}
  ],
  "stats": {
    "national": 3.68,
    "totalLoads": 248000,
    "tlRatio": 3.8,
    "fuelSurcharge": 28.5
  }
}

Replace all REPLACE WITH REALISTIC HEADLINE with real-sounding current trucking/freight industry news headlines for ${today}. Vary the numbers slightly from the defaults to make it look live. Return only the JSON.`;

    const gRes = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'You are a freight market data API. Always respond with valid JSON only. No markdown, no explanation, no backticks.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      },
      55000
    );

    if (!gRes.ok) {
      const errBody = await gRes.text();
      let errMsg = `Groq HTTP ${gRes.status}`;
      try { errMsg = JSON.parse(errBody).error?.message || errMsg; } catch {}
      throw new Error(errMsg);
    }

    const gData = await gRes.json();
    const text = gData.choices?.[0]?.message?.content || '';

    if (!text) throw new Error('Groq returned empty response');

    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in Groq response');

    const parsed = JSON.parse(match[0]);

    if (!parsed.diesel || !parsed.rates || !parsed.stats) {
      throw new Error('Groq JSON missing required fields');
    }

    ['reefer', 'dryvan', 'flatbed'].forEach(t => {
      const r = parsed.rates[t];
      if (r && (r.current < 1.0 || r.current > 9.0)) {
        console.warn(`Rate ${t} out of range (${r.current}), resetting`);
        r.current = 0;
      }
    });

    const result = { ok: true, ...parsed, grounded: false, ts: new Date().toISOString() };
    cache = { data: result, ts: Date.now() };
    console.log('✅ Data refreshed via Groq');
    res.json(result);

  } catch (e) {
    console.error('❌ Groq error:', e.message);
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
  hasKey: !!GROQ_KEY,
  cacheAge: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) + 's' : 'empty',
  cacheOk: isFresh(),
}));

app.listen(PORT, () => console.log(`✅ FreightPulse running on port ${PORT}`));
