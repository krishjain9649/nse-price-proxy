const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from anywhere (your portfolio tracker HTML file)
app.use(cors());
app.use(express.json());

// Cache prices for 60 seconds to avoid hammering NSE
const priceCache = {};
const CACHE_TTL = 60 * 1000; // 60 seconds

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'NSE Price Proxy is running' });
});

// ── Main price endpoint ──
// Usage: /price?symbol=RELIANCE&exchange=NSE
app.get('/price', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const exchange = (req.query.exchange || 'NSE').trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }

  const cacheKey = `${exchange}:${symbol}`;
  const cached = priceCache[cacheKey];
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    console.log(`[CACHE] ${cacheKey} = ₹${cached.price}`);
    return res.json({ symbol, exchange, price: cached.price, source: cached.source, cached: true });
  }

  let price = null;
  let source = null;

  // ── Source 1: NSE India official API ──
  try {
    const result = await fetchNSE(symbol);
    if (result) { price = result; source = 'NSE'; }
  } catch(e) {
    console.warn(`NSE failed for ${symbol}:`, e.message);
  }

  // ── Source 2: BSE India official API ──
  if (!price && exchange === 'BSE') {
    try {
      const result = await fetchBSE(symbol);
      if (result) { price = result; source = 'BSE'; }
    } catch(e) {
      console.warn(`BSE failed for ${symbol}:`, e.message);
    }
  }

  // ── Source 3: Stooq (no key, good coverage) ──
  if (!price) {
    try {
      const result = await fetchStooq(symbol, exchange);
      if (result) { price = result; source = 'Stooq'; }
    } catch(e) {
      console.warn(`Stooq failed for ${symbol}:`, e.message);
    }
  }

  // ── Source 4: Yahoo Finance (last resort) ──
  if (!price) {
    try {
      const result = await fetchYahoo(symbol, exchange);
      if (result) { price = result; source = 'Yahoo'; }
    } catch(e) {
      console.warn(`Yahoo failed for ${symbol}:`, e.message);
    }
  }

  if (!price) {
    return res.status(404).json({ error: `No price found for ${symbol}`, symbol, exchange });
  }

  // Cache the result
  priceCache[cacheKey] = { price, source, time: Date.now() };
  console.log(`[FETCH] ${cacheKey} = ₹${price} (${source})`);
  res.json({ symbol, exchange, price, source, cached: false });
});

// ── Batch price endpoint ──
// Usage: POST /prices  body: { symbols: [{symbol:"RELIANCE", exchange:"NSE"}, ...] }
app.post('/prices', async (req, res) => {
  const symbols = req.body.symbols || [];
  if (!symbols.length) return res.json({ results: [] });

  const results = await Promise.allSettled(
    symbols.map(async ({ symbol, exchange = 'NSE' }) => {
      const s = symbol.trim().toUpperCase();
      const e = exchange.trim().toUpperCase();
      const cacheKey = `${e}:${s}`;
      const cached = priceCache[cacheKey];
      if (cached && Date.now() - cached.time < CACHE_TTL) {
        return { symbol: s, exchange: e, price: cached.price, source: cached.source, cached: true };
      }
      // Try all sources
      for (const fetcher of [
        () => fetchNSE(s),
        () => e === 'BSE' ? fetchBSE(s) : Promise.reject('skip'),
        () => fetchStooq(s, e),
        () => fetchYahoo(s, e)
      ]) {
        try {
          const price = await fetcher();
          if (price) {
            priceCache[cacheKey] = { price, source: 'multi', time: Date.now() };
            return { symbol: s, exchange: e, price, cached: false };
          }
        } catch(e) {}
      }
      return { symbol: s, exchange: e, price: null, error: 'not found' };
    })
  );

  res.json({ results: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason }) });
});

// ══════════════════════════════════════════
// FETCHER FUNCTIONS
// ══════════════════════════════════════════

async function fetchNSE(symbol) {
  // NSE India's official quote API
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/',
    'X-Requested-With': 'XMLHttpRequest'
  };

  // First hit the main page to get cookies
  await fetch('https://www.nseindia.com', { headers, timeout: 8000 });

  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const r = await fetch(url, { headers, timeout: 8000 });
  if (!r.ok) throw new Error(`NSE HTTP ${r.status}`);
  const j = await r.json();

  const price = j?.priceInfo?.lastPrice || j?.priceInfo?.close;
  if (!price || price <= 0) throw new Error('no price in response');
  return parseFloat(price);
}

async function fetchBSE(symbol) {
  // BSE India scrip code lookup — BSE uses numeric codes not symbols
  // Try with symbol directly first
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.bseindia.com/'
  };
  const url = `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${encodeURIComponent(symbol)}&seriesid=`;
  const r = await fetch(url, { headers, timeout: 8000 });
  if (!r.ok) throw new Error(`BSE HTTP ${r.status}`);
  const j = await r.json();
  const price = parseFloat(j?.CurrRate);
  if (!price || price <= 0) throw new Error('no BSE price');
  return price;
}

async function fetchStooq(symbol, exchange) {
  const suffix = (exchange === 'NSE' || exchange === 'BSE') ? '.in' : '.us';
  const sym = symbol.toLowerCase().replace(/&/g, '-') + suffix;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000
  });
  const txt = await r.text();
  const lines = txt.trim().split('\n');
  if (lines.length < 2) throw new Error('no data');
  const price = parseFloat(lines[1].split(',')[6]);
  if (!price || isNaN(price) || price <= 0) throw new Error('bad price');
  return price;
}

async function fetchYahoo(symbol, exchange) {
  const suffix = exchange === 'NSE' ? '.NS' : exchange === 'BSE' ? '.BO' : '';
  const yt = symbol + suffix;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yt)}?interval=1d&range=1d`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    timeout: 8000
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const j = await r.json();
  const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!price || price <= 0) throw new Error('no Yahoo price');
  return parseFloat(price);
}

// ── UNLISTED SHARES ENDPOINT ──
// Usage: /unlisted-price?name=NSE
app.get('/unlisted-price', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const slug = name.toLowerCase().trim().replace(/\s+/g, '-') + '-unlisted-shares';
    const url = `https://unlistedzone.com/shares/${slug}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`page returned ${r.status}`);
    const html = await r.text();

    let price = null;

    // Try 1: look for embedded JSON data (__NEXT_DATA__), search for a price-like field
    const jsonMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const jsonStr = JSON.stringify(data);
        const priceMatch = jsonStr.match(/"price"\s*:\s*"?([\d,]+\.?\d*)"?/i);
        if (priceMatch) price = parseFloat(priceMatch[1].replace(/,/g, ''));
      } catch (e) { /* fall through to Try 2 */ }
    }

    // Try 2: find a ₹ amount sitting near the word "Indicative" in the raw text
    if (!price) {
      const stripped = html.replace(/<[^>]+>/g, ' ');
      const nearIndicative = stripped.match(/₹\s?([\d,]+\.?\d*)\s*(?:Indicative)/i)
                            || stripped.match(/(?:Indicative)[^₹]{0,40}₹\s?([\d,]+\.?\d*)/i);
      if (nearIndicative) price = parseFloat(nearIndicative[1].replace(/,/g, ''));
    }

    if (!price || price <= 0) throw new Error('could not locate a price on the page');
    res.json({ price, source: 'unlistedzone' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── START SERVER ──
app.listen(PORT, () => {
  console.log(`✅ NSE Price Proxy running on port ${PORT}`);
});
