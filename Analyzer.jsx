import React, { useState, useEffect, useRef } from "react";
import HelpModal from "./HelpModal.jsx";
import { matchGlossary } from "./indicatorGlossary.js";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  Search,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Info,
  HelpCircle,
  Target,
} from "lucide-react";

const FETCH_TIMEOUT_MS = 11000;
const APIKEY_KEY = "stockdesk:finnhub_key";
const LAST_SYMBOL_KEY = "stockdesk:lastSymbol:analyzer";
const analysisCache = new Map();
const CACHE_TTL_MS = 60000;

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
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ============================== YAHOO DATA ==============================

function parseYahooChart(data) {
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
  return { bars, meta: result.meta };
}
async function fetchYahooRaw(symbol, params) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  try {
    const res = await fetchWithTimeout(url, { mode: "cors" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return parseYahooChart(await res.json());
  } catch (e) {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error(`proxy http ${res.status}`);
    return parseYahooChart(await res.json());
  }
}
async function fetchDaily(symbol) {
  try {
    return await fetchYahooRaw(symbol, "range=2y&interval=1d");
  } catch (e) {
    return await fetchYahooRaw(symbol, "range=1y&interval=1d");
  }
}
async function fetchIntradayWithPrePost(symbol) {
  return fetchYahooRaw(symbol, "range=2d&interval=5m&includePrePost=true");
}
async function fetchFutures() {
  const symbols = { "S&P 500 (ES)": "ES=F", "Nasdaq 100 (NQ)": "NQ=F", "Dow (YM)": "YM=F" };
  const results = {};
  await Promise.all(
    Object.entries(symbols).map(async ([label, sym]) => {
      try {
        const { meta } = await fetchYahooRaw(sym, "range=5d&interval=15m");
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose ?? meta.chartPreviousClose;
        results[label] = { price, changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : null };
      } catch (e) {
        results[label] = null;
      }
    })
  );
  return results;
}

// ============================== FINNHUB DATA ==============================

async function finnhubFetch(url) {
  const res = await fetchWithTimeout(url);
  if (res.status === 401 || res.status === 403) {
    const err = new Error("finnhub auth");
    err.finnhubAuth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`finnhub http ${res.status}`);
  return res.json();
}
async function fetchProfile(symbol, apiKey) {
  return finnhubFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
}
async function fetchInsiderTransactions(symbol, apiKey) {
  const data = await finnhubFetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
  return Array.isArray(data?.data) ? data.data : [];
}
async function fetchEarningsProximity(symbol, apiKey) {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const data = await finnhubFetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
}
async function fetchNewsSentiment(symbol, apiKey) {
  const data = await finnhubFetch(`https://finnhub.io/api/v1/news-sentiment?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
  const bullish = data?.sentiment?.bullishPercent;
  const bearish = data?.sentiment?.bearishPercent;
  if (bullish === undefined && bearish === undefined) throw new Error("no sentiment data");
  return { bullish, bearish, buzz: data?.buzz?.buzz ?? null, companyNewsScore: data?.companyNewsScore ?? null };
}
async function fetchTodayEconomicEvents() {
  const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
  let items;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error("http");
    items = await res.json();
  } catch (e) {
    const res = await fetchWithTimeout(`/api/proxy?url=${encodeURIComponent(url)}`, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error("proxy http");
    items = await res.json();
  }
  const todayStr = new Date().toDateString();
  return (Array.isArray(items) ? items : [])
    .filter((e) => e.country === "USD" && (e.impact === "High" || e.impact === "Medium"))
    .filter((e) => new Date(e.date).toDateString() === todayStr);
}

const SECTOR_ETF_MAP = [
  { keywords: ["semiconductor", "software", "technology", "computer", "electronic", "internet"], etf: "XLK", name: "Technology" },
  { keywords: ["bank", "insurance", "financial", "capital markets", "credit"], etf: "XLF", name: "Financials" },
  { keywords: ["biotechnology", "pharmaceutical", "health care", "medical", "drug"], etf: "XLV", name: "Healthcare" },
  { keywords: ["retail", "restaurant", "auto", "apparel", "hotel", "leisure", "e-commerce"], etf: "XLY", name: "Consumer Discretionary" },
  { keywords: ["food", "beverage", "household", "personal products", "tobacco"], etf: "XLP", name: "Consumer Staples" },
  { keywords: ["oil", "gas", "energy"], etf: "XLE", name: "Energy" },
  { keywords: ["utilit", "electric"], etf: "XLU", name: "Utilities" },
  { keywords: ["media", "telecommunication", "entertainment", "communication"], etf: "XLC", name: "Communication Services" },
  { keywords: ["industrial", "aerospace", "defense", "machinery", "transportation", "airline"], etf: "XLI", name: "Industrials" },
  { keywords: ["real estate", "reit"], etf: "XLRE", name: "Real Estate" },
  { keywords: ["chemical", "metal", "mining", "material"], etf: "XLB", name: "Materials" },
];
function mapIndustryToSector(industry) {
  if (!industry) return null;
  const i = industry.toLowerCase();
  for (const s of SECTOR_ETF_MAP) if (s.keywords.some((k) => i.includes(k))) return s;
  return null;
}

// ============================== OPTIONS ==============================

async function fetchOptionsChainRaw(symbol) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  try {
    const res = await fetchWithTimeout(url, { mode: "cors" });
    if (!res.ok) throw new Error("http");
    return await res.json();
  } catch (e) {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error("proxy http");
    return await res.json();
  }
}
async function fetchOptionsAnalysis(symbol) {
  const data = await fetchOptionsChainRaw(symbol);
  const result = data?.optionChain?.result?.[0];
  const options = result?.options?.[0];
  if (!result || !options) throw new Error("no options data");
  return { calls: options.calls || [], puts: options.puts || [], expirations: result.expirationDates || [] };
}
function bsGamma(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const pdf = Math.exp((-d1 * d1) / 2) / Math.sqrt(2 * Math.PI);
  return pdf / (S * sigma * Math.sqrt(T));
}
function computeMaxPain(calls, puts) {
  const strikes = Array.from(new Set([...calls.map((c) => c.strike), ...puts.map((p) => p.strike)])).sort((a, b) => a - b);
  let best = null, bestPain = Infinity;
  for (const s of strikes) {
    let pain = 0;
    for (const c of calls) if (s > c.strike) pain += (s - c.strike) * (c.openInterest || 0);
    for (const p of puts) if (s < p.strike) pain += (p.strike - s) * (p.openInterest || 0);
    if (pain < bestPain) { bestPain = pain; best = s; }
  }
  return best;
}
function callPutWalls(calls, puts) {
  const cw = calls.reduce((m, c) => ((c.openInterest || 0) > (m?.openInterest || 0) ? c : m), null);
  const pw = puts.reduce((m, p) => ((p.openInterest || 0) > (m?.openInterest || 0) ? p : m), null);
  return { callWall: cw?.strike ?? null, putWall: pw?.strike ?? null };
}
function topOIStrikes(calls, puts, n = 3) {
  const combined = [...calls.map((c) => ({ ...c, type: "C" })), ...puts.map((p) => ({ ...p, type: "P" }))];
  return combined.sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, n);
}
function computeGEX(calls, puts, spot, r, T) {
  let gex = 0;
  for (const c of calls) gex += bsGamma(spot, c.strike, T, r, c.impliedVolatility || 0.3) * (c.openInterest || 0);
  for (const p of puts) gex -= bsGamma(spot, p.strike, T, r, p.impliedVolatility || 0.3) * (p.openInterest || 0);
  return gex * spot * spot * 0.01 * 100;
}
function putCallRatios(calls, puts) {
  const callOI = calls.reduce((a, c) => a + (c.openInterest || 0), 0);
  const putOI = puts.reduce((a, p) => a + (p.openInterest || 0), 0);
  return { oiRatio: callOI ? putOI / callOI : null, callOI, putOI };
}
function atmIV(calls, puts, spot) {
  const all = [...calls, ...puts].filter((o) => o.impliedVolatility);
  if (!all.length) return null;
  let best = all[0], bd = Math.abs(best.strike - spot);
  for (const o of all) { const d = Math.abs(o.strike - spot); if (d < bd) { bd = d; best = o; } }
  return best.impliedVolatility * 100;
}

// ============================== INDICATOR MATH ==============================

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
  return values.slice(values.length - period).reduce((a, b) => a + b, 0) / period;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function rsiSeries(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(undefined);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function macdCalc(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  if (!e12.length || !e26.length) return null;
  const line = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] !== undefined && e26[i] !== undefined) line[i] = e12[i] - e26[i];
  const sig = emaSeries(line.filter((v) => v !== undefined), 9);
  const macdNow = lastDefined(line), signalNow = lastDefined(sig);
  if (macdNow === null || signalNow === null) return { macd: macdNow, signal: null, histogram: null };
  return { macd: macdNow, signal: signalNow, histogram: macdNow - signalNow };
}
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}
function bollingerWidthSeries(closes, period = 20, mult = 2) {
  const out = [];
  for (let i = period; i <= closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out.push((2 * mult * Math.sqrt(variance)) / mean);
  }
  return out;
}
function percentileRank(series, value) {
  if (!series.length) return null;
  return (series.filter((v) => v < value).length / series.length) * 100;
}
function atrSeries(bars, period = 14) {
  if (bars.length < period + 1) return [];
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const out = new Array(bars.length).fill(undefined);
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; out[i + 1] = atr; }
  return out;
}
function adr(bars, period = 20) {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((a, b) => a + (b.high - b.low), 0) / period;
}
function pivotPoints(prevBar) {
  const { high: h, low: l, close: c } = prevBar;
  const pp = (h + l + c) / 3;
  return { pp, r1: 2 * pp - l, s1: 2 * pp - h, r2: pp + (h - l), s2: pp - (h - l) };
}
function camarillaLevels(prevBar) {
  const { high: h, low: l, close: c } = prevBar;
  const range = h - l;
  return {
    r4: c + (range * 1.1) / 2, r3: c + (range * 1.1) / 4, r2: c + (range * 1.1) / 6, r1: c + (range * 1.1) / 12,
    s1: c - (range * 1.1) / 12, s2: c - (range * 1.1) / 6, s3: c - (range * 1.1) / 4, s4: c - (range * 1.1) / 2,
  };
}
function keltnerChannels(bars, closes, emaPeriod = 20, atrPeriod = 10, mult = 2) {
  const ema = lastDefined(emaSeries(closes, emaPeriod));
  const atrs = atrSeries(bars, atrPeriod);
  const atrNow = lastDefined(atrs);
  if (ema === null || atrNow === null) return null;
  return { middle: ema, upper: ema + mult * atrNow, lower: ema - mult * atrNow };
}
function fibonacciCalc(bars, lookback = 90) {
  const slice = bars.slice(Math.max(0, bars.length - lookback));
  if (slice.length < 5) return null;
  let hi = 0, lo = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high > slice[hi].high) hi = i;
    if (slice[i].low < slice[lo].low) lo = i;
  }
  const swingHigh = slice[hi].high, swingLow = slice[lo].low, uptrend = lo < hi;
  const range = swingHigh - swingLow;
  const levels = [0.236, 0.382, 0.5, 0.618, 0.786].map((p) => ({ pct: p, price: uptrend ? swingHigh - range * p : swingLow + range * p }));
  const extensions = [1.272, 1.618].map((p) => ({ pct: p, price: uptrend ? swingHigh - range * p : swingLow + range * p }));
  return { swingHigh, swingLow, uptrend, levels, extensions };
}
function volumeProfileCalc(bars, bins = 24) {
  if (!bars.length) return null;
  const maxP = Math.max(...bars.map((b) => b.high)), minP = Math.min(...bars.map((b) => b.low));
  if (maxP === minP) return null;
  const binSize = (maxP - minP) / bins;
  const volumes = new Array(bins).fill(0);
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    let idx = Math.floor((tp - minP) / binSize);
    idx = Math.max(0, Math.min(bins - 1, idx));
    volumes[idx] += b.volume;
  }
  const totalVol = volumes.reduce((a, b) => a + b, 0);
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (volumes[i] > volumes[pocIdx]) pocIdx = i;
  const poc = minP + binSize * (pocIdx + 0.5);
  let coveredVol = volumes[pocIdx], lo = pocIdx, hi = pocIdx;
  while (coveredVol / totalVol < 0.7 && (lo > 0 || hi < bins - 1)) {
    const nextLo = lo > 0 ? volumes[lo - 1] : -1;
    const nextHi = hi < bins - 1 ? volumes[hi + 1] : -1;
    if (nextHi >= nextLo) { hi++; coveredVol += volumes[hi]; } else { lo--; coveredVol += volumes[lo]; }
  }
  const chartData = volumes.map((v, i) => ({ price: minP + binSize * (i + 0.5), volume: v, isPoc: i === pocIdx }));
  return { poc, vaHigh: minP + binSize * (hi + 1), vaLow: minP + binSize * lo, chartData };
}
function adxCalc(bars, period = 14) {
  if (bars.length < period * 2) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  let smTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlus = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    smTR = smTR - smTR / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    const pDI = 100 * (smPlus / (smTR || 1)), mDI = 100 * (smMinus / (smTR || 1));
    dx.push({ dx: (100 * Math.abs(pDI - mDI)) / (pDI + mDI || 1), pDI, mDI });
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i].dx) / period;
  const last = dx[dx.length - 1];
  return { adx: adxVal, plusDI: last.pDI, minusDI: last.mDI };
}
function stochRsiCalc(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsi = rsiSeries(closes, rsiPeriod).filter((v) => v !== undefined);
  if (rsi.length < stochPeriod + kSmooth + dSmooth) return null;
  const kRaw = [];
  for (let i = stochPeriod - 1; i < rsi.length; i++) {
    const win = rsi.slice(i - stochPeriod + 1, i + 1);
    const mn = Math.min(...win), mx = Math.max(...win);
    kRaw.push(mx === mn ? 0 : ((rsi[i] - mn) / (mx - mn)) * 100);
  }
  const kS = [];
  for (let i = kSmooth - 1; i < kRaw.length; i++) kS.push(kRaw.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth);
  const dS = [];
  for (let i = dSmooth - 1; i < kS.length; i++) dS.push(kS.slice(i - dSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / dSmooth);
  return { k: kS[kS.length - 1], d: dS[dS.length - 1] };
}
function obvTrend(bars, lookback = 20) {
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
function cmfCalc(bars, period = 20) {
  if (bars.length < period) return null;
  const slice = bars.slice(bars.length - period);
  let mfv = 0, vol = 0;
  for (const b of slice) {
    const range = b.high - b.low;
    const mfm = range === 0 ? 0 : ((b.close - b.low) - (b.high - b.close)) / range;
    mfv += mfm * b.volume; vol += b.volume;
  }
  return vol ? mfv / vol : null;
}
function relativeVolumeCalc(bars) {
  if (bars.length < 21) return null;
  const today = bars[bars.length - 1].volume;
  const avg = bars.slice(bars.length - 21, bars.length - 1).reduce((a, b) => a + b.volume, 0) / 20;
  return avg ? today / avg : null;
}
function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ============================== UI HELPERS ==============================

const TAG_ICON = { bullish: TrendingUp, bearish: TrendingDown, neutral: Minus, unavailable: Info };

function ReadingGrid({ readings }) {
  const [activeHelp, setActiveHelp] = useState(null);
  return (
    <div className="an-grid">
      {readings.map((r, i) => {
        const Icon = TAG_ICON[r.tag] || Minus;
        const glossary = matchGlossary(r.name);
        return (
          <div className="an-card" key={i}>
            <div className="an-card-top">
              <span className="an-card-name">
                {r.name}
                {glossary && (
                  <button className="an-help-btn" onClick={() => setActiveHelp(glossary)} aria-label={`What is ${r.name}?`}>
                    <HelpCircle size={12} />
                  </button>
                )}
              </span>
              <span className={`an-tag-icon ${r.tag}`}><Icon size={13} /></span>
            </div>
            <div className="an-card-val">{r.value}</div>
            <div className="an-card-note">{r.note}</div>
          </div>
        );
      })}
      <HelpModal entry={activeHelp} onClose={() => setActiveHelp(null)} />
    </div>
  );
}

// ============================== COMPONENT ==============================

export default function Analyzer() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const apiKeyRef = useRef(readLocal(APIKEY_KEY) || "");

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

    try {
      const [dailyRes, intradayRes, futures, optionsRes] = await Promise.all([
        fetchDaily(symbol),
        fetchIntradayWithPrePost(symbol).catch(() => null),
        fetchFutures().catch(() => ({})),
        fetchOptionsAnalysis(symbol).catch(() => null),
      ]);
      const [profile, insiders, earningsProx, newsSentiment, spyDaily] = await Promise.all([
        apiKey ? fetchProfile(symbol, apiKey).catch(() => null) : Promise.resolve(null),
        apiKey ? fetchInsiderTransactions(symbol, apiKey).catch(() => []) : Promise.resolve([]),
        apiKey ? fetchEarningsProximity(symbol, apiKey).catch(() => []) : Promise.resolve([]),
        apiKey ? fetchNewsSentiment(symbol, apiKey).catch(() => null) : Promise.resolve(null),
        fetchDaily("SPY").catch(() => null),
      ]);
      const econEvents = await fetchTodayEconomicEvents().catch(() => []);

      const bars = dailyRes.bars;
      if (bars.length < 210) throw new Error(`Only ${bars.length} days of history returned — need ~210 for a reliable 200-day moving average.`);
      const closes = bars.map((b) => b.close);
      const price = closes[closes.length - 1];
      const prevBar = bars[bars.length - 2];

      let sectorInfo = null;
      if (profile?.finnhubIndustry) {
        const mapped = mapIndustryToSector(profile.finnhubIndustry);
        if (mapped) {
          try {
            const etfDaily = await fetchDaily(mapped.etf);
            const etfCloses = etfDaily.bars.map((b) => b.close);
            const etfChg = ((etfCloses[etfCloses.length - 1] - etfCloses[etfCloses.length - 2]) / etfCloses[etfCloses.length - 2]) * 100;
            sectorInfo = { name: mapped.name, etf: mapped.etf, changePercent: etfChg };
          } catch (e) {
            sectorInfo = null;
          }
        }
      }

      // ============ 1. Previous day OHLCV ============
      const prevOHLCV = { open: prevBar.open, high: prevBar.high, low: prevBar.low, close: prevBar.close, volume: prevBar.volume };

      // ============ 2. Premarket movement ============
      let premarket = null;
      const { bars: intraBars, meta: intraMeta } = intradayRes || { bars: [], meta: null };
      const ctp = intraMeta?.currentTradingPeriod;
      let regularBars = intraBars;
      if (ctp) {
        const preStart = ctp.pre?.start * 1000, preEnd = ctp.pre?.end * 1000;
        const regStart = ctp.regular?.start * 1000, regEnd = ctp.regular?.end * 1000;
        const preBars = intraBars.filter((b) => b.t >= preStart && b.t < preEnd);
        regularBars = intraBars.filter((b) => b.t >= regStart && b.t <= regEnd);
        if (preBars.length) {
          const lastPre = preBars[preBars.length - 1];
          premarket = { price: lastPre.close, changePercent: ((lastPre.close - prevBar.close) / prevBar.close) * 100, barCount: preBars.length };
        }
      }

      // ============ 6. Session VWAP ============
      let sessionVwap = null;
      if (regularBars.length) {
        let cumPV = 0, cumV = 0;
        for (const b of regularBars) { const tp = (b.high + b.low + b.close) / 3; cumPV += tp * b.volume; cumV += b.volume; }
        sessionVwap = cumV ? cumPV / cumV : null;
      }

      // ============ Core indicators ============
      const ema5 = lastDefined(emaSeries(closes, 5));
      const ema10 = lastDefined(emaSeries(closes, 10));
      const ema20 = lastDefined(emaSeries(closes, 20));
      const sma50 = smaAt(closes, 50);
      const sma100 = smaAt(closes, 100);
      const sma200 = smaAt(closes, 200);
      const rsi = lastDefined(rsiSeries(closes, 14));
      const macdRes = macdCalc(closes);
      const atrVal = lastDefined(atrSeries(bars, 14));
      const adrVal = adr(bars, 20);
      const bb = bollinger(closes);
      const keltner = keltnerChannels(bars, closes);
      const pivots = pivotPoints(prevBar);
      const camarilla = camarillaLevels(prevBar);
      const fib = fibonacciCalc(bars);
      const volProfile = volumeProfileCalc(bars.slice(-30));
      const adx = adxCalc(bars);
      const stochRsi = stochRsiCalc(closes);
      const obv = obvTrend(bars);
      const cmf = cmfCalc(bars);
      const relVol = relativeVolumeCalc(bars);

      let rs5d = null;
      if (spyDaily?.bars?.length > 5) {
        const spyCloses = spyDaily.bars.map((b) => b.close);
        const stockRet = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
        const spyRet = ((spyCloses[spyCloses.length - 1] - spyCloses[spyCloses.length - 6]) / spyCloses[spyCloses.length - 6]) * 100;
        rs5d = stockRet - spyRet;
      }

      // ============ Options ============
      let optionsData = null;
      if (optionsRes) {
        const { calls, puts, expirations } = optionsRes;
        const pcr = putCallRatios(calls, puts);
        const maxPain = computeMaxPain(calls, puts);
        const walls = callPutWalls(calls, puts);
        const iv = atmIV(calls, puts, price);
        const T = expirations[0] ? Math.max(1 / 365, (expirations[0] * 1000 - Date.now()) / (365 * 24 * 3600 * 1000)) : 7 / 365;
        const gex = computeGEX(calls, puts, price, 0.045, T);
        const topStrikes = topOIStrikes(calls, puts);
        const ivDailyMove = iv ? price * (iv / 100) * Math.sqrt(1 / 365) : null;
        optionsData = { pcr, maxPain, walls, iv, gex, topStrikes, ivDailyMove, expiry: expirations[0] ? new Date(expirations[0] * 1000) : null };
      }

      // ============ Ensemble daily range ============
      const center = sessionVwap !== null ? price * 0.6 + sessionVwap * 0.4 : price;
      const highCandidates = [], lowCandidates = [];
      if (atrVal) { highCandidates.push(center + atrVal / 2); lowCandidates.push(center - atrVal / 2); }
      if (adrVal) { highCandidates.push(center + adrVal / 2); lowCandidates.push(center - adrVal / 2); }
      highCandidates.push(pivots.r1); lowCandidates.push(pivots.s1);
      highCandidates.push(camarilla.r3); lowCandidates.push(camarilla.s3);
      if (keltner) { highCandidates.push(keltner.upper); lowCandidates.push(keltner.lower); }
      if (bb) { highCandidates.push(bb.upper); lowCandidates.push(bb.lower); }
      if (optionsData?.ivDailyMove) { highCandidates.push(price + optionsData.ivDailyMove); lowCandidates.push(price - optionsData.ivDailyMove); }

      let dailyHigh = highCandidates.reduce((a, b) => a + b, 0) / highCandidates.length;
      let dailyLow = lowCandidates.reduce((a, b) => a + b, 0) / lowCandidates.length;

      // ============ Composite bias scoring ============
      let score = 0, maxScore = 0;
      const vote = (cond, weight = 1) => { maxScore += weight; if (cond === true) score += weight; else if (cond === false) score -= weight; };
      vote(ema20 !== null ? price > ema20 : null);
      vote(sma50 !== null ? price > sma50 : null);
      vote(sma200 !== null ? price > sma200 : null, 1.5);
      vote(rsi !== null ? rsi > 50 : null, 0.7);
      vote(macdRes?.histogram !== null ? macdRes.histogram > 0 : null);
      vote(sessionVwap !== null ? price > sessionVwap : null, 1.3);
      vote(price > pivots.pp);
      vote(obv ? obv.slopeUp : null, 0.6);
      vote(cmf !== null ? cmf > 0 : null, 0.6);
      vote(adx && adx.adx > 20 ? adx.plusDI > adx.minusDI : null, 0.8);
      vote(premarket ? premarket.changePercent > 0 : null, 1.2);
      vote(futures["S&P 500 (ES)"] ? futures["S&P 500 (ES)"].changePercent > 0 : null, 0.9);
      vote(rs5d !== null ? rs5d > 0 : null, 0.7);
      vote(optionsData ? optionsData.gex < 0 : null, 0.4); // negative GEX slightly favors bigger moves either way; treated as neutral-ish tilt, small weight
      const z = maxScore ? clamp(score / maxScore, -1, 1) : 0;

      const bias = z > 0.15 ? "Bullish" : z < -0.15 ? "Bearish" : "Neutral";
      const tilt = (dailyHigh - dailyLow) * 0.1 * z;
      dailyHigh += tilt;
      dailyLow = Math.max(0.01, dailyLow + tilt);

      // ============ Most likely closing range (narrower, biased toward VWAP/pivot) ============
      const closeCenterAnchor = sessionVwap ?? pivots.pp;
      const closeDrift = z * atrVal * 0.35;
      const closeRangeHalf = (atrVal || (dailyHigh - dailyLow) / 2) * 0.28;
      const closeLow = closeCenterAnchor + closeDrift - closeRangeHalf;
      const closeHigh = closeCenterAnchor + closeDrift + closeRangeHalf;

      // ============ Support / resistance levels (deduped, closest first) ============
      function dedupeSort(levels, aboveOrBelow, refPrice) {
        const filtered = levels.filter((l) => l !== null && l !== undefined && (aboveOrBelow === "above" ? l > refPrice : l < refPrice));
        const sorted = filtered.sort((a, b) => (aboveOrBelow === "above" ? a - b : b - a));
        const out = [];
        for (const l of sorted) {
          if (!out.some((o) => Math.abs(o - l) / refPrice < 0.003)) out.push(l);
          if (out.length === 3) break;
        }
        return out;
      }
      const resistanceCandidates = [pivots.r1, pivots.r2, camarilla.r3, camarilla.r4, volProfile?.vaHigh, prevBar.high, optionsData?.walls?.callWall, fib?.levels?.find((l) => l.price > price)?.price];
      const supportCandidates = [pivots.s1, pivots.s2, camarilla.s3, camarilla.s4, volProfile?.vaLow, prevBar.low, optionsData?.walls?.putWall, fib?.levels?.find((l) => l.price < price)?.price];
      const resistanceLevels = dedupeSort(resistanceCandidates, "above", price);
      const supportLevels = dedupeSort(supportCandidates, "below", price);
      while (resistanceLevels.length < 3) resistanceLevels.push(resistanceLevels.length ? resistanceLevels[resistanceLevels.length - 1] + atrVal * 0.5 : price + atrVal * (resistanceLevels.length + 1) * 0.5);
      while (supportLevels.length < 3) supportLevels.push(supportLevels.length ? supportLevels[supportLevels.length - 1] - atrVal * 0.5 : price - atrVal * (supportLevels.length + 1) * 0.5);

      // ============ Probability table ============
      const sigma = optionsData?.ivDailyMove || atrVal || (dailyHigh - dailyLow) / 2;
      const distHigh = dailyHigh - price, distLow = price - dailyLow;
      const touchesHigh = clamp(2 * (1 - normCdf(distHigh / sigma)), 0.03, 0.95);
      const touchesLow = clamp(2 * (1 - normCdf(distLow / sigma)), 0.03, 0.95);
      const breaksResistance = clamp(1 - normCdf(distHigh / sigma), 0.02, 0.9);
      const breaksSupport = clamp(normCdf(-distLow / sigma), 0.02, 0.9);

      // ============ Expected volatility ============
      const atrPct = atrVal ? (atrVal / price) * 100 : null;
      const bbWidths = bollingerWidthSeries(closes.slice(-160));
      const bbWidthNow = bb ? (bb.upper - bb.lower) / bb.middle : null;
      const widthPct = bbWidthNow !== null ? percentileRank(bbWidths, bbWidthNow) : null;
      let expectedVol = "Medium";
      if (atrPct !== null) {
        if (atrPct > 4 || (widthPct !== null && widthPct > 75)) expectedVol = "High";
        else if (atrPct < 1.8 && (widthPct === null || widthPct < 35)) expectedVol = "Low";
      }

      // ============ Trading plan ============
      let entry, target, stopLoss, planNote;
      if (bias === "Bullish") {
        entry = Math.max(supportLevels[0], price - atrVal * 0.3);
        target = resistanceLevels[1] ?? resistanceLevels[0];
        stopLoss = supportLevels[1] ?? supportLevels[0] - atrVal * 0.3;
        planNote = "Pullback entry toward nearby support, targeting the second resistance level.";
      } else if (bias === "Bearish") {
        entry = Math.min(resistanceLevels[0], price + atrVal * 0.3);
        target = supportLevels[1] ?? supportLevels[0];
        stopLoss = resistanceLevels[1] ?? resistanceLevels[0] + atrVal * 0.3;
        planNote = "Rally entry toward nearby resistance, targeting the second support level.";
      } else {
        entry = sessionVwap ?? price;
        target = resistanceLevels[0];
        stopLoss = supportLevels[0];
        planNote = "No clear directional edge — range-fade idea between nearest support and resistance.";
      }

      // ============ Confidence ============
      const confidence = Math.round(clamp(50 + Math.abs(z) * 40 + (optionsData ? 5 : 0) + (apiKey ? 5 : 0), 15, 95));

      // ============ Readings for the indicator grid ============
      const readings = [
        { name: "Previous Day OHLCV", value: `O ${fmt(prevOHLCV.open)} H ${fmt(prevOHLCV.high)} L ${fmt(prevOHLCV.low)} C ${fmt(prevOHLCV.close)}`, tag: "neutral", note: `Volume ${fmtBig(prevOHLCV.volume)}` },
        { name: "Premarket Movement", value: premarket ? `${premarket.changePercent >= 0 ? "+" : ""}${fmt(premarket.changePercent, 2)}%` : "No premarket data", tag: premarket ? (premarket.changePercent > 0 ? "bullish" : premarket.changePercent < 0 ? "bearish" : "neutral") : "unavailable", note: premarket ? `${premarket.barCount} premarket bars seen` : "Market may already be in regular session, or premarket volume was too thin" },
        { name: "Futures (ES/NQ/YM)", value: Object.entries(futures).filter(([, v]) => v).map(([k, v]) => `${k.split(" ")[0]} ${v.changePercent >= 0 ? "+" : ""}${fmt(v.changePercent, 2)}%`).join(" · ") || "N/A", tag: Object.values(futures).some((v) => v) ? (Object.values(futures).filter(Boolean).reduce((a, v) => a + v.changePercent, 0) > 0 ? "bullish" : "bearish") : "unavailable", note: "Overnight broad-market futures move" },
        { name: "ATR (14)", value: fmt(atrVal), tag: "neutral", note: `${fmt(atrPct, 1)}% of price` },
        { name: "ADR (20)", value: fmt(adrVal), tag: "neutral", note: "20-day average high-low range" },
        { name: "Session VWAP", value: sessionVwap !== null ? fmt(sessionVwap) : "N/A", tag: sessionVwap !== null ? (price > sessionVwap ? "bullish" : "bearish") : "unavailable", note: sessionVwap !== null ? `Price is ${price > sessionVwap ? "above" : "below"} VWAP` : "Intraday data unavailable" },
        { name: "Volume Profile (POC/VAH/VAL)", value: volProfile ? `POC ${fmt(volProfile.poc)} · VAH ${fmt(volProfile.vaHigh)} · VAL ${fmt(volProfile.vaLow)}` : "N/A", tag: volProfile ? (price > volProfile.poc ? "bullish" : "bearish") : "unavailable", note: "Last 30 sessions" },
        { name: "Pivot Points", value: `PP ${fmt(pivots.pp)} · R1 ${fmt(pivots.r1)} · S1 ${fmt(pivots.s1)}`, tag: price > pivots.pp ? "bullish" : "bearish", note: "" },
        { name: "Camarilla Levels", value: `R3 ${fmt(camarilla.r3)} · S3 ${fmt(camarilla.s3)}`, tag: "neutral", note: `R4 ${fmt(camarilla.r4)} / S4 ${fmt(camarilla.s4)} (breakout levels)` },
        { name: "Fibonacci Retracement & Extension", value: fib ? `${fmt(fib.swingLow)} – ${fmt(fib.swingHigh)}` : "N/A", tag: "neutral", note: fib ? `${fib.uptrend ? "Uptrend" : "Downtrend"} retracement, 90 sessions` : "Insufficient data" },
        { name: "5 / 10 EMA", value: `${fmt(ema5)} / ${fmt(ema10)}`, tag: ema5 !== null && ema10 !== null ? (price > ema5 && ema5 > ema10 ? "bullish" : price < ema5 && ema5 < ema10 ? "bearish" : "neutral") : "unavailable", note: "" },
        { name: "20 EMA", value: fmt(ema20), tag: ema20 !== null ? (price > ema20 ? "bullish" : "bearish") : "unavailable", note: "" },
        { name: "50 / 100 / 200 SMA", value: `${fmt(sma50)} / ${fmt(sma100)} / ${fmt(sma200)}`, tag: sma200 !== null ? (price > sma200 ? "bullish" : "bearish") : "unavailable", note: "Long-term trend filter" },
        { name: "Bollinger Bands", value: bb ? `${fmt(bb.lower)} – ${fmt(bb.upper)}` : "N/A", tag: bb ? (price > bb.upper ? "bearish" : price < bb.lower ? "bullish" : "neutral") : "unavailable", note: "" },
        { name: "Keltner Channels", value: keltner ? `${fmt(keltner.lower)} – ${fmt(keltner.upper)}` : "N/A", tag: keltner ? (price > keltner.upper ? "bearish" : price < keltner.lower ? "bullish" : "neutral") : "unavailable", note: "" },
        { name: "RSI (14)", value: fmt(rsi, 1), tag: rsi !== null ? (rsi > 60 ? "bullish" : rsi < 40 ? "bearish" : "neutral") : "unavailable", note: rsi !== null ? (rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "") : "" },
        { name: "MACD", value: macdRes?.histogram !== null ? `hist ${fmt(macdRes.histogram, 2)}` : "N/A", tag: macdRes?.histogram !== null ? (macdRes.histogram > 0 ? "bullish" : "bearish") : "unavailable", note: "" },
        { name: "ADX", value: adx ? fmt(adx.adx, 1) : "N/A", tag: adx ? (adx.adx > 25 ? (adx.plusDI > adx.minusDI ? "bullish" : "bearish") : "neutral") : "unavailable", note: adx ? (adx.adx > 25 ? "Trending" : "Weak trend") : "" },
        { name: "Stochastic RSI", value: stochRsi ? `K ${fmt(stochRsi.k, 0)} / D ${fmt(stochRsi.d, 0)}` : "N/A", tag: stochRsi ? (stochRsi.k > 80 ? "bearish" : stochRsi.k < 20 ? "bullish" : "neutral") : "unavailable", note: "" },
        { name: "OBV", value: obv ? (obv.slopeUp ? "Rising" : "Falling") : "N/A", tag: obv ? (obv.slopeUp ? "bullish" : "bearish") : "unavailable", note: "" },
        { name: "Chaikin Money Flow", value: cmf !== null ? fmt(cmf, 3) : "N/A", tag: cmf !== null ? (cmf > 0.05 ? "bullish" : cmf < -0.05 ? "bearish" : "neutral") : "unavailable", note: "" },
        { name: "Options Gamma Exposure (GEX)", value: optionsData ? fmtBig(optionsData.gex) : "N/A", tag: optionsData ? (optionsData.gex > 0 ? "bullish" : "bearish") : "unavailable", note: optionsData ? (optionsData.gex > 0 ? "Positive — historically vol-dampening" : "Negative — historically vol-amplifying") + " (approximation, not a real dealer feed)" : "Options chain unavailable" },
        { name: "Max Pain", value: optionsData?.maxPain !== null && optionsData ? fmt(optionsData.maxPain, 0) : "N/A", tag: optionsData?.maxPain ? (price > optionsData.maxPain ? "bearish" : "bullish") : "unavailable", note: "" },
        { name: "Open Interest by Strike", value: optionsData ? optionsData.topStrikes.map((s) => `${s.type}${fmt(s.strike, 0)}`).join(", ") : "N/A", tag: "neutral", note: "Top 3 strikes by open interest" },
        { name: "Implied Move from Options", value: optionsData?.ivDailyMove ? `±${fmt(optionsData.ivDailyMove)}` : "N/A", tag: "neutral", note: optionsData?.iv ? `${fmt(optionsData.iv, 1)}% IV, nearest expiry` : "" },
        { name: "Dark Pool Levels", value: "Not available", tag: "unavailable", note: "Requires a paid dark-pool print feed" },
        { name: "Institutional Buying/Selling", value: apiKey && insiders.length ? `${insiders.length} recent Form 4 filings` : "Not available today", tag: "unavailable", note: "Real-time institutional flow isn't published anywhere free; insider filings (shown) lag by days" },
        { name: "Relative Strength vs SPY", value: rs5d !== null ? `${rs5d >= 0 ? "+" : ""}${fmt(rs5d, 1)}pp (5d)` : "N/A", tag: rs5d !== null ? (rs5d > 0 ? "bullish" : "bearish") : "unavailable", note: "" },
        { name: "Sector Performance", value: sectorInfo ? `${sectorInfo.name} (${sectorInfo.etf}) ${sectorInfo.changePercent >= 0 ? "+" : ""}${fmt(sectorInfo.changePercent, 2)}%` : "N/A", tag: sectorInfo ? (sectorInfo.changePercent > 0 ? "bullish" : "bearish") : "unavailable", note: apiKey ? "" : "Requires a Finnhub key to identify sector" },
        { name: "Economic News Today", value: econEvents.length ? `${econEvents.length} high/medium-impact US release${econEvents.length === 1 ? "" : "s"}` : "None scheduled", tag: econEvents.length ? "neutral" : "neutral", note: econEvents.slice(0, 3).map((e) => e.title).join(", ") },
        { name: "Earnings Calendar Proximity", value: earningsProx.length ? `Reports ${earningsProx[0].date}` : (apiKey ? "None in next 6 days" : "N/A"), tag: earningsProx.length ? "neutral" : "neutral", note: earningsProx.length ? "Expect wider ranges than usual around this date" : "" },
        { name: "News Sentiment", value: newsSentiment ? `${fmt(newsSentiment.bullish * 100, 0)}% bullish / ${fmt(newsSentiment.bearish * 100, 0)}% bearish` : "Not available", tag: newsSentiment ? (newsSentiment.bullish > newsSentiment.bearish ? "bullish" : "bearish") : "unavailable", note: apiKey ? "Finnhub news-sentiment endpoint" : "Requires a Finnhub key" },
      ];

      const explanationParts = [];
      explanationParts.push(`${symbol} is ${bias.toLowerCase()} with a composite score of ${fmt(z, 2)} (range -1 to 1).`);
      if (premarket) explanationParts.push(`Premarket is ${premarket.changePercent >= 0 ? "up" : "down"} ${fmt(Math.abs(premarket.changePercent), 1)}%.`);
      explanationParts.push(`The range blends ATR (${fmt(atrVal)}), ADR (${fmt(adrVal)}), pivots, Camarilla, ${bb ? "Bollinger, " : ""}${keltner ? "Keltner, " : ""}${optionsData?.ivDailyMove ? "and the options-implied move" : "and available volatility signals"}.`);
      explanationParts.push(`Price is ${price > pivots.pp ? "above" : "below"} the daily pivot${sessionVwap !== null ? ` and ${price > sessionVwap ? "above" : "below"} VWAP` : ""}.`);
      if (optionsData) explanationParts.push(`GEX is ${optionsData.gex > 0 ? "positive (vol-dampening)" : "negative (vol-amplifying)"}, with max pain near $${fmt(optionsData.maxPain, 0)}.`);
      if (sectorInfo) explanationParts.push(`Its sector (${sectorInfo.name}) is ${sectorInfo.changePercent >= 0 ? "up" : "down"} ${fmt(Math.abs(sectorInfo.changePercent), 1)}% today.`);
      let explanation = explanationParts.join(" ");
      const words = explanation.split(/\s+/);
      if (words.length > 150) explanation = words.slice(0, 150).join(" ") + "…";

      const resultData = {
        symbol, price, bias, z, confidence,
        dailyHigh, dailyLow, closeLow, closeHigh,
        supportLevels, resistanceLevels,
        touchesHigh, touchesLow, breaksResistance, breaksSupport,
        expectedVol, entry, target, stopLoss, planNote,
        explanation,
        readings,
        volProfile,
        dataSource: "yahoo",
        hasKey: !!apiKey,
      };
      setResult(resultData);
      analysisCache.set(symbol, { data: resultData, at: Date.now() });
      writeLocal(LAST_SYMBOL_KEY, symbol);
    } catch (e) {
      setError(e?.message || `Couldn't complete the analysis for ${symbol}. Try again in a moment.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="an-root">
      <style>{`
        .an-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 40px; }
        .an-header { padding: 22px 24px 6px; }
        .an-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .an-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .an-search-row { padding: 16px 24px 8px; display: flex; gap: 10px; }
        .an-search-box { flex: 1; max-width: 420px; display: flex; align-items: center; gap: 8px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 6px; padding: 0 12px; transition: border-color 0.15s; }
        .an-search-box:focus-within { border-color: #FFB454; }
        .an-search-box input { background: transparent; border: none; outline: none; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 10px 4px; width: 100%; letter-spacing: 0.03em; }
        .an-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 0 18px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; cursor: pointer; }
        .an-btn:disabled { opacity: 0.6; cursor: default; }
        .an-error { margin: 10px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .an-loading { display: flex; align-items: center; gap: 8px; padding: 60px 24px; justify-content: center; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .an-body { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 18px; }
        .an-section-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 0.03em; margin: 4px 0 0; color: #EDEBE4; }
        .an-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
        .an-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 13px 14px; }
        .an-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
        .an-card-name { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; }
        .an-help-btn { background: transparent; border: none; color: #5A5F68; cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
        .an-help-btn:hover { color: #FFB454; }
        .an-card-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #ADB1B9; }
        .an-card-note { font-size: 11.5px; color: #888E99; margin-top: 6px; line-height: 1.4; }
        .an-tag-icon.bullish { color: #5FCBA0; } .an-tag-icon.bearish { color: #E8697A; } .an-tag-icon.neutral { color: #C99A4B; } .an-tag-icon.unavailable { color: #5A5F68; }

        .fc-card { background: linear-gradient(180deg, #1C1F25 0%, #191B21 100%); border: 1px solid #FFB454; border-radius: 12px; padding: 22px; }
        .fc-title { display: flex; align-items: center; gap: 8px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 16px; color: #FFB454; margin-bottom: 16px; }
        .fc-row { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
        .fc-block { flex: 1; min-width: 150px; }
        .fc-label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #888E99; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
        .fc-val { font-family: 'IBM Plex Mono', monospace; font-size: 16px; font-weight: 700; }
        .fc-bias { display: inline-block; padding: 4px 14px; border-radius: 6px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; }
        .fc-bias.Bullish { background: rgba(95,203,160,0.16); color: #5FCBA0; }
        .fc-bias.Bearish { background: rgba(232,105,122,0.16); color: #E8697A; }
        .fc-bias.Neutral { background: rgba(201,154,75,0.16); color: #C99A4B; }
        .fc-levels-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
        @media (max-width: 500px) { .fc-levels-cols { grid-template-columns: 1fr; } }
        .fc-levels-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .fc-levels-list li { font-family: 'IBM Plex Mono', monospace; font-size: 13px; display: flex; justify-content: space-between; background: #14161A; padding: 6px 10px; border-radius: 5px; }
        .fc-prob-table { width: 100%; border-collapse: collapse; font-family: 'IBM Plex Mono', monospace; font-size: 12px; margin-bottom: 16px; }
        .fc-prob-table td { padding: 6px 4px; border-bottom: 1px solid #2A2E36; }
        .fc-prob-table td:last-child { text-align: right; font-weight: 700; color: #FFB454; }
        .fc-plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 16px; }
        .fc-plan-card { background: #14161A; border: 1px solid #2A2E36; border-radius: 8px; padding: 10px; text-align: center; }
        .fc-plan-card .lbl { font-size: 9.5px; color: #888E99; text-transform: uppercase; letter-spacing: 0.04em; }
        .fc-plan-card .val { font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 700; margin-top: 4px; }
        .fc-explain { font-size: 12.5px; color: #C7CAD1; line-height: 1.6; border-top: 1px solid #2A2E36; padding-top: 14px; }
        .an-disclaimer { font-size: 10.5px; color: #5A5F68; line-height: 1.6; }
      `}</style>

      <div className="an-header">
        <h1>ANALYZER</h1>
        <p>Institutional-quant intraday range prediction — 30-input analysis for today's session</p>
      </div>

      <form className="an-search-row" onSubmit={handleAnalyze}>
        <div className="an-search-box">
          <Search size={15} color="#5A5F68" />
          <input placeholder="Enter a ticker, e.g. AAPL" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={10} />
        </div>
        <button className="an-btn" type="submit" disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          {loading ? "Analyzing" : "Analyze"}
        </button>
      </form>

      {error && (
        <div className="an-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}
      {loading && (
        <div className="an-loading">
          <Loader2 size={16} className="spin" /> pulling daily/intraday/premarket data, futures, options chain, sector, and today's calendar…
        </div>
      )}

      {result && !loading && (
        <div className="an-body">
          {!result.hasKey && (
            <div className="an-error" style={{ background: "rgba(255,180,84,0.08)", borderColor: "rgba(255,180,84,0.3)", color: "#E0B872" }}>
              <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>No Finnhub key found — Sector Performance, Earnings Proximity, News Sentiment, and Institutional filings are skipped. Add a free key from the Watchlist tab's "connect data" button to unlock them.</span>
            </div>
          )}

          <div className="fc-card">
            <div className="fc-title"><Target size={17} /> Final Call — {result.symbol}</div>

            <div className="fc-row">
              <div className="fc-block">
                <div className="fc-label">Today's Bias</div>
                <span className={`fc-bias ${result.bias}`}>{result.bias}</span>
              </div>
              <div className="fc-block">
                <div className="fc-label">Confidence</div>
                <div className="fc-val">{result.confidence}/100</div>
              </div>
              <div className="fc-block">
                <div className="fc-label">Expected Volatility</div>
                <div className="fc-val">{result.expectedVol}</div>
              </div>
            </div>

            <div className="fc-row">
              <div className="fc-block">
                <div className="fc-label">Expected Daily Range</div>
                <div className="fc-val">Low: ${fmt(result.dailyLow)}</div>
                <div className="fc-val">High: ${fmt(result.dailyHigh)}</div>
              </div>
              <div className="fc-block">
                <div className="fc-label">Most Likely Closing Range</div>
                <div className="fc-val">${fmt(result.closeLow)} – ${fmt(result.closeHigh)}</div>
              </div>
            </div>

            <div className="fc-levels-cols">
              <div>
                <div className="fc-label">Key Resistance Levels</div>
                <ul className="fc-levels-list">
                  {result.resistanceLevels.map((l, i) => <li key={i}><span>R{i + 1}</span><span>${fmt(l)}</span></li>)}
                </ul>
              </div>
              <div>
                <div className="fc-label">Key Support Levels</div>
                <ul className="fc-levels-list">
                  {result.supportLevels.map((l, i) => <li key={i}><span>S{i + 1}</span><span>${fmt(l)}</span></li>)}
                </ul>
              </div>
            </div>

            <div className="fc-label">Probability Table</div>
            <table className="fc-prob-table">
              <tbody>
                <tr><td>Touches High</td><td>{fmt(result.touchesHigh * 100, 0)}%</td></tr>
                <tr><td>Touches Low</td><td>{fmt(result.touchesLow * 100, 0)}%</td></tr>
                <tr><td>Breaks Resistance (closes beyond)</td><td>{fmt(result.breaksResistance * 100, 0)}%</td></tr>
                <tr><td>Breaks Support (closes beyond)</td><td>{fmt(result.breaksSupport * 100, 0)}%</td></tr>
              </tbody>
            </table>

            <div className="fc-label">Trade Plan — {result.planNote}</div>
            <div className="fc-plan-grid">
              <div className="fc-plan-card"><div className="lbl">Best Entry</div><div className="val">${fmt(result.entry)}</div></div>
              <div className="fc-plan-card"><div className="lbl">Best Profit Target</div><div className="val" style={{ color: "#5FCBA0" }}>${fmt(result.target)}</div></div>
              <div className="fc-plan-card"><div className="lbl">Stop Loss</div><div className="val" style={{ color: "#E8697A" }}>${fmt(result.stopLoss)}</div></div>
            </div>

            <div className="fc-explain">{result.explanation}</div>
          </div>

          {result.volProfile && (
            <div>
              <div className="an-section-title">Volume Profile (last 30 sessions)</div>
              <div className="an-card" style={{ marginTop: 8 }}>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={result.volProfile.chartData} layout="vertical" margin={{ left: 0, right: 10, top: 4, bottom: 4 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="price" tickFormatter={(v) => fmt(v, 0)} width={52} tick={{ fill: "#888E99", fontSize: 10, fontFamily: "IBM Plex Mono, monospace" }} axisLine={false} tickLine={false} />
                    <Bar dataKey="volume" radius={[0, 3, 3, 0]}>
                      {result.volProfile.chartData.map((d, i) => <Cell key={i} fill={d.isPoc ? "#FFB454" : "#3A3F49"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div>
            <div className="an-section-title">Full Indicator Breakdown (30 inputs)</div>
            <div style={{ marginTop: 8 }}>
              <ReadingGrid readings={result.readings} />
            </div>
          </div>

          <div className="an-disclaimer">
            Ranges, probabilities, and the trade plan are computed from the real indicators above using a disclosed, transparent method — not a black box — but they're statistical estimates built on simplifying assumptions (approximately normal returns, ATR/IV as a volatility proxy), not guarantees. Dark pool activity and true real-time institutional order flow are marked unavailable rather than estimated, since no free data source provides them. Not financial advice.
          </div>
        </div>
      )}
    </div>
  );
}
