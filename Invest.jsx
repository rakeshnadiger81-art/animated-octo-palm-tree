import React, { useState, useEffect, useRef } from "react";
import HelpModal from "./HelpModal.jsx";
import { matchGlossary } from "./indicatorGlossary.js";
import {
  Search,
  Loader2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
  CheckCircle2,
  XCircle,
  HelpCircle,
} from "lucide-react";

const FETCH_TIMEOUT_MS = 10000;
const APIKEY_KEY = "stockdesk:finnhub_key";

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
function readLocal(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    // ignore quota/private-mode errors
  }
}
const LAST_SYMBOL_KEY = "stockdesk:lastSymbol:invest";
const analysisCache = new Map();
const CACHE_TTL_MS = 60000;

// ============================== DATA FETCHING ==============================

function parseYahooOHLCV(data) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("no result");
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if ([o, h, l, c].some((x) => x === null || x === undefined)) continue;
    bars.push({ t: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: v || 0 });
  }
  if (!bars.length) throw new Error("no bars");
  return bars;
}
async function fetchYahooOnce(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  try {
    const res = await fetchWithTimeout(url, { mode: "cors" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return parseYahooOHLCV(await res.json());
  } catch (e) {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error(`proxy http ${res.status}`);
    return parseYahooOHLCV(await res.json());
  }
}
async function fetchYahoo(symbol, range, interval) {
  try {
    return await fetchYahooOnce(symbol, range, interval);
  } catch (e) {
    if (range !== "1y") return await fetchYahooOnce(symbol, "1y", interval);
    throw e;
  }
}
async function fetchDaily(symbol) {
  return { bars: await fetchYahoo(symbol, "3y", "1d") };
}

async function finnhubFetch(url) {
  const res = await fetchWithTimeout(url);
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`finnhub auth ${res.status}`);
    err.finnhubAuth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`finnhub http ${res.status}`);
  return res.json();
}
async function fetchMetrics(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${apiKey}`;
  return finnhubFetch(url);
}
async function fetchEarningsHistory(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const data = await finnhubFetch(url);
  return Array.isArray(data) ? data : [];
}
async function fetchRecommendationTrend(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const data = await finnhubFetch(url);
  return Array.isArray(data) && data.length ? data[0] : null;
}
async function fetchInsiderTransactions(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const data = await finnhubFetch(url);
  return Array.isArray(data?.data) ? data.data : [];
}
async function fetchPeers(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const data = await finnhubFetch(url);
  return Array.isArray(data) ? data.filter((s) => s !== symbol).slice(0, 4) : [];
}
async function fetchPeerSnapshot(symbol, apiKey) {
  try {
    const [quoteRes, metricRes] = await Promise.all([
      finnhubFetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`),
      fetchMetrics(symbol, apiKey).catch(() => null),
    ]);
    const m = metricRes?.metric || {};
    return {
      symbol,
      price: quoteRes.c,
      peTTM: pickMetric(m, ["peTTM", "peBasicExclExtraTTM", "peExclExtraTTM"]),
      psTTM: pickMetric(m, ["psTTM", "psAnnual"]),
      pegRatio: pickMetric(m, ["pegRatio"]),
    };
  } catch (e) {
    return null;
  }
}

// ============================== HELPERS ==============================

function pickMetric(metric, keys) {
  if (!metric) return null;
  for (const k of keys) if (metric[k] !== undefined && metric[k] !== null) return metric[k];
  return null;
}
function pickSeries(series, keys) {
  if (!series) return null;
  for (const k of keys) {
    const arr = series[k];
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return null;
}
function last4(seriesArr) {
  if (!seriesArr) return [];
  const sorted = [...seriesArr].sort((a, b) => new Date(a.period) - new Date(b.period));
  return sorted.slice(-4);
}
function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "N/A";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtBig(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return fmt(n, 0);
}
function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== undefined && arr[i] !== null) return arr[i];
  return null;
}
function smaAt(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function cmfCalc(bars, period = 20) {
  if (bars.length < period) return null;
  const slice = bars.slice(bars.length - period);
  let mfv = 0, vol = 0;
  for (const b of slice) {
    const range = b.high - b.low;
    const mfm = range === 0 ? 0 : ((b.close - b.low) - (b.high - b.close)) / range;
    mfv += mfm * b.volume;
    vol += b.volume;
  }
  return vol ? mfv / vol : null;
}
function obvTrend(bars, lookback = 40) {
  const out = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[i - 1];
    if (bars[i].close > bars[i - 1].close) out.push(prev + bars[i].volume);
    else if (bars[i].close < bars[i - 1].close) out.push(prev - bars[i].volume);
    else out.push(prev);
  }
  if (out.length < lookback + 1) return null;
  return { slopeUp: out[out.length - 1] > out[out.length - 1 - lookback] };
}
function aggregateWeekly(bars) {
  const map = new Map();
  for (const b of bars) {
    const d = new Date(b.t);
    const day = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, t: b.t });
    else {
      const w = map.get(key);
      w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low); w.close = b.close; w.volume += b.volume;
    }
  }
  return Array.from(map.values());
}
function periodReturn(bars, days) {
  if (bars.length < days + 1) return null;
  const now = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - days].close;
  return ((now - then) / then) * 100;
}

// ============================== SCORING ==============================

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function investmentRating(score) {
  if (score > 85) return "Strong Buy";
  if (score >= 70) return "Buy";
  if (score >= 45) return "Hold";
  return "Avoid";
}

// ============================== UI HELPERS ==============================

const TAG_ICON = { bullish: TrendingUp, bearish: TrendingDown, neutral: Minus, unavailable: Info };

function ReadingGrid({ readings }) {
  const [activeHelp, setActiveHelp] = useState(null);
  return (
    <div className="iv-grid">
      {readings.map((r, i) => {
        const Icon = TAG_ICON[r.tag] || Minus;
        const glossary = matchGlossary(r.name);
        return (
          <div className="iv-card" key={i}>
            <div className="iv-card-top">
              <span className="iv-card-name">
                {r.name}
                {glossary && (
                  <button className="iv-help-btn" onClick={() => setActiveHelp(glossary)} aria-label={`What is ${r.name}?`}>
                    <HelpCircle size={12} />
                  </button>
                )}
              </span>
              <span className={`iv-tag-icon ${r.tag}`}>
                <Icon size={13} />
              </span>
            </div>
            <div className="iv-card-val">{r.value}</div>
            <div className="iv-card-note">{r.note}</div>
          </div>
        );
      })}
      <HelpModal entry={activeHelp} onClose={() => setActiveHelp(null)} />
    </div>
  );
}
function ScoreBar({ label, score, max }) {
  const pct = (score / max) * 100;
  const color = pct >= 70 ? "#5FCBA0" : pct >= 45 ? "#FFB454" : "#E8697A";
  return (
    <div className="iv-scorebar-row">
      <span className="iv-scorebar-label">{label}</span>
      <div className="iv-scorebar-track">
        <div className="iv-scorebar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="iv-scorebar-val" style={{ color }}>{fmt(score, 0)}/{max}</span>
    </div>
  );
}

// ============================== COMPONENT ==============================

export default function Invest() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const apiKeyRef = useRef("");

  useEffect(() => {
    const saved = readLocal(LAST_SYMBOL_KEY);
    if (saved) setQuery(saved);
  }, []);

  const handleAnalyze = async (e) => {
    e.preventDefault();
    const symbol = query.trim().toUpperCase();
    if (!symbol) return;
    setLoading(true);
    setError("");
    setResult(null);

    const cached = analysisCache.get(symbol);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setResult(cached.data);
      setLoading(false);
      writeLocal(LAST_SYMBOL_KEY, symbol);
      return;
    }

    apiKeyRef.current = readLocal(APIKEY_KEY) || "";
    const apiKey = apiKeyRef.current;

    if (!apiKey) {
      setError("The Invest tab needs a Finnhub API key for quarterly financials, earnings history, peers, and institutional data — add a free one from the Watchlist tab's \"connect data\" button, then try again.");
      setLoading(false);
      return;
    }

    try {
      const [dailyRes, spyRes, metricsRes, earningsHist, recTrend, insiders, peerSymbols] = await Promise.all([
        fetchDaily(symbol),
        fetchDaily("SPY").catch(() => null),
        fetchMetrics(symbol, apiKey).catch((e) => (e.finnhubAuth ? "AUTH" : null)),
        fetchEarningsHistory(symbol, apiKey).catch((e) => (e.finnhubAuth ? "AUTH" : [])),
        fetchRecommendationTrend(symbol, apiKey).catch((e) => (e.finnhubAuth ? "AUTH" : null)),
        fetchInsiderTransactions(symbol, apiKey).catch((e) => (e.finnhubAuth ? "AUTH" : [])),
        fetchPeers(symbol, apiKey).catch(() => []),
      ]);

      const bars = dailyRes.bars;
      if (bars.length < 210) throw new Error(`Only ${bars.length} days of history returned — need ~210 for a reliable 200-day moving average.`);
      const closes = bars.map((b) => b.close);
      const price = closes[closes.length - 1];
      const metric = metricsRes && metricsRes !== "AUTH" ? metricsRes.metric : null;
      const series = metricsRes && metricsRes !== "AUTH" ? metricsRes.series?.quarterly : null;

      const peerSnaps = peerSymbols.length ? (await Promise.all(peerSymbols.map((p) => fetchPeerSnapshot(p, apiKey)))).filter(Boolean) : [];

      // ================= 1. FINANCIAL PERFORMANCE (LAST 4 QUARTERS) =================
      const epsHistory = last4(earningsHist === "AUTH" ? [] : earningsHist.map((e) => ({ period: e.period, actual: e.actual, estimate: e.estimate, surprisePercent: e.surprisePercent })));
      const epsGrowthYoY = epsHistory.length >= 1 && epsHistory[epsHistory.length - 1].actual !== null
        ? null // Finnhub /stock/earnings doesn't give same-quarter-last-year directly; use QoQ + surprise trend instead
        : null;
      let epsQoQGrowth = null;
      if (epsHistory.length >= 2) {
        const a = epsHistory[epsHistory.length - 2].actual, b = epsHistory[epsHistory.length - 1].actual;
        if (a && b !== null && a !== 0) epsQoQGrowth = ((b - a) / Math.abs(a)) * 100;
      }
      const netMarginSeries = last4(pickSeries(series, ["netMargin"]));
      const grossMarginSeries = last4(pickSeries(series, ["grossMargin"]));
      const operatingMarginSeries = last4(pickSeries(series, ["operatingMargin"]));
      const roeSeries = last4(pickSeries(series, ["roe", "roeTTM"]));
      const roicSeries = last4(pickSeries(series, ["roic", "roiTTM"]));
      const currentRatioSeries = last4(pickSeries(series, ["currentRatio"]));
      const dToESeries = last4(pickSeries(series, ["totalDebtToEquity", "longTermDebtToEquity"]));

      const roeTTM = pickMetric(metric, ["roeTTM", "roeRfy"]);
      const roicTTM = pickMetric(metric, ["roicTTM", "roiTTM"]);
      const debtEquity = pickMetric(metric, ["totalDebt/totalEquityAnnual", "totalDebt/totalEquityQuarterly"]);
      const currentRatio = pickMetric(metric, ["currentRatioAnnual", "currentRatioQuarterly"]);
      const fcfPerShare = pickMetric(metric, ["freeCashFlowPerShareTTM", "freeCashFlowTTM"]);
      const netMarginTTM = pickMetric(metric, ["netProfitMarginTTM", "netProfitMarginAnnual"]);
      const grossMarginTTM = pickMetric(metric, ["grossMarginTTM", "grossMarginAnnual"]);
      const operatingMarginTTM = pickMetric(metric, ["operatingMarginTTM", "operatingMarginAnnual"]);
      const epsGrowthTTM = pickMetric(metric, ["epsGrowthTTMYoy", "epsGrowth3Y", "epsGrowth5Y"]);
      const revGrowthTTM = pickMetric(metric, ["revenueGrowthTTMYoy", "revenueGrowth3Y", "revenueGrowth5Y"]);

      const seriesTrendTag = (arr) => {
        if (!arr || arr.length < 2) return "neutral";
        return arr[arr.length - 1].v > arr[0].v ? "bullish" : arr[arr.length - 1].v < arr[0].v ? "bearish" : "neutral";
      };
      const financialReadings = [
        { name: "Revenue Growth (TTM YoY)", value: revGrowthTTM !== null ? `${fmt(revGrowthTTM, 1)}%` : "N/A", tag: revGrowthTTM !== null ? (revGrowthTTM > 10 ? "bullish" : revGrowthTTM < 0 ? "bearish" : "neutral") : "unavailable", note: "Quarterly QoQ revenue series isn't reliably exposed on Finnhub's free tier for most tickers — TTM YoY shown instead" },
        { name: "EPS Growth (QoQ, latest)", value: epsQoQGrowth !== null ? `${fmt(epsQoQGrowth, 1)}%` : "N/A", tag: epsQoQGrowth !== null ? (epsQoQGrowth > 0 ? "bullish" : "bearish") : "unavailable", note: epsHistory.length ? `From ${epsHistory.length} quarters of reported EPS (Finnhub)` : "Earnings history unavailable" },
        { name: "Gross Margin (4Q trend)", value: grossMarginSeries.length ? grossMarginSeries.map((p) => fmt(p.v, 1)).join(" → ") + "%" : (grossMarginTTM !== null ? `${fmt(grossMarginTTM, 1)}% (TTM only)` : "N/A"), tag: grossMarginSeries.length ? seriesTrendTag(grossMarginSeries) : "unavailable", note: "Oldest → newest of last 4 quarters, where available" },
        { name: "Operating Margin (4Q trend)", value: operatingMarginSeries.length ? operatingMarginSeries.map((p) => fmt(p.v, 1)).join(" → ") + "%" : (operatingMarginTTM !== null ? `${fmt(operatingMarginTTM, 1)}% (TTM only)` : "N/A"), tag: operatingMarginSeries.length ? seriesTrendTag(operatingMarginSeries) : "unavailable", note: "" },
        { name: "Net Margin (4Q trend)", value: netMarginSeries.length ? netMarginSeries.map((p) => fmt(p.v, 1)).join(" → ") + "%" : (netMarginTTM !== null ? `${fmt(netMarginTTM, 1)}% (TTM only)` : "N/A"), tag: netMarginSeries.length ? seriesTrendTag(netMarginSeries) : "unavailable", note: "" },
        { name: "Free Cash Flow (TTM/share)", value: fcfPerShare !== null ? fmt(fcfPerShare, 2) : "N/A", tag: fcfPerShare !== null ? (fcfPerShare > 0 ? "bullish" : "bearish") : "unavailable", note: "Quarterly FCF trend isn't exposed by Finnhub's free-tier ratio series — single TTM figure only" },
        { name: "Operating Cash Flow Trend", value: "Not available", tag: "unavailable", note: "Requires parsing raw cash-flow statements — not exposed as a clean free-tier time series" },
        { name: "ROE (4Q trend)", value: roeSeries.length ? roeSeries.map((p) => fmt(p.v, 1)).join(" → ") + "%" : (roeTTM !== null ? `${fmt(roeTTM, 1)}% (TTM only)` : "N/A"), tag: roeSeries.length ? seriesTrendTag(roeSeries) : (roeTTM !== null ? (roeTTM > 15 ? "bullish" : "neutral") : "unavailable"), note: "" },
        { name: "ROIC (4Q trend)", value: roicSeries.length ? roicSeries.map((p) => fmt(p.v, 1)).join(" → ") + "%" : (roicTTM !== null ? `${fmt(roicTTM, 1)}% (TTM only)` : "N/A"), tag: roicSeries.length ? seriesTrendTag(roicSeries) : (roicTTM !== null ? (roicTTM > 10 ? "bullish" : "neutral") : "unavailable"), note: "" },
        { name: "Debt-to-Equity", value: debtEquity !== null ? fmt(debtEquity, 2) : "N/A", tag: debtEquity !== null ? (debtEquity < 0.5 ? "bullish" : debtEquity > 1.5 ? "bearish" : "neutral") : "unavailable", note: dToESeries.length ? `4Q trend: ${dToESeries.map((p) => fmt(p.v, 2)).join(" → ")}` : "" },
        { name: "Current Ratio", value: currentRatio !== null ? fmt(currentRatio, 2) : "N/A", tag: currentRatio !== null ? (currentRatio > 1.5 ? "bullish" : currentRatio < 1 ? "bearish" : "neutral") : "unavailable", note: currentRatioSeries.length ? `4Q trend: ${currentRatioSeries.map((p) => fmt(p.v, 2)).join(" → ")}` : "" },
        { name: "Buybacks / Dilution", value: "Not available", tag: "unavailable", note: "Requires historical shares-outstanding data — not exposed by Finnhub's free tier as a time series" },
      ];

      // ================= 2. GROWTH QUALITY =================
      const growthReadings = [
        { name: "Growth Trajectory", value: epsQoQGrowth !== null ? (epsQoQGrowth > 0 ? "Accelerating (latest Q EPS up QoQ)" : "Slowing (latest Q EPS down QoQ)") : "N/A", tag: epsQoQGrowth !== null ? (epsQoQGrowth > 0 ? "bullish" : "bearish") : "unavailable", note: "Based on trailing 2 quarters of reported EPS only — a limited proxy for the full growth picture" },
        { name: "Organic vs. Acquisition Growth", value: "Not available", tag: "unavailable", note: "Requires reading M&A disclosures in the 10-Q/10-K — no structured API exposes this" },
        { name: "Customer Growth", value: "Not available", tag: "unavailable", note: "Company-specific KPI, disclosed only in shareholder letters/earnings calls" },
        { name: "Retention Rates", value: "Not available", tag: "unavailable", note: "Not disclosed by most companies in structured form; SaaS/subscription businesses sometimes report NRR in earnings calls only" },
        { name: "Geographic Growth", value: "Not available", tag: "unavailable", note: "Requires segment reporting from the 10-K — not exposed by free market-data APIs" },
        { name: "Product Segment Performance", value: "Not available", tag: "unavailable", note: "Same — segment-level revenue/margin breakdowns require reading the filing directly" },
      ];

      // ================= 3. MANAGEMENT =================
      const validEarnings = (earningsHist === "AUTH" ? [] : earningsHist).filter((e) => e.surprisePercent !== null && e.surprisePercent !== undefined);
      const recentSurprises = validEarnings.slice(0, 4);
      const beatRate = recentSurprises.length ? recentSurprises.filter((e) => e.surprisePercent > 0).length / recentSurprises.length : null;
      const avgSurprise = recentSurprises.length ? recentSurprises.reduce((a, e) => a + e.surprisePercent, 0) / recentSurprises.length : null;
      const managementReadings = [
        {
          name: "Guidance Accuracy (EPS beat rate)",
          value: beatRate !== null ? `${fmt(beatRate * 100, 0)}% of last ${recentSurprises.length}Q beat estimates` : "N/A",
          tag: beatRate !== null ? (beatRate >= 0.75 ? "bullish" : beatRate <= 0.25 ? "bearish" : "neutral") : "unavailable",
          note: avgSurprise !== null ? `Average surprise ${fmt(avgSurprise, 1)}%` : "Earnings history unavailable",
        },
        { name: "Execution Consistency", value: recentSurprises.length >= 3 ? (recentSurprises.every((e) => e.surprisePercent > -5) ? "Consistent — no large misses" : "Inconsistent — at least one large miss") : "N/A", tag: recentSurprises.length >= 3 ? (recentSurprises.every((e) => e.surprisePercent > -5) ? "bullish" : "bearish") : "unavailable", note: "Flags any quarter missing estimates by more than 5%" },
        { name: "Capital Allocation Quality", value: fcfPerShare !== null && debtEquity !== null ? (fcfPerShare > 0 && debtEquity < 1 ? "Reasonable — positive FCF, moderate leverage" : "Mixed signals") : "N/A", tag: fcfPerShare !== null && debtEquity !== null ? (fcfPerShare > 0 && debtEquity < 1 ? "bullish" : "neutral") : "unavailable", note: "Limited proxy from FCF/share + leverage only — doesn't capture M&A or buyback timing quality" },
        { name: "Insider Buying/Selling", value: "See Institutional Activity section", tag: "neutral", note: "" },
        { name: "Earnings Call Commentary", value: "Not available", tag: "unavailable", note: "Requires a transcript data source (e.g. paid transcript APIs) — see the News tab for recent headlines instead" },
      ];

      // ================= 4. COMPETITIVE POSITION =================
      const marginStable = grossMarginSeries.length >= 2 ? Math.abs(grossMarginSeries[grossMarginSeries.length - 1].v - grossMarginSeries[0].v) < 2 : null;
      const marginExpanding = grossMarginSeries.length >= 2 ? grossMarginSeries[grossMarginSeries.length - 1].v > grossMarginSeries[0].v : null;
      const competitiveReadings = [
        {
          name: "Margin Stability (pricing power proxy)",
          value: grossMarginSeries.length >= 2 ? (marginExpanding ? "Expanding gross margin over 4Q" : marginStable ? "Stable gross margin over 4Q" : "Compressing gross margin over 4Q") : "N/A",
          tag: grossMarginSeries.length >= 2 ? (marginExpanding ? "bullish" : marginStable ? "neutral" : "bearish") : "unavailable",
          note: "Indirect proxy only — expanding/stable margins under competitive pressure suggest some pricing power, but this isn't a substitute for real moat analysis",
        },
        { name: "Economic Moat", value: "Not available", tag: "unavailable", note: "Requires qualitative analysis (brand, switching costs, network effects, cost advantage) — not derivable from market data" },
        { name: "Market Share", value: "Not available", tag: "unavailable", note: "Requires industry research reports not exposed by any free API" },
        { name: "Pricing Power (direct)", value: "Not available", tag: "unavailable", note: "Margin trend above is the closest computable proxy" },
        { name: "Industry Trends", value: "See Macro/Sector Rotation in Deep Dive tab", tag: "neutral", note: "" },
      ];

      // ================= 5. VALUATION =================
      const forwardPE = pickMetric(metric, ["peForward", "forwardPE"]);
      const peTTM = pickMetric(metric, ["peTTM", "peBasicExclExtraTTM", "peExclExtraTTM"]);
      const pegRatio = pickMetric(metric, ["pegRatio"]) ?? (peTTM && epsGrowthTTM && epsGrowthTTM > 0 ? peTTM / epsGrowthTTM : null);
      const evEbitda = pickMetric(metric, ["evEbitdaTTM", "evEbitda"]);
      const priceSales = pickMetric(metric, ["psTTM", "psAnnual"]);
      const peerAvgPE = peerSnaps.length ? peerSnaps.filter((p) => p.peTTM).reduce((a, p, _, arr) => a + p.peTTM / arr.length, 0) : null;
      const peerAvgPS = peerSnaps.length ? peerSnaps.filter((p) => p.psTTM).reduce((a, p, _, arr) => a + p.psTTM / arr.length, 0) : null;

      const valuationReadings = [
        { name: "Forward P/E", value: forwardPE !== null ? fmt(forwardPE, 1) : "N/A", tag: "neutral", note: forwardPE === null ? "Not provided by Finnhub free tier for this ticker" : "" },
        { name: "Trailing P/E (TTM)", value: peTTM !== null ? fmt(peTTM, 1) : "N/A", tag: "neutral", note: peerAvgPE !== null ? `Peer average: ${fmt(peerAvgPE, 1)}` : "" },
        { name: "PEG Ratio", value: pegRatio !== null ? fmt(pegRatio, 2) : "N/A", tag: pegRatio !== null ? (pegRatio < 1 ? "bullish" : pegRatio > 2 ? "bearish" : "neutral") : "unavailable", note: pegRatio !== null ? (pegRatio < 1 ? "Growth-adjusted valuation looks attractive (Peter Lynch's PEG<1 heuristic)" : "") : "" },
        { name: "EV/EBITDA", value: evEbitda !== null ? fmt(evEbitda, 1) : "N/A", tag: "neutral", note: "" },
        { name: "Price/Sales (TTM)", value: priceSales !== null ? fmt(priceSales, 2) : "N/A", tag: "neutral", note: peerAvgPS !== null ? `Peer average: ${fmt(peerAvgPS, 2)}` : "" },
        {
          name: "Peer Comparison",
          value: peerSnaps.length ? peerSnaps.map((p) => `${p.symbol} ${p.peTTM ? fmt(p.peTTM, 1) + "x" : "N/A"}`).join(", ") : "N/A",
          tag: peerAvgPE !== null && peTTM !== null ? (peTTM < peerAvgPE ? "bullish" : "bearish") : "unavailable",
          note: peerAvgPE !== null && peTTM !== null ? `Trading ${peTTM < peerAvgPE ? "below" : "above"} peer-average P/E` : "Finnhub peers endpoint returned no comparable data",
        },
      ];
      const valuationVerdict = peTTM === null ? "Unknown" : peTTM < 15 ? "Cheap" : peTTM < 28 ? "Fair" : "Expensive";

      // ================= 6. RISKS =================
      const riskReadings = [
        { name: "Debt Risk", value: debtEquity !== null ? (debtEquity > 1.5 ? "Elevated leverage" : debtEquity > 0.7 ? "Moderate leverage" : "Low leverage") : "N/A", tag: debtEquity !== null ? (debtEquity > 1.5 ? "bearish" : debtEquity > 0.7 ? "neutral" : "bullish") : "unavailable", note: currentRatio !== null ? `Current ratio ${fmt(currentRatio, 2)}` : "" },
        { name: "Regulatory Risk", value: "Not available", tag: "unavailable", note: "Company- and sector-specific — check the News tab and recent 10-K risk-factors section" },
        { name: "Customer Concentration", value: "Not available", tag: "unavailable", note: "Disclosed (if material) in the 10-K's risk factors, not in structured market data" },
        { name: "Macroeconomic Risk", value: "See Deep Dive tab's Macro section", tag: "neutral", note: "Rates, dollar, oil, VIX, sector rotation" },
        { name: "Technology Disruption Risk", value: "Not available", tag: "unavailable", note: "Qualitative judgment — not derivable from market data" },
      ];

      // ================= 7. INSTITUTIONAL ACTIVITY =================
      const institutionalReadings = [];
      if (Array.isArray(insiders) && insiders.length) {
        const recent = insiders.slice(0, 20);
        const buyShares = recent.filter((t) => t.transactionCode === "P" || t.change > 0).reduce((a, t) => a + Math.abs(t.change || 0), 0);
        const sellShares = recent.filter((t) => t.transactionCode === "S" || t.change < 0).reduce((a, t) => a + Math.abs(t.change || 0), 0);
        institutionalReadings.push({ name: "Insider Transactions", value: `${fmtBig(buyShares)} bought / ${fmtBig(sellShares)} sold`, tag: buyShares > sellShares ? "bullish" : sellShares > buyShares ? "bearish" : "neutral", note: "Real SEC Form 4 data — most recent filings" });
      } else if (insiders === "AUTH") {
        institutionalReadings.push({ name: "Insider Transactions", value: "Not on your Finnhub plan", tag: "unavailable", note: "Endpoint returned 401/403" });
      } else {
        institutionalReadings.push({ name: "Insider Transactions", value: "No recent filings", tag: "unavailable", note: "" });
      }
      if (recTrend && recTrend !== "AUTH") {
        const bullish = recTrend.strongBuy + recTrend.buy, bearish = recTrend.sell + recTrend.strongSell;
        institutionalReadings.push({ name: "Analyst Sentiment (proxy for institutional confidence)", value: `${recTrend.strongBuy}SB/${recTrend.buy}B/${recTrend.hold}H/${recTrend.sell}S/${recTrend.strongSell}SS`, tag: bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral", note: `Period ${recTrend.period}` });
      } else {
        institutionalReadings.push({ name: "Analyst Sentiment", value: recTrend === "AUTH" ? "Not on your Finnhub plan" : "N/A", tag: "unavailable", note: "" });
      }
      institutionalReadings.push(
        { name: "Hedge Fund Ownership Trend", value: "Not available", tag: "unavailable", note: "13F-derived hedge fund position data requires a paid aggregator (e.g. WhaleWisdom, Fintel)" },
        { name: "Mutual Fund Ownership", value: "Not available", tag: "unavailable", note: "Same — requires a paid holdings-data provider" },
        { name: "Dark Pool Activity", value: "Not available", tag: "unavailable", note: "Requires a paid dark-pool print feed — not accessible via free APIs" }
      );
      const instScoreable = institutionalReadings.filter((r) => r.tag !== "unavailable");

      // ================= 8. TECHNICAL HEALTH (LONG-TERM) =================
      const sma50 = smaAt(closes, 50), sma100 = smaAt(closes, 100), sma200 = smaAt(closes, 200);
      const weeklyBars = aggregateWeekly(bars);
      const weeklyCloses = weeklyBars.map((b) => b.close);
      const weeklyEma10 = lastDefined(emaSeries(weeklyCloses, Math.min(10, Math.floor(weeklyCloses.length / 2))));
      const weeklyTrendTag = weeklyCloses.length > 10 ? (weeklyCloses[weeklyCloses.length - 1] > weeklyEma10 ? "bullish" : "bearish") : "neutral";
      const spyBars = spyRes?.bars || [];
      let rs6mo = null;
      if (spyBars.length > 126) {
        const stockRet = periodReturn(bars, 126);
        const spyRet = periodReturn(spyBars, 126);
        if (stockRet !== null && spyRet !== null) rs6mo = stockRet - spyRet;
      }
      const cmf = cmfCalc(bars, 20);
      const obv = obvTrend(bars, 40);
      const relVolLong = bars.length >= 21 ? bars[bars.length - 1].volume / (bars.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20) : null;

      const technicalReadings = [
        { name: "50-Day SMA", value: sma50 !== null ? fmt(sma50) : "N/A", tag: sma50 !== null ? (price > sma50 ? "bullish" : "bearish") : "unavailable", note: "" },
        { name: "100-Day SMA", value: sma100 !== null ? fmt(sma100) : "N/A", tag: sma100 !== null ? (price > sma100 ? "bullish" : "bearish") : "unavailable", note: "" },
        { name: "200-Day SMA", value: sma200 !== null ? fmt(sma200) : "N/A", tag: sma200 !== null ? (price > sma200 ? "bullish" : "bearish") : "unavailable", note: "Primary long-term trend filter" },
        { name: "Relative Strength vs S&P 500 (6mo)", value: rs6mo !== null ? `${rs6mo >= 0 ? "+" : ""}${fmt(rs6mo, 1)}pp` : "N/A", tag: rs6mo !== null ? (rs6mo > 0 ? "bullish" : "bearish") : "unavailable", note: rs6mo !== null ? (rs6mo > 0 ? "Outperforming the market" : "Underperforming the market") : "SPY data unavailable" },
        { name: "Volume Trend", value: relVolLong !== null ? `${fmt(relVolLong, 2)}x avg` : "N/A", tag: relVolLong !== null ? (relVolLong > 1.3 ? "bullish" : "neutral") : "unavailable", note: "" },
        { name: "Accumulation / Distribution", value: obv && cmf !== null ? (obv.slopeUp && cmf > 0 ? "Accumulation" : !obv.slopeUp && cmf < 0 ? "Distribution" : "Mixed") : "N/A", tag: obv && cmf !== null ? (obv.slopeUp && cmf > 0 ? "bullish" : !obv.slopeUp && cmf < 0 ? "bearish" : "neutral") : "unavailable", note: "OBV trend (40d) + CMF (20d) sign combined" },
        { name: "Weekly Trend", value: weeklyTrendTag === "bullish" ? "Uptrend" : weeklyTrendTag === "bearish" ? "Downtrend" : "N/A", tag: weeklyTrendTag, note: "Weekly close vs weekly short EMA" },
      ];

      // ================= 9. AI INVESTMENT SCORE =================
      const scoreFinancial = clamp(
        10 +
          (debtEquity !== null ? (debtEquity < 0.5 ? 4 : debtEquity < 1 ? 2 : debtEquity > 2 ? -4 : 0) : 0) +
          (currentRatio !== null ? (currentRatio > 1.5 ? 3 : currentRatio < 1 ? -3 : 0) : 0) +
          (fcfPerShare !== null ? (fcfPerShare > 0 ? 3 : -3) : 0),
        0, 20
      );
      const scoreGrowth = clamp(
        10 +
          (revGrowthTTM !== null ? clamp(revGrowthTTM / 4, -6, 6) : 0) +
          (epsQoQGrowth !== null ? clamp(epsQoQGrowth / 8, -4, 4) : 0),
        0, 20
      );
      const scoreProfitability = clamp(
        7.5 +
          (netMarginTTM !== null ? clamp((netMarginTTM - 10) / 5, -4, 4) : 0) +
          (roeTTM !== null ? clamp((roeTTM - 10) / 4, -3.5, 3.5) : 0),
        0, 15
      );
      const scoreValuation = clamp(
        7.5 +
          (pegRatio !== null ? clamp((1.5 - pegRatio) * 4, -6, 6) : 0) +
          (peerAvgPE !== null && peTTM !== null ? (peTTM < peerAvgPE ? 1.5 : -1.5) : 0),
        0, 15
      );
      const scoreCompetitive = clamp(5 + (marginExpanding === true ? 3 : marginExpanding === false ? -3 : 0) + (marginStable ? 2 : 0), 0, 10);
      const instBullish = instScoreable.filter((r) => r.tag === "bullish").length, instBearish = instScoreable.filter((r) => r.tag === "bearish").length;
      const scoreInstitutional = instScoreable.length ? clamp(5 + (instBullish - instBearish) * 2.5, 0, 10) : 5;
      const scoreTechnical = clamp(
        5 +
          (sma200 !== null ? (price > sma200 ? 2 : -2) : 0) +
          (rs6mo !== null ? clamp(rs6mo / 10, -2, 2) : 0) +
          (weeklyTrendTag === "bullish" ? 1 : weeklyTrendTag === "bearish" ? -1 : 0),
        0, 10
      );
      const totalScore = scoreFinancial + scoreGrowth + scoreProfitability + scoreValuation + scoreCompetitive + scoreInstitutional + scoreTechnical;
      const rating = investmentRating(totalScore);

      // ================= 10. FINAL RECOMMENDATION =================
      const fairMultiple = pegRatio !== null && epsGrowthTTM > 0 ? epsGrowthTTM : peerAvgPE !== null ? peerAvgPE : peTTM !== null ? peTTM : 20;
      const blendedFairMultiple = peerAvgPE !== null ? (fairMultiple + peerAvgPE) / 2 : fairMultiple;
      const epsTTM = peTTM !== null && peTTM !== 0 ? price / peTTM : null;
      const fairValue = epsTTM !== null ? blendedFairMultiple * epsTTM : null;
      const assumedGrowth = clamp(epsGrowthTTM !== null ? (epsGrowthTTM + 8) / 2 : 8, 2, 25) / 100;
      const terminalMultiple = clamp(blendedFairMultiple, 10, 35);
      const projectedEps5y = epsTTM !== null ? epsTTM * Math.pow(1 + assumedGrowth, 5) : null;
      const projectedPrice5y = projectedEps5y !== null ? projectedEps5y * terminalMultiple : null;
      const expectedAnnualReturn = projectedPrice5y !== null && price > 0 ? (Math.pow(projectedPrice5y / price, 1 / 5) - 1) * 100 : null;
      const confidenceLevel = clamp(40 + (instScoreable.length ? 10 : 0) + (peerSnaps.length ? 10 : 0) + (epsHistory.length >= 4 ? 15 : 0) + (Math.abs(totalScore - 50) > 20 ? 10 : 0), 20, 85);

      const catalysts = [];
      const risks = [];
      if (revGrowthTTM !== null && revGrowthTTM > 15) catalysts.push(`Revenue growing ${fmt(revGrowthTTM, 1)}% YoY (TTM) — durable top-line momentum.`);
      if (beatRate !== null && beatRate >= 0.75) catalysts.push(`Beat EPS estimates in ${fmt(beatRate * 100, 0)}% of the last ${recentSurprises.length} quarters — consistent execution.`);
      if (peTTM !== null && peerAvgPE !== null && peTTM < peerAvgPE) catalysts.push(`Trading at a discount to peer-average P/E (${fmt(peTTM, 1)}x vs ${fmt(peerAvgPE, 1)}x) — re-rating potential if execution continues.`);
      if (sma200 !== null && price > sma200) catalysts.push("Price above the 200-day SMA — long-term uptrend intact.");
      if (marginExpanding) catalysts.push("Gross margin expanding over the last 4 quarters — a sign of pricing power or operating leverage.");
      while (catalysts.length < 3) catalysts.push("See the News and Events tabs for company- and macro-specific catalysts not captured by this quantitative framework.");
      if (debtEquity !== null && debtEquity > 1.5) risks.push(`Elevated leverage (debt/equity ${fmt(debtEquity, 2)}) — sensitive to a higher-for-longer rate environment.`);
      if (beatRate !== null && beatRate <= 0.25) risks.push(`Missed EPS estimates in ${fmt((1 - beatRate) * 100, 0)}% of the last ${recentSurprises.length} quarters — execution risk.`);
      if (peTTM !== null && peerAvgPE !== null && peTTM > peerAvgPE * 1.3) risks.push(`Trading well above peer-average P/E (${fmt(peTTM, 1)}x vs ${fmt(peerAvgPE, 1)}x) — priced for perfection.`);
      if (sma200 !== null && price < sma200) risks.push("Price below the 200-day SMA — long-term trend is bearish.");
      if (!marginExpanding && marginExpanding !== null) risks.push("Gross margin compressing over the last 4 quarters — possible competitive or cost pressure.");
      while (risks.length < 3) risks.push("Idiosyncratic/regulatory risks aren't covered by this data — check the 10-K risk factors and recent News.");

      const reasonsToBuy = [
        revGrowthTTM !== null && revGrowthTTM > 10 ? `Revenue growing ${fmt(revGrowthTTM, 1)}% YoY` : null,
        beatRate !== null && beatRate >= 0.5 ? `Beat estimates in ${fmt(beatRate * 100, 0)}% of recent quarters` : null,
        pegRatio !== null && pegRatio < 1.5 ? `PEG of ${fmt(pegRatio, 2)} suggests growth-adjusted value` : null,
        sma200 !== null && price > sma200 ? "Long-term uptrend intact (above 200 SMA)" : null,
        instBullish > instBearish ? "Net-bullish signal from available institutional/analyst data" : null,
        marginExpanding ? "Expanding margins suggest pricing power" : null,
      ].filter(Boolean).slice(0, 5);
      while (reasonsToBuy.length < 5) reasonsToBuy.push("Insufficient distinguishing data for an additional reason — see the full report above for context.");

      const reasonsNotToBuy = [
        revGrowthTTM !== null && revGrowthTTM < 0 ? "Revenue is contracting YoY" : null,
        beatRate !== null && beatRate < 0.5 ? "Missed estimates in half or more of recent quarters" : null,
        pegRatio !== null && pegRatio > 2 ? `PEG of ${fmt(pegRatio, 2)} suggests rich valuation relative to growth` : null,
        sma200 !== null && price < sma200 ? "Long-term downtrend (below 200 SMA)" : null,
        debtEquity !== null && debtEquity > 1.5 ? `Elevated leverage (D/E ${fmt(debtEquity, 2)})` : null,
        !marginExpanding && marginExpanding !== null ? "Margins compressing over the last 4 quarters" : null,
      ].filter(Boolean).slice(0, 5);
      while (reasonsNotToBuy.length < 5) reasonsNotToBuy.push("No specific red flag found in this data alone — doesn't mean none exist, see Risks section.");

      const pullbackReasons = [];
      let accumulateVerdict;
      if (sma200 !== null && price > sma200 && totalScore >= 60 && (debtEquity === null || debtEquity < 1.5)) {
        accumulateVerdict = "Reasonable, if your thesis on the business hasn't changed";
        pullbackReasons.push("Long-term trend (200 SMA) is intact, so pullbacks are more likely to be within an uptrend than the start of a breakdown.");
        pullbackReasons.push(`Overall score of ${fmt(totalScore, 0)}/100 (${rating}) reflects reasonably solid fundamentals as measured here.`);
        if (debtEquity !== null) pullbackReasons.push(`Leverage is manageable (D/E ${fmt(debtEquity, 2)}), reducing solvency risk during a drawdown.`);
      } else {
        accumulateVerdict = "Caution warranted before adding on weakness";
        if (sma200 !== null && price < sma200) pullbackReasons.push("Price is below the 200-day SMA — a pullback here could be continuation of a downtrend, not a discount.");
        if (totalScore < 60) pullbackReasons.push(`Overall score of ${fmt(totalScore, 0)}/100 (${rating}) doesn't clearly support high-conviction accumulation.`);
        if (debtEquity !== null && debtEquity >= 1.5) pullbackReasons.push(`Elevated leverage (D/E ${fmt(debtEquity, 2)}) adds risk during periods of stress.`);
      }
      if (!pullbackReasons.length) pullbackReasons.push("Data is too limited to give a confident view either way — treat this as informational only.");

      const resultData = {
        symbol, price, rating, totalScore,
        scores: { financial: scoreFinancial, growth: scoreGrowth, profitability: scoreProfitability, valuation: scoreValuation, competitive: scoreCompetitive, institutional: scoreInstitutional, technical: scoreTechnical },
        financialReadings, growthReadings, managementReadings, competitiveReadings, valuationReadings, valuationVerdict,
        riskReadings, institutionalReadings, technicalReadings,
        fairValue, expectedAnnualReturn, confidenceLevel, catalysts: catalysts.slice(0, 6), risks: risks.slice(0, 6),
        reasonsToBuy, reasonsNotToBuy, accumulateVerdict, pullbackReasons,
        peerSnaps,
      };
      setResult(resultData);
      analysisCache.set(symbol, { data: resultData, at: Date.now() });
      writeLocal(LAST_SYMBOL_KEY, symbol);
    } catch (e) {
      setError(e?.message || `Couldn't complete the investment analysis for ${symbol}. Try again in a moment.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="iv-root">
      <style>{`
        .iv-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 50px; }
        .iv-header { padding: 22px 24px 6px; }
        .iv-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .iv-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .iv-search-row { padding: 16px 24px 6px; display: flex; gap: 10px; }
        .iv-search-box { flex: 1; max-width: 420px; display: flex; align-items: center; gap: 8px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 6px; padding: 0 12px; }
        .iv-search-box:focus-within { border-color: #FFB454; }
        .iv-search-box input { background: transparent; border: none; outline: none; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 10px 4px; width: 100%; }
        .iv-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 0 18px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; cursor: pointer; }
        .iv-btn:disabled { opacity: 0.6; }
        .iv-error { margin: 10px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .iv-loading { display: flex; align-items: center; gap: 8px; padding: 60px 24px; justify-content: center; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .iv-skel { background: linear-gradient(90deg, #1C1F25 25%, #24272E 37%, #1C1F25 63%); background-size: 400% 100%; animation: iv-shimmer 1.4s ease infinite; border-radius: 8px; border: 1px solid #2A2E36; }
        .iv-skel-summary { height: 90px; margin: 0 24px 22px; }
        .iv-skel-card { height: 76px; }
        @keyframes iv-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .iv-body { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 22px; }
        .iv-section-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.02em; margin: 0 0 8px; color: #FFB454; border-bottom: 1px solid #2A2E36; padding-bottom: 6px; }
        .iv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
        .iv-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 12px 13px; }
        .iv-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
        .iv-card-name { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
        .iv-help-btn { background: transparent; border: none; color: #5A5F68; cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
        .iv-help-btn:hover { color: #FFB454; }
        .iv-card-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #ADB1B9; margin-top: 3px; }
        .iv-card-note { font-size: 11px; color: #888E99; margin-top: 5px; line-height: 1.4; }
        .iv-tag-icon.bullish { color: #5FCBA0; } .iv-tag-icon.bearish { color: #E8697A; } .iv-tag-icon.neutral { color: #C99A4B; } .iv-tag-icon.unavailable { color: #5A5F68; }
        .iv-summary { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 12px; padding: 20px; display: flex; flex-wrap: wrap; gap: 22px; align-items: center; }
        .iv-sym { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 24px; }
        .iv-price { font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #ADB1B9; }
        .iv-rating { padding: 10px 20px; border-radius: 10px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 18px; }
        .iv-rating.buy { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .iv-rating.hold { background: rgba(201,154,75,0.14); color: #C99A4B; }
        .iv-rating.avoid { background: rgba(232,105,122,0.14); color: #E8697A; }
        .iv-overall { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #888E99; }
        .iv-scorebar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .iv-scorebar-label { width: 140px; font-size: 12px; color: #ADB1B9; font-family: 'IBM Plex Sans Condensed', sans-serif; }
        .iv-scorebar-track { flex: 1; height: 8px; background: #0D0E11; border-radius: 4px; overflow: hidden; }
        .iv-scorebar-fill { height: 100%; border-radius: 4px; }
        .iv-scorebar-val { width: 46px; text-align: right; font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; }
        .iv-reasons-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 600px) { .iv-reasons-cols { grid-template-columns: 1fr; } }
        .iv-reasons-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .iv-reason-item { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.5; padding: 8px 10px; border-radius: 6px; background: #1C1F25; border: 1px solid #2A2E36; }
        .iv-disclaimer { font-size: 10.5px; color: #5A5F68; line-height: 1.6; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 14px; }
        .iv-valuation-badge { display: inline-block; padding: 3px 10px; border-radius: 5px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 12px; }
        .iv-valuation-badge.Cheap { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .iv-valuation-badge.Fair { background: rgba(201,154,75,0.14); color: #C99A4B; }
        .iv-valuation-badge.Expensive { background: rgba(232,105,122,0.14); color: #E8697A; }
        .iv-valuation-badge.Unknown { background: rgba(90,95,104,0.2); color: #888E99; }
        .iv-accumulate-box { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 18px; }
        .iv-accumulate-verdict { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; color: #FFB454; margin-bottom: 8px; }
      `}</style>

      <div className="iv-header">
        <h1>INVEST</h1>
        <p>Long-term (1–5yr) fundamental research: last 4 quarters, peer valuation, long-term technicals, AI investment score</p>
      </div>

      <form className="iv-search-row" onSubmit={handleAnalyze}>
        <div className="iv-search-box">
          <Search size={15} color="#5A5F68" />
          <input placeholder="Enter a ticker, e.g. AAPL" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={10} />
        </div>
        <button className="iv-btn" type="submit" disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          {loading ? "Analyzing" : "Invest Analysis"}
        </button>
      </form>

      {error && (
        <div className="iv-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}
      {loading && (
        <>
          <div className="iv-loading">
            <Loader2 size={16} className="spin" /> pulling quarterly financials, earnings history, peers, and long-term price data…
          </div>
          <div className="iv-skel iv-skel-summary" />
          <div className="iv-grid" style={{ padding: "0 24px" }}>
            {Array.from({ length: 8 }).map((_, i) => <div className="iv-skel iv-skel-card" key={i} />)}
          </div>
        </>
      )}

      {result && !loading && (
        <div className="iv-body">
          <div className="iv-summary">
            <div>
              <div className="iv-sym">{result.symbol}</div>
              <div className="iv-price">${fmt(result.price)}</div>
            </div>
            <div className={`iv-rating ${result.rating.includes("Buy") ? "buy" : result.rating === "Hold" ? "hold" : "avoid"}`}>{result.rating}</div>
            <div className="iv-overall">
              AI Investment Score: {fmt(result.totalScore, 0)}/100
              <br />
              Fair Value Estimate: {result.fairValue !== null ? `$${fmt(result.fairValue)}` : "N/A"}
              <br />
              Expected Annual Return (5yr): {result.expectedAnnualReturn !== null ? `${fmt(result.expectedAnnualReturn, 1)}%` : "N/A"} · Confidence: {fmt(result.confidenceLevel, 0)}%
            </div>
          </div>

          <div>
            <div className="iv-section-title">1 · Financial Performance (Last 4 Quarters)</div>
            <ReadingGrid readings={result.financialReadings} />
          </div>
          <div>
            <div className="iv-section-title">2 · Growth Quality</div>
            <ReadingGrid readings={result.growthReadings} />
          </div>
          <div>
            <div className="iv-section-title">3 · Management</div>
            <ReadingGrid readings={result.managementReadings} />
          </div>
          <div>
            <div className="iv-section-title">4 · Competitive Position</div>
            <ReadingGrid readings={result.competitiveReadings} />
          </div>
          <div>
            <div className="iv-section-title">
              5 · Valuation — <span className={`iv-valuation-badge ${result.valuationVerdict}`}>{result.valuationVerdict}</span>
            </div>
            <ReadingGrid readings={result.valuationReadings} />
          </div>
          <div>
            <div className="iv-section-title">6 · Risks</div>
            <ReadingGrid readings={result.riskReadings} />
          </div>
          <div>
            <div className="iv-section-title">7 · Institutional Activity</div>
            <ReadingGrid readings={result.institutionalReadings} />
          </div>
          <div>
            <div className="iv-section-title">8 · Technical Health (Long-Term)</div>
            <ReadingGrid readings={result.technicalReadings} />
          </div>

          <div>
            <div className="iv-section-title">9 · AI Investment Score (0–100)</div>
            <ScoreBar label="Financial Strength" score={result.scores.financial} max={20} />
            <ScoreBar label="Growth" score={result.scores.growth} max={20} />
            <ScoreBar label="Profitability" score={result.scores.profitability} max={15} />
            <ScoreBar label="Valuation" score={result.scores.valuation} max={15} />
            <ScoreBar label="Competitive Advantage" score={result.scores.competitive} max={10} />
            <ScoreBar label="Institutional Confidence" score={result.scores.institutional} max={10} />
            <ScoreBar label="Technical Strength" score={result.scores.technical} max={10} />
            <div className="iv-card-note" style={{ marginTop: 8 }}>
              Total: {fmt(result.totalScore, 0)}/100. Strong Buy requires a score above 85, per this report's methodology.
            </div>
          </div>

          <div>
            <div className="iv-section-title">10 · Final Recommendation</div>
            <div className="iv-grid">
              <div className="iv-card"><div className="iv-card-name">Rating</div><div className="iv-card-val">{result.rating}</div></div>
              <div className="iv-card"><div className="iv-card-name">Fair Value Estimate</div><div className="iv-card-val">{result.fairValue !== null ? `$${fmt(result.fairValue)}` : "N/A"}</div><div className="iv-card-note">Blend of peer-average and PEG=1 implied multiples × TTM EPS — a simplified heuristic, not a DCF</div></div>
              <div className="iv-card"><div className="iv-card-name">Expected Annual Return (5yr)</div><div className="iv-card-val">{result.expectedAnnualReturn !== null ? `${fmt(result.expectedAnnualReturn, 1)}%` : "N/A"}</div><div className="iv-card-note">Assumes current growth fades toward a market-like rate and the multiple holds near its peer/PEG-implied level — a modeling assumption, not a forecast</div></div>
              <div className="iv-card"><div className="iv-card-name">Confidence Level</div><div className="iv-card-val">{fmt(result.confidenceLevel, 0)}%</div><div className="iv-card-note">Heuristic based on data completeness (peers, institutional signals, earnings history)</div></div>
            </div>
            <div className="iv-reasons-cols" style={{ marginTop: 12 }}>
              <div>
                <div className="iv-card-name" style={{ color: "#5FCBA0", marginBottom: 6 }}>Biggest Catalysts</div>
                <ul className="iv-reasons-list">{result.catalysts.map((c, i) => <li className="iv-reason-item" key={i}><CheckCircle2 size={13} color="#5FCBA0" style={{ flexShrink: 0, marginTop: 2 }} />{c}</li>)}</ul>
              </div>
              <div>
                <div className="iv-card-name" style={{ color: "#E8697A", marginBottom: 6 }}>Biggest Risks</div>
                <ul className="iv-reasons-list">{result.risks.map((r, i) => <li className="iv-reason-item" key={i}><XCircle size={13} color="#E8697A" style={{ flexShrink: 0, marginTop: 2 }} />{r}</li>)}</ul>
              </div>
            </div>
          </div>

          <div>
            <div className="iv-section-title">Top 5 Reasons to Buy / Not to Buy</div>
            <div className="iv-reasons-cols">
              <div>
                <div className="iv-card-name" style={{ color: "#5FCBA0", marginBottom: 6 }}>Reasons to Buy</div>
                <ul className="iv-reasons-list">{result.reasonsToBuy.map((r, i) => <li className="iv-reason-item" key={i}><CheckCircle2 size={13} color="#5FCBA0" style={{ flexShrink: 0, marginTop: 2 }} />{r}</li>)}</ul>
              </div>
              <div>
                <div className="iv-card-name" style={{ color: "#E8697A", marginBottom: 6 }}>Reasons Not to Buy</div>
                <ul className="iv-reasons-list">{result.reasonsNotToBuy.map((r, i) => <li className="iv-reason-item" key={i}><XCircle size={13} color="#E8697A" style={{ flexShrink: 0, marginTop: 2 }} />{r}</li>)}</ul>
              </div>
            </div>
          </div>

          <div>
            <div className="iv-section-title">Accumulate on Pullbacks?</div>
            <div className="iv-accumulate-box">
              <div className="iv-accumulate-verdict">{result.accumulateVerdict}</div>
              <ul className="iv-reasons-list">{result.pullbackReasons.map((r, i) => <li className="iv-reason-item" key={i}>{r}</li>)}</ul>
            </div>
          </div>

          <div className="iv-disclaimer">
            <strong>What's real vs. modeled:</strong> Long-term technicals (50/100/200 SMA, relative strength vs SPY, volume/accumulation trends), earnings-surprise history, insider transactions, analyst sentiment, and peer P/E comparison are computed from live Finnhub/Yahoo data. Customer growth, retention, geographic/segment performance, organic-vs-acquisition growth, true economic moat, market share, regulatory/concentration risk, hedge/mutual fund ownership, and dark pool activity are <strong>not available from free structured data</strong> and are explicitly marked "Not available" rather than estimated — these require reading the 10-K/10-Q, earnings call transcripts, or a paid institutional data feed. The AI Investment Score, fair value estimate, 5-year return projection, and "accumulate on pullbacks" verdict are this tool's own transparent model built on the real data above — not predictions, not calibrated to historical accuracy, and not financial advice. This is not a substitute for a licensed financial advisor.
          </div>
        </div>
      )}
    </div>
  );
}
