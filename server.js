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
// FETCHER FUNCTIONS (listed equities — unchanged)
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

// ══════════════════════════════════════════
// UNLISTED SHARES — catalog-based search + price
// ══════════════════════════════════════════
// unlistedzone.com has no public search API, so instead of guessing a page
// slug from whatever name the user typed (which breaks the moment the real
// slug doesn't match the guess), we crawl their public /shares listing pages
// once, cache every {name, slug, price} we find in memory, and search/lookup
// against that cache. The listing itself already shows each company's current
// indicative price, so this doubles as the price source too — no need to hit
// each company's own page separately. Cache refreshes once an hour so we're
// not hammering their site on every request.

let unlistedCatalog = [];        // [{ name, slug, price }]
let unlistedCatalogBuiltAt = 0;
const UNLISTED_CATALOG_TTL = 60 * 60 * 1000; // 1 hour
let unlistedCatalogBuilding = null; // in-flight promise so concurrent requests share one crawl

async function buildUnlistedCatalog() {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  // Matches: <a href="https://unlistedzone.com/shares/{slug}">{Name}</a> ... <h5 class="card-title">₹{price}</h5>
  const cardRegex = /<a\s+href="https:\/\/unlistedzone\.com\/shares\/([^"]+)">\s*([^<]+?)\s*<\/a>[\s\S]{0,120}?<h5 class="card-title">₹([\d,]+\.?\d*)<\/h5>/g;

  const catalog = [];
  const seenSlugs = new Set();

  for (let page = 1; page <= 30; page++) {
    const url = page === 1
      ? 'https://unlistedzone.com/shares'
      : `https://unlistedzone.com/shares?page=${page}`;

    let html = '';
    try {
      const r = await fetch(url, { headers, timeout: 10000 });
      if (!r.ok) break;
      const body = await r.text();
      // Page 1 is a full HTML document. page>1 comes back as {"status":200,"html":"..."}
      try {
        const j = JSON.parse(body);
        html = (j && j.html) ? j.html.replace(/\\\//g, '/').replace(/\\"/g, '"') : '';
      } catch (e) {
        html = body;
      }
    } catch (e) {
      break; // network error mid-crawl — stop, keep whatever we already parsed
    }

    if (!html) break;

    let match;
    let foundOnThisPage = 0;
    cardRegex.lastIndex = 0;
    while ((match = cardRegex.exec(html)) !== null) {
      const slug = match[1];
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      // unlistedzone truncates long names on the listing page (e.g. "Apollo Fashion
      // International Unlisted Sh ..."). Strip that trailing ellipsis so the dropdown
      // shows a clean (if occasionally shortened) name rather than a garbled one.
      const name = match[2].trim().replace(/\s*\.\.\.\s*$/, '');
      const price = parseFloat(match[3].replace(/,/g, ''));
      catalog.push({ name, slug, price: isNaN(price) ? null : price });
      foundOnThisPage++;
    }

    if (foundOnThisPage === 0) break; // reached the last page
    await new Promise(r => setTimeout(r, 250)); // be polite between page requests
  }

  return catalog;
}

async function getUnlistedCatalog() {
  const isStale = Date.now() - unlistedCatalogBuiltAt > UNLISTED_CATALOG_TTL;
  if (unlistedCatalog.length && !isStale) return unlistedCatalog;

  if (!unlistedCatalogBuilding) {
    unlistedCatalogBuilding = buildUnlistedCatalog()
      .then(catalog => {
        if (catalog.length) {
          unlistedCatalog = catalog;
          unlistedCatalogBuiltAt = Date.now();
        }
        unlistedCatalogBuilding = null;
        return unlistedCatalog;
      })
      .catch(e => {
        unlistedCatalogBuilding = null;
        console.warn('Unlisted catalog build failed:', e.message);
        return unlistedCatalog; // whatever we had before (possibly stale, possibly empty)
      });
  }
  return unlistedCatalogBuilding;
}

// ── /unlisted-search?q=... — THIS ROUTE WAS MISSING BEFORE. The frontend has
// been calling it all along; there was simply nothing here to answer it. ──
app.get('/unlisted-search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  try {
    const catalog = await getUnlistedCatalog();
    const results = catalog
      .filter(c => c.name.toLowerCase().includes(q))
      .slice(0, 15)
      .map(c => ({ name: c.name, slug: c.slug }));
    res.json(results);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /unlisted-price?name=...&slug=... ──
// Previously this ignored the `slug` param entirely and always re-guessed a
// URL from the name. Now it checks the crawled catalog first (by slug, then
// by name), and only falls back to guessing a URL for a brand-new company
// that hasn't been picked up by a crawl yet.
app.get('/unlisted-price', async (req, res) => {
  const { name, slug } = req.query;
  if (!name && !slug) return res.status(400).json({ error: 'name or slug required' });

  try {
    const catalog = await getUnlistedCatalog();

    if (slug) {
      const bySlug = catalog.find(c => c.slug === slug);
      if (bySlug && bySlug.price != null) {
        return res.json({ price: bySlug.price, source: 'unlistedzone-catalog', slug: bySlug.slug });
      }
    }

    if (name) {
      const n = name.trim().toLowerCase();
      const byName = catalog.find(c => c.name.trim().toLowerCase() === n)
                  || catalog.find(c => c.name.trim().toLowerCase().startsWith(n));
      if (byName && byName.price != null) {
        return res.json({ price: byName.price, source: 'unlistedzone-catalog', slug: byName.slug });
      }
    }

    // Last resort: guess the slug from the name and scrape that page directly
    // (covers a company added to unlistedzone.com since the last hourly crawl)
    if (name) {
      const guessed = await fetchUnlistedPriceByGuessedSlug(name);
      if (guessed) return res.json({ price: guessed, source: 'unlistedzone-guess' });
    }

    return res.status(404).json({ error: `Could not find a price for "${name || slug}" on unlistedzone.com` });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

async function fetchUnlistedPriceByGuessedSlug(name) {
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-') + '-unlisted-shares';
  const url = `https://unlistedzone.com/shares/${slug}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
  if (!r.ok) return null;
  const html = await r.text();
  const stripped = html.replace(/<[^>]+>/g, ' ');
  const m = stripped.match(/₹\s?([\d,]+\.?\d*)\s*(?:Indicative)/i)
         || stripped.match(/(?:Indicative)[^₹]{0,40}₹\s?([\d,]+\.?\d*)/i);
  if (!m) return null;
  const price = parseFloat(m[1].replace(/,/g, ''));
  return (!price || price <= 0) ? null : price;
}

// ── Debug helper: check catalog health from a browser ──
// Visit https://your-proxy.onrender.com/unlisted-catalog-status
app.get('/unlisted-catalog-status', (req, res) => {
  res.json({
    companies: unlistedCatalog.length,
    builtAt: unlistedCatalogBuiltAt ? new Date(unlistedCatalogBuiltAt).toISOString() : null,
    stale: !unlistedCatalogBuiltAt || (Date.now() - unlistedCatalogBuiltAt > UNLISTED_CATALOG_TTL),
    sample: unlistedCatalog.slice(0, 5)
  });
});

// ── START SERVER ──
app.listen(PORT, () => {
  console.log(`✅ NSE Price Proxy running on port ${PORT}`);
});
