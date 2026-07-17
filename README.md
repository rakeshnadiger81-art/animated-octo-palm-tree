# Stock Desk

A live stock watchlist dashboard — search to add tickers, see price, change, and a sparkline for
each, with an optional Finnhub API key for reliable real-time quotes.

## Files

All source files sit at the project root (no `src/` subfolder) to make uploading via GitHub's
web UI simple, even from a phone:

- `App.jsx` — tab switcher between Watchlist, Analyzer, Deep Dive, News, and Events
- `StockDesk.jsx` — the watchlist dashboard (search, add tickers, live prices, sparklines)
- `Analyzer.jsx` — quick technical read: ATR/Pivots/VWAP/Volume Profile/RSI+MACD/EMAs/Bollinger/
  Fibonacci/IV/Relative Volume, composite buy/sell/hold signal, daily target, weekly price range,
  and a weekly options structure idea.
- `DeepDive.jsx` — full institutional-style research report: price action (trend/structure/S-R/
  gaps), 17 technical indicators, volume analysis, institutional activity (insider transactions +
  analyst trend where a Finnhub key is set; dark pool/13F/block trades explicitly marked
  unavailable rather than faked), options market (real max pain/walls/PCR/GEX-approximation from
  Yahoo's live options chain), fundamentals (via Finnhub), macro environment (real Treasury
  yield/DXY/oil/VIX/sector-ETF tickers), a model-generated 5-bucket probability distribution,
  price targets for 5 days/1 month/3 months with confidence, a mechanical trading plan, top
  upside/downside catalysts, and a weighted final rating (Strong Buy → Sell). Sections that need
  paid data feeds we don't have access to are labeled "Not available" rather than estimated.
- `News.jsx` — live CNBC headlines (Top News / Markets & Finance), plus a per-ticker company
  news lookup via Finnhub (requires the same Finnhub key used elsewhere in the app).
- `Events.jsx` — major US macro events over the next 30 days (FOMC, CPI, PPI, Jobs Report) with
  a curated, verified date list plus a live ForexFactory economic calendar feed, each event
  paired with a plain-English note on how a better/worse-than-expected result typically moves
  markets.
- `api/proxy.js` — a Vercel serverless function that proxies requests to an allowlist of
  data-provider hosts (Yahoo Finance, CNBC, ForexFactory, Finnhub) server-side. Every tab tries
  a direct browser fetch first, and falls back to `/api/proxy?url=...` if that's blocked by
  CORS — since this runs on Vercel's own servers, it isn't subject to the browser's CORS policy
  at all, which makes it far more reliable than the free third-party CORS proxies (allorigins.win,
  corsproxy.io) this app used earlier. No setup needed — Vercel auto-deploys anything under `/api`
  as a serverless function alongside the static site.
- `main.jsx`, `index.html` — entry points
- `package.json`, `vite.config.js`, `vercel.json` — build/deploy config

## Run locally

```bash
npm install
npm run dev
```

Open the printed local URL (usually http://localhost:5173).

## Deploy to Vercel

**Option A — Vercel CLI (fastest)**

```bash
npm install -g vercel
cd stock-desk-app
vercel
```

Follow the prompts (link or create a project, accept the detected Vite settings). Vercel will
give you a live URL immediately, and `vercel --prod` promotes it to production.

**Option B — GitHub + Vercel dashboard**

1. Push this folder to a new GitHub repo.
2. Go to vercel.com → **Add New... → Project** → import the repo.
3. Vercel auto-detects the Vite framework (build command `npm run build`, output `dist`) via
   `vercel.json` — just click **Deploy**.

No environment variables are required. If you have a Finnhub API key, add it from inside the app
itself (the "connect data" button) — it's stored in your browser's local storage on your device,
not as a server-side secret, since all data fetching happens client-side.

## Notes on live data

- Tries Finnhub first if you've saved a key (free tier: finnhub.io/register, 60 requests/min).
- Falls back to Yahoo Finance's public (unofficial) chart endpoint if no key is set.
- Falls back to seeded simulated data if both are unreachable, clearly tagged "SIM" on each card.
- Watchlist and API key persist in your browser's localStorage — they're per-browser, not
  synced across devices.
- Auto-refreshes every 20 seconds; there's also a manual "retry live" button.
