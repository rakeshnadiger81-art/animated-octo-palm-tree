# Stock Desk

A live stock watchlist dashboard — search to add tickers, see price, change, and a sparkline for
each, with an optional Finnhub API key for reliable real-time quotes.

## Robustness features

- **Error boundaries** — each tab is isolated; a crash in one tab shows a recoverable error
  message instead of blanking the whole app.
- **Lazy-loaded tabs** — each tab's JS only downloads when first opened, instead of all seven
  shipping in one bundle up front.
- **Offline detection** — a banner appears automatically when the browser loses connectivity.
- **Data source status panel** — tap the small activity icon (top right of the tab bar) to ping
  Yahoo, Finnhub, CNBC, and ForexFactory and see which are currently reachable.
- **`api/health.js`** — the endpoint behind that panel; also useful for manual debugging.
- **Heatmap server-side caching** — repeated loads within 45 seconds reuse the last fetch instead
  of re-hammering Yahoo with ~135 requests; the "Refresh Heatmap" button bypasses this on purpose.
- **Proxy abuse deterrent** — `api/proxy.js` now requires a header only this app's own frontend
  sends, so a random bot that discovers the URL can't relay traffic through it.
- **Short-TTL client caching** — Analyzer, Deep Dive, and Invest cache their last result per
  ticker for 60 seconds, so switching tabs and back (or an accidental duplicate submit) doesn't
  refire a full multi-request analysis.
- **Persisted last-searched ticker** — Analyzer, Deep Dive, Invest, and News's company search
  remember your last ticker per tab and prefill it next time (they don't auto-run, just prefill).
- **Loading skeletons** — Deep Dive and Invest show placeholder cards during their longer loads
  instead of a bare spinner.
- **Yahoo/Finnhub price cross-check** — in the Watchlist, when both a Finnhub key and a live
  Yahoo quote are available, the two prices are compared; a >1.5% gap shows a warning badge,
  since a single wrong-but-plausible number from either source alone wouldn't otherwise be
  visible.

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
- `Invest.jsx` — long-term (1–5yr) fundamental research report: last 4 quarters of margins/ROE/
  ROIC/leverage trend (via Finnhub), EPS history and guidance-accuracy (beat rate), peer P/E and
  P/S comparison, long-term technical health (50/100/200 SMA, relative strength vs SPY, weekly
  trend, accumulation/distribution), an AI Investment Score (0–100 across 7 weighted categories,
  Strong Buy only above 85), a fair-value estimate and 5-year expected-return projection (both
  disclosed as simplified heuristic models, not a DCF), top reasons to buy/not buy, and a verdict
  on accumulating during pullbacks. Growth-quality items that require reading a 10-K/10-Q or
  earnings-call transcript (segment/geographic breakdowns, retention rates, true economic moat,
  hedge/mutual fund ownership, dark pool activity) are explicitly marked unavailable rather than
  guessed. Requires a Finnhub API key to run at all — the free tier's quarterly financials,
  earnings history, peers, and insider data anchor most of this tab's real content.
- `Heatmap.jsx` — sector-grouped market heatmap for today's session: ~156 curated large-cap
  tickers across 13 sectors (Technology, AI, Semiconductors, Financials, Healthcare, Consumer
  Discretionary/Staples, Industrials, Energy, Utilities, Communication Services, Real Estate,
  Materials), colored by the standard 7-bucket % move scheme and sized by an illustrative
  market-cap tier. Includes top 20 gainers/losers, most active, unusual-volume, and new 52-week
  high/low lists; market internals (S&P 500/Nasdaq/Dow/Russell 2000/VIX plus sample-based
  advance/decline and up/down volume); a data-driven risk-on/risk-off read, leading/lagging
  sector, and swing-trade/long-term-accumulation candidate screens. Institutional/options-flow
  data (dark pool, block trades, GEX, dealer positioning) is explicitly marked unavailable at
  this market-wide scale — see Deep Dive for real per-ticker options positioning instead.
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
- `api/heatmap.js` — a second serverless function dedicated to the Heatmap tab: fetches ~160
  tickers (13 sectors + major indices) from Yahoo Finance in parallel, entirely server-side, and
  returns one precomputed JSON payload. Doing this from the browser directly wouldn't work well
  (CORS aside, browsers cap concurrent connections per origin around 6, which would serialize
  160 requests into a very slow waterfall) — running it server-side avoids both problems.
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
