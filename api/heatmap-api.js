// Server-side heatmap data builder. Runs entirely on Vercel (Node serverless function), so
// fetching ~160 tickers in parallel has no browser CORS restriction and no per-origin connection
// cap to worry about — both real problems if this were done client-side.
//
// Ticker universe below is a curated, hand-picked set of well-known large-cap constituents per
// sector. It's a reasonable representative snapshot, not a live "top 20 by market cap" ranking —
// exact rankings shift over time and require a paid reference-data feed to track precisely.
// Price/change/volume/52-week range/SMA200 for every ticker below IS live, real data.

const SECTOR_TICKERS = {
  Technology: ["AAPL", "MSFT", "ORCL", "ADBE", "CRM", "NOW", "INTU", "IBM", "ACN", "CSCO", "SHOP", "SAP"],
  AI: ["NVDA", "MSFT", "GOOGL", "META", "AMZN", "PLTR", "AMD", "AVGO", "SNOW", "CRWD", "ORCL", "SMCI"],
  Semiconductors: ["NVDA", "AVGO", "TSM", "AMD", "QCOM", "TXN", "INTC", "AMAT", "MU", "LRCX", "ADI", "KLAC"],
  Financials: ["JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "SPGI", "PNC", "USB"],
  Healthcare: ["LLY", "UNH", "JNJ", "ABBV", "MRK", "TMO", "ABT", "PFE", "DHR", "BMY", "AMGN", "ISRG"],
  "Consumer Discretionary": ["AMZN", "TSLA", "HD", "MCD", "NKE", "LOW", "SBUX", "BKNG", "TJX", "CMG", "MAR", "ABNB"],
  "Consumer Staples": ["WMT", "PG", "KO", "PEP", "COST", "PM", "MDLZ", "CL", "KMB", "GIS", "STZ", "KDP"],
  Industrials: ["GE", "CAT", "RTX", "HON", "UNP", "BA", "DE", "LMT", "UPS", "ETN", "ADP", "MMM"],
  Energy: ["XOM", "CVX", "COP", "SLB", "EOG", "PSX", "MPC", "OXY", "WMB", "KMI", "VLO", "HES"],
  Utilities: ["NEE", "SO", "DUK", "AEP", "SRE", "D", "EXC", "XEL", "ED", "PEG", "WEC", "ES"],
  "Communication Services": ["GOOGL", "META", "NFLX", "DIS", "TMUS", "VZ", "T", "CMCSA", "CHTR", "EA", "WBD", "OMC"],
  "Real Estate": ["PLD", "AMT", "EQIX", "SPG", "PSA", "O", "WELL", "DLR", "CCI", "VICI", "AVB", "EQR"],
  Materials: ["LIN", "SHW", "APD", "ECL", "FCX", "NEM", "DOW", "DD", "NUE", "VMC", "MLM", "ALB"],
};

// Illustrative sizing tiers only (not live shares-outstanding-derived market cap) — used purely
// to vary tile size in the heatmap so mega caps read as visually larger.
const MEGA_TIER = new Set(["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "TSM", "LLY", "JPM", "WMT", "XOM"]);
const LARGE_TIER = new Set([
  "ORCL", "ADBE", "CRM", "PLTR", "AMD", "TSLA", "UNH", "JNJ", "ABBV", "V", "MA", "COST", "HD",
  "BAC", "WFC", "GS", "MRK", "NFLX", "DIS", "PG", "KO", "PEP", "CAT", "GE", "CVX",
]);

const INDEX_TICKERS = { SPX: "^GSPC", NDX: "^IXIC", DJI: "^DJI", RUT: "^RUT", VIX: "^VIX" };

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("no result");
    const meta = result.meta;
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const closes = [], highs = [], lows = [], volumes = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] != null) closes.push(q.close[i]);
      if (q.high?.[i] != null) highs.push(q.high[i]);
      if (q.low?.[i] != null) lows.push(q.low[i]);
      if (q.volume?.[i] != null) volumes.push(q.volume[i]);
    }
    if (!closes.length) throw new Error("no closes");
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? closes[closes.length - 2];
    const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    const volume = meta.regularMarketVolume ?? volumes[volumes.length - 1] ?? null;
    const avgVol20 = volumes.length >= 21 ? volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : null;
    const relVolume = avgVol20 && volume ? volume / avgVol20 : null;
    const high52 = highs.length ? Math.max(...highs) : null;
    const low52 = lows.length ? Math.min(...lows) : null;
    const sma200 = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
    const name = meta.shortName || meta.longName || symbol;
    return {
      symbol,
      name,
      price,
      changePercent,
      volume,
      relVolume,
      high52,
      low52,
      sma200,
      isNew52High: high52 !== null && price >= high52 * 0.999,
      isNew52Low: low52 !== null && price <= low52 * 1.001,
    };
  } finally {
    clearTimeout(id);
  }
}

async function fetchAllChunked(symbols, chunkSize = 25) {
  const results = {};
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const settled = await Promise.allSettled(chunk.map(fetchYahooChart));
    settled.forEach((r, idx) => {
      if (r.status === "fulfilled") results[chunk[idx]] = r.value;
    });
  }
  return results;
}

export default async function handler(req, res) {
  try {
    const allSymbols = Array.from(new Set([...Object.values(SECTOR_TICKERS).flat(), ...Object.values(INDEX_TICKERS)]));
    const dataMap = await fetchAllChunked(allSymbols, 25);

    const sectors = {};
    for (const [sector, tickers] of Object.entries(SECTOR_TICKERS)) {
      sectors[sector] = tickers
        .map((t) => dataMap[t])
        .filter(Boolean)
        .map((d) => ({ ...d, sector, tier: MEGA_TIER.has(d.symbol) ? 3 : LARGE_TIER.has(d.symbol) ? 2 : 1 }));
    }
    const indices = {};
    for (const [key, sym] of Object.entries(INDEX_TICKERS)) if (dataMap[sym]) indices[key] = dataMap[sym];

    res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=90");
    res.status(200).json({
      sectors,
      indices,
      generatedAt: Date.now(),
      totalRequested: allSymbols.length,
      totalLoaded: Object.keys(dataMap).length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
