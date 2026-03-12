const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache 5 minutos
const TTL = 5 * 60 * 1000;
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

// Busca dados reais de diesel da EIA (gratuito, sem key)
async function fetchEIADiesel() {
  try {
    // EIA API v2 - diesel prices por região PADD (gratuito)
    const url = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=DEMO_KEY&frequency=weekly&data[0]=value&facets[product][]=DU&facets[duoarea][]=NUS&sort[0][column]=period&sort[0][direction]=desc&length=1';
    const r = await fetchWithTimeout(url, {}, 10000);
    if (!r.ok) return null;
    const d = await r.json();
    const val = d?.response?.data?.[0]?.value;
    return val ? parseFloat(val) : null;
  } catch { return null; }
}

app.post('/api/data', async (req, res) => {
  if (isFresh()) return res.json({ ...cache.data, cached: true });

  if (!GROQ_KEY) {
    return res.status(500).json({ ok: false, error: 'GROQ_KEY not configured' });
  }

  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Tenta buscar diesel real da EIA
    const eiaDiesel = await fetchEIADiesel();
    const nationalDiesel = eiaDiesel || 3.68;
    console.log(`EIA diesel: ${eiaDiesel ? '$'+eiaDiesel : 'failed, using estimate'}`);

    const prompt = `Today is ${today}, time is ${timeStr} ET.
The current EIA national average diesel price is $${nationalDiesel.toFixed(3)}/gallon (real data).

You are a freight market intelligence API. Generate a JSON object with the most accurate and realistic current US trucking market data possible. Use your knowledge of current market conditions as of ${today}.

IMPORTANT: Use $${nationalDiesel.toFixed(3)} as the national diesel average and derive state prices from real PADD region differentials:
- PADD 1 (Northeast: CT,DE,MA,MD,ME,NH,NJ,NY,PA,RI,VA,VT,WV,DC): national + $0.08 to +$0.20
- PADD 2 (Midwest: IA,IL,IN,KS,KY,MI,MN,MO,ND,NE,OH,OK,SD,TN,WI): national - $0.05 to +$0.05
- PADD 3 (Gulf Coast: AL,AR,FL,GA,LA,MS,NM,TX): national - $0.15 to -$0.25
- PADD 4 (Rocky Mountain: CO,ID,MT,UT,WY): national + $0.00 to +$0.10
- PADD 5 (West Coast: AK,AZ,CA,HI,NV,OR,WA): national + $0.10 to +$0.80 (CA highest, HI very high)

For DAT spot rates use realistic current market values:
- Reefer: $2.85-$3.15/mile national average
- Dry Van: $2.20-$2.55/mile national average  
- Flatbed: $2.65-$3.00/mile national average
- Truck/load ratio: 3.5-5.0 (current market)
- Total loads: 200000-320000 per day
- Fuel surcharge: 25-32%

For news, generate 8 realistic trucking industry headlines that sound current and credible for ${today}.

Return ONLY this JSON, no markdown:
{
  "diesel": {
    "national": ${nationalDiesel.toFixed(3)},
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
    {"source":"BREAKING","type":"breaking","headline":"","time":"3 min ago","url":"https://freightwaves.com"},
    {"source":"FMCSA","type":"fmcsa","headline":"","time":"1 hr ago","url":"https://fmcsa.dot.gov"},
    {"source":"DOT","type":"dot","headline":"","time":"2 hr ago","url":"https://transportation.gov"},
    {"source":"MARKET","type":"market","headline":"","time":"3 hr ago","url":"https://freightwaves.com"},
    {"source":"ATA","type":"ata","headline":"","time":"4 hr ago","url":"https://trucking.org"},
    {"source":"FMCSA","type":"fmcsa","headline":"","time":"5 hr ago","url":"https://fmcsa.dot.gov"},
    {"source":"DOT","type":"dot","headline":"","time":"6 hr ago","url":"https://transportation.gov"},
    {"source":"MARKET","type":"market","headline":"","time":"8 hr ago","url":"https://ttnews.com"}
  ],
  "stats": {
    "national": ${nationalDiesel.toFixed(3)},
    "totalLoads": 0,
    "tlRatio": 0.0,
    "fuelSurcharge": 0.0
  }
}`;

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
            { role: 'system', content: 'You are a freight market data API. Always respond with valid JSON only. No markdown, no explanation, no backticks. Fill all 0.00 values with realistic current market data.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
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
    if (!match) throw new Error('No JSON found in Groq response');

    const parsed = JSON.parse(match[0]);
    if (!parsed.diesel || !parsed.rates || !parsed.stats) throw new Error('Missing required fields');

    // Garante que o nacional EIA real prevalece
    parsed.diesel.national = nationalDiesel;
    parsed.stats.national = nationalDiesel;

    ['reefer', 'dryvan', 'flatbed'].forEach(t => {
      const r = parsed.rates[t];
      if (r && (r.current < 1.0 || r.current > 9.0)) r.current = 0;
    });

    const result = { ok: true, ...parsed, grounded: !!eiaDiesel, ts: new Date().toISOString() };
    cache = { data: result, ts: Date.now() };
    console.log(`✅ Data refreshed | EIA diesel: $${nationalDiesel} | ${now.toLocaleTimeString()}`);
    res.json(result);

  } catch (e) {
    console.error('❌ Error:', e.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
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
