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
  ArrowUp,
  ArrowDown,
  Info,
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
const LAST_SYMBOL_KEY = "stockdesk:lastSymbol:deepdive";
// Deep Dive is the most expensive tab (options chain, fundamentals, macro tickers, insider data
// all in one run) — a short cache makes accidental re-runs (tab switch, duplicate submit) free.
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
    // Server-side proxy — runs on Vercel, so there's no browser CORS restriction to hit, unlike
    // third-party proxies which are free, unauthenticated, and prone to being rate-limited.
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error(`proxy http ${res.status}`);
    return parseYahooOHLCV(await res.json());
  }
}
// Tries the full requested range first (direct, then the internal proxy); if that fails, retries
// once more with a smaller 1-year range in case the larger payload is what's timing out.
async function fetchYahoo(symbol, range, interval) {
  try {
    return await fetchYahooOnce(symbol, range, interval);
  } catch (e) {
    if (range !== "1y") return await fetchYahooOnce(symbol, "1y", interval);
    throw e;
  }
}

// Wraps a Finnhub fetch so 401/403 responses are tagged distinctly from network failures —
// a 401/403 means "this key/plan can't use this endpoint," not "something is broken."
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

async function fetchDaily(symbol) {
  try {
    return { bars: await fetchYahoo(symbol, "2y", "1d"), source: "yahoo" };
  } catch (e) {
    // Note: Finnhub's free tier no longer serves /stock/candle (historical daily bars) at all —
    // it returns 401/403 even for plain US stocks — so there's no real fallback to try there.
    throw new Error("Couldn't pull price history from Yahoo, even through the built-in server-side proxy. Try again in a moment — if it keeps failing, Yahoo's endpoint itself may be temporarily rate-limiting this app's server.");
  }
}
async function fetchIntraday(symbol) {
  try {
    return { bars: await fetchYahoo(symbol, "1d", "5m"), source: "yahoo" };
  } catch (e) {
    return { bars: [], source: null };
  }
}
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
async function fetchFundamentals(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${apiKey}`;
  const data = await finnhubFetch(url);
  return data?.metric || null;
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
async function fetchEarningsCalendar(symbol, apiKey) {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${apiKey}`;
  const data = await finnhubFetch(url);
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
}
async function fetchMacroTicker(sym) {
  try {
    const bars = await fetchYahoo(sym, "3mo", "1d");
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const monthAgo = bars[Math.max(0, bars.length - 21)];
    return {
      symbol: sym,
      price: last.close,
      changePct: prev ? ((last.close - prev.close) / prev.close) * 100 : 0,
      monthChangePct: monthAgo ? ((last.close - monthAgo.close) / monthAgo.close) * 100 : null,
    };
  } catch (e) {
    return null;
  }
}

// ============================== MATH HELPERS ==============================

function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
function bsGamma(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const pdf = Math.exp((-d1 * d1) / 2) / Math.sqrt(2 * Math.PI);
  return pdf / (S * sigma * Math.sqrt(T));
}
function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== undefined && arr[i] !== null) return arr[i];
  return null;
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

// ============================== INDICATOR MATH ==============================

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
function rsiSeries(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(undefined);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function macdCalc(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  if (!e12.length || !e26.length) return null;
  const line = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] !== undefined && e26[i] !== undefined) line[i] = e12[i] - e26[i];
  const vals = line.filter((v) => v !== undefined);
  const sig = emaSeries(vals, 9);
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
  const below = series.filter((v) => v < value).length;
  return (below / series.length) * 100;
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
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}
function pivotPoints(prevBar) {
  const { high: h, low: l, close: c } = prevBar;
  const pp = (h + l + c) / 3;
  return { pp, r1: 2 * pp - l, s1: 2 * pp - h, r2: pp + (h - l), s2: pp - (h - l) };
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
  let adx = dx.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i].dx) / period;
  const last = dx[dx.length - 1];
  return { adx, plusDI: last.pDI, minusDI: last.mDI };
}
function supertrendCalc(bars, period = 10, mult = 3) {
  const atrs = atrSeries(bars, period);
  if (!atrs.length) return null;
  let trend = 1, finalUpper = null, finalLower = null, st = null;
  for (let i = period; i < bars.length; i++) {
    const atr = atrs[i];
    if (atr === undefined) continue;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + mult * atr, basicLower = hl2 - mult * atr;
    if (finalUpper === null) { finalUpper = basicUpper; finalLower = basicLower; st = basicLower; continue; }
    const prevClose = bars[i - 1].close;
    finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    if (trend === 1 && bars[i].close < finalLower) trend = -1;
    else if (trend === -1 && bars[i].close > finalUpper) trend = 1;
    st = trend === 1 ? finalLower : finalUpper;
  }
  return { value: st, direction: trend === 1 ? "up" : "down" };
}
function hl2Range(bars, period, endIdx) {
  const start = Math.max(0, endIdx - period + 1);
  const slice = bars.slice(start, endIdx + 1);
  return (Math.max(...slice.map((b) => b.high)) + Math.min(...slice.map((b) => b.low))) / 2;
}
function ichimokuCalc(bars) {
  const n = bars.length;
  if (n < 55) return null;
  const idx = n - 1;
  const tenkan = hl2Range(bars, 9, idx), kijun = hl2Range(bars, 26, idx);
  const cloudIdx = idx - 26 >= 0 ? idx - 26 : idx;
  const senkouA = (hl2Range(bars, 9, cloudIdx) + hl2Range(bars, 26, cloudIdx)) / 2;
  const senkouB = hl2Range(bars, 52, cloudIdx);
  const top = Math.max(senkouA, senkouB), bottom = Math.min(senkouA, senkouB);
  const price = bars[idx].close;
  return {
    tenkan, kijun, senkouA, senkouB,
    position: price > top ? "above" : price < bottom ? "below" : "inside",
    tkCross: tenkan > kijun ? "bullish" : tenkan < kijun ? "bearish" : "flat",
  };
}
function obvTrend(bars) {
  const out = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[i - 1];
    if (bars[i].close > bars[i - 1].close) out.push(prev + bars[i].volume);
    else if (bars[i].close < bars[i - 1].close) out.push(prev - bars[i].volume);
    else out.push(prev);
  }
  if (out.length < 21) return null;
  return { value: out[out.length - 1], slopeUp: out[out.length - 1] > out[out.length - 21] };
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
function anchoredVwapCalc(bars, lookback = 63) {
  const start = Math.max(0, bars.length - lookback);
  let minIdx = start;
  for (let i = start; i < bars.length; i++) if (bars[i].low < bars[minIdx].low) minIdx = i;
  let cumPV = 0, cumV = 0;
  for (let i = minIdx; i < bars.length; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    cumPV += tp * bars[i].volume; cumV += bars[i].volume;
  }
  return { value: cumV ? cumPV / cumV : null, anchorDate: new Date(bars[minIdx].t) };
}
function volumeProfileCalc(bars, bins = 22) {
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
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (volumes[i] > volumes[pocIdx]) pocIdx = i;
  return { poc: minP + binSize * (pocIdx + 0.5) };
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
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((p) => ({ pct: p, price: uptrend ? swingHigh - range * p : swingLow + range * p }));
  return { swingHigh, swingLow, uptrend, levels };
}
function relativeVolumeCalc(bars) {
  if (bars.length < 21) return null;
  const today = bars[bars.length - 1].volume;
  const prior = bars.slice(bars.length - 21, bars.length - 1);
  const avg = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  return avg ? today / avg : null;
}
function gapAnalysisCalc(bars) {
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const gapPct = ((bars[i].open - prevClose) / prevClose) * 100;
    if (Math.abs(gapPct) >= 1) gaps.push({ i, date: new Date(bars[i].t), gapPct, prevClose });
  }
  if (!gaps.length) return null;
  const last = gaps[gaps.length - 1];
  const after = bars.slice(last.i + 1);
  const filled = last.gapPct > 0 ? after.some((b) => b.low <= last.prevClose) : after.some((b) => b.high >= last.prevClose);
  return { ...last, filled, totalGaps: gaps.length };
}
function findSwings(bars, window = 3) {
  const highs = [], lows = [];
  for (let i = window; i < bars.length - window; i++) {
    const slice = bars.slice(i - window, i + window + 1);
    if (bars[i].high === Math.max(...slice.map((b) => b.high))) highs.push({ i, price: bars[i].high });
    if (bars[i].low === Math.min(...slice.map((b) => b.low))) lows.push({ i, price: bars[i].low });
  }
  return { highs, lows };
}
function marketStructureCalc(bars) {
  const { highs, lows } = findSwings(bars.slice(-120), 3);
  if (highs.length < 2 || lows.length < 2) return { label: "Not enough swing data in range", tag: "neutral" };
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  if (hh && hl) return { label: "Higher Highs & Higher Lows — uptrend structure intact", tag: "bullish" };
  if (!hh && !hl) return { label: "Lower Highs & Lower Lows — downtrend structure intact", tag: "bearish" };
  return { label: "Mixed pivots — no clean directional structure", tag: "neutral" };
}
function aggregateBars(bars, keyFn) {
  const map = new Map();
  for (const b of bars) {
    const key = keyFn(b);
    if (!map.has(key)) map.set(key, { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, t: b.t });
    else {
      const g = map.get(key);
      g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low); g.close = b.close; g.volume += b.volume;
    }
  }
  return Array.from(map.values());
}
function weeklyKey(b) {
  const d = new Date(b.t);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
function monthlyKey(b) {
  const d = new Date(b.t);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}
function trendFromBars(bars, label) {
  if (bars.length < 10) return { label, value: "insufficient data", tag: "neutral" };
  const closes = bars.map((b) => b.close);
  const ema = lastDefined(emaSeries(closes, Math.min(10, Math.floor(bars.length / 2))));
  const price = closes[closes.length - 1];
  const priorPrice = closes[Math.max(0, closes.length - 6)];
  const tag = price > priorPrice && (ema === null || price > ema) ? "bullish" : price < priorPrice && (ema === null || price < ema) ? "bearish" : "neutral";
  const pctMove = ((price - priorPrice) / priorPrice) * 100;
  return { label, value: `${pctMove >= 0 ? "+" : ""}${fmt(pctMove, 1)}% recent`, tag };
}

// ============================== OPTIONS ANALYSIS ==============================

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
function pickMetric(metric, keys) {
  if (!metric) return null;
  for (const k of keys) if (metric[k] !== undefined && metric[k] !== null) return metric[k];
  return null;
}

// ============================== SCORING ==============================

function categoryScore(readings) {
  const scoreable = readings.filter((r) => r.tag !== "unavailable");
  if (!scoreable.length) return null;
  const sum = scoreable.reduce((a, r) => a + (r.tag === "bullish" ? 1 : r.tag === "bearish" ? -1 : 0), 0);
  const norm = sum / scoreable.length;
  return Math.round((norm + 1) * 4.5 + 1);
}
function investmentRating(score) {
  if (score >= 8.5) return "Strong Buy";
  if (score >= 7) return "Buy";
  if (score >= 6) return "Accumulate";
  if (score >= 4.5) return "Hold";
  if (score >= 3) return "Reduce";
  return "Sell";
}
function probabilityBuckets(z) {
  const center = 50 + z * 35;
  const spread = 18;
  const cuts = [0, 20, 40, 60, 80, 100];
  const cdf = cuts.map((c) => normCdf((c - center) / spread));
  const probs = [];
  for (let i = 0; i < 5; i++) probs.push(Math.max(0.001, cdf[i + 1] - cdf[i]));
  const sum = probs.reduce((a, b) => a + b, 0);
  const rounded = probs.map((p) => Math.round((p / sum) * 100));
  const diff = 100 - rounded.reduce((a, b) => a + b, 0);
  rounded[2] += diff;
  return rounded; // [StrongBearish, Bearish, Neutral, Bullish, StrongBullish]
}
function priceTargetsFor(price, atr, z, days) {
  const move = atr * Math.sqrt(days);
  const drift = z * move * 0.3;
  return {
    conservative: price + drift * 0.4,
    base: price + drift,
    bull: price + drift + move * 0.8,
    bear: price + drift - move * 0.8,
    move,
  };
}
function confidenceFor(z, horizonPenalty) {
  return Math.max(20, Math.min(85, Math.round(50 + Math.abs(z) * 30 - horizonPenalty)));
}
function probToExceed(target, price, move) {
  if (!move) return null;
  return Math.round((1 - normCdf((target - price) / move)) * 100);
}
function probBelow(target, price, move) {
  if (!move) return null;
  return Math.round(normCdf((target - price) / move) * 100);
}

// ============================== UI HELPERS ==============================

const TAG_ICON = { bullish: TrendingUp, bearish: TrendingDown, neutral: Minus, unavailable: Info };

function ReadingGrid({ readings }) {
  const [activeHelp, setActiveHelp] = useState(null);
  return (
    <div className="dd-grid">
      {readings.map((r, i) => {
        const Icon = TAG_ICON[r.tag] || Minus;
        const glossary = matchGlossary(r.name);
        return (
          <div className="dd-card" key={i}>
            <div className="dd-card-top">
              <span className="dd-card-name">
                {r.name}
                {glossary && (
                  <button className="dd-help-btn" onClick={() => setActiveHelp(glossary)} aria-label={`What is ${r.name}?`}>
                    <HelpCircle size={12} />
                  </button>
                )}
              </span>
              <span className={`dd-tag-icon ${r.tag}`}>
                <Icon size={13} />
              </span>
            </div>
            <div className="dd-card-val">{r.value}</div>
            <div className="dd-card-note">{r.note}</div>
          </div>
        );
      })}
      <HelpModal entry={activeHelp} onClose={() => setActiveHelp(null)} />
    </div>
  );
}

function ScoreBar({ label, score }) {
  const pct = score ? (score / 10) * 100 : 0;
  const color = score >= 7 ? "#5FCBA0" : score >= 4.5 ? "#FFB454" : "#E8697A";
  return (
    <div className="dd-scorebar-row">
      <span className="dd-scorebar-label">{label}</span>
      <div className="dd-scorebar-track">
        <div className="dd-scorebar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="dd-scorebar-val" style={{ color }}>{score ?? "N/A"}</span>
    </div>
  );
}

// ============================== COMPONENT ==============================

export default function DeepDive() {
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

    try {
      const [dailyRes, intradayRes] = await Promise.all([fetchDaily(symbol), fetchIntraday(symbol)]);
      const bars = dailyRes.bars;
      if (bars.length < 210) {
        throw new Error(`Only ${bars.length} days of history returned — need ~210 for a reliable 200 SMA / full deep dive. Try again, or the data source may be limited for this ticker.`);
      }
      const closes = bars.map((b) => b.close);
      const price = closes[closes.length - 1];
      const prevBar = bars[bars.length - 2];

      // ---- optional/parallel fetches, each independently fault-tolerant ----
      const AUTH_ERR = "__finnhub_auth_error__";
      const [optionsRes, fundamentals, recTrend, insiders, earnings, macroList] = await Promise.all([
        fetchOptionsAnalysis(symbol).catch(() => null),
        apiKey ? fetchFundamentals(symbol, apiKey).catch((e) => (e.finnhubAuth ? AUTH_ERR : null)) : Promise.resolve(null),
        apiKey ? fetchRecommendationTrend(symbol, apiKey).catch((e) => (e.finnhubAuth ? AUTH_ERR : null)) : Promise.resolve(null),
        apiKey ? fetchInsiderTransactions(symbol, apiKey).catch((e) => (e.finnhubAuth ? AUTH_ERR : [])) : Promise.resolve([]),
        apiKey ? fetchEarningsCalendar(symbol, apiKey).catch((e) => (e.finnhubAuth ? AUTH_ERR : [])) : Promise.resolve([]),
        Promise.all(["^TNX", "^IRX", "DX-Y.NYB", "CL=F", "^VIX", "SPY", "XLK", "XLF", "XLE", "XLY", "XLP", "XLV"].map(fetchMacroTicker)),
      ]);

      // ================= 1. PRICE ACTION =================
      const weeklyBars = aggregateBars(bars, weeklyKey);
      const monthlyBars = aggregateBars(bars, monthlyKey);
      const dailyTrend = trendFromBars(bars.slice(-30), "Daily");
      const weeklyTrend = trendFromBars(weeklyBars.slice(-26), "Weekly");
      const monthlyTrend = trendFromBars(monthlyBars.slice(-24), "Monthly");
      const structure = marketStructureCalc(bars);
      const pivots = pivotPoints(prevBar);
      const gap = gapAnalysisCalc(bars.slice(-60));
      const bbWidths = bollingerWidthSeries(closes.slice(-160));
      const bb = bollinger(closes);
      const bbWidthNow = bb ? (bb.upper - bb.lower) / bb.middle : null;
      const widthPct = bbWidthNow !== null ? percentileRank(bbWidths, bbWidthNow) : null;
      let breakoutProb;
      if (widthPct !== null && widthPct < 20) breakoutProb = { label: "Elevated — Bollinger Band squeeze detected (width in bottom 20% of trailing range)", tag: "bullish" };
      else if (widthPct !== null && widthPct > 80) breakoutProb = { label: "Lower incremental odds — bands already wide/expanded; watch for mean reversion instead", tag: "neutral" };
      else breakoutProb = { label: "Moderate — no volatility compression/expansion extreme currently", tag: "neutral" };

      const priceActionReadings = [
        { name: "Daily Trend", value: dailyTrend.value, tag: dailyTrend.tag, note: "Price vs short EMA over the last ~30 sessions" },
        { name: "Weekly Trend", value: weeklyTrend.value, tag: weeklyTrend.tag, note: "Price vs short EMA over the last ~26 weeks" },
        { name: "Monthly Trend", value: monthlyTrend.value, tag: monthlyTrend.tag, note: "Price vs short EMA over the last ~24 months" },
        { name: "Market Structure", value: structure.label, tag: structure.tag, note: "Fractal swing-high/swing-low sequencing, last 120 sessions" },
        { name: "Support / Resistance (Pivots)", value: `S1 ${fmt(pivots.s1)} · PP ${fmt(pivots.pp)} · R1 ${fmt(pivots.r1)}`, tag: price > pivots.pp ? "bullish" : "bearish", note: "Classic pivots from prior session's H/L/C" },
        { name: "Breakout/Breakdown Probability", value: widthPct !== null ? `BB width at ${fmt(widthPct, 0)}th percentile` : "N/A", tag: breakoutProb.tag, note: breakoutProb.label },
        gap
          ? { name: "Gap Analysis", value: `${gap.gapPct > 0 ? "Gap up" : "Gap down"} ${fmt(Math.abs(gap.gapPct), 1)}% on ${gap.date.toLocaleDateString()}`, tag: gap.filled ? "neutral" : gap.gapPct > 0 ? "bullish" : "bearish", note: gap.filled ? "Gap has since been filled" : "Gap remains unfilled — often acts as a magnet for price" }
          : { name: "Gap Analysis", value: "No gaps ≥1% in the last 60 sessions", tag: "neutral", note: "Clean price action, no unresolved gap risk nearby" },
      ];

      // ================= 2. TECHNICAL INDICATORS =================
      const ema20 = lastDefined(emaSeries(closes, 20));
      const sma50 = smaAt(closes, 50);
      const sma100 = smaAt(closes, 100);
      const sma200 = smaAt(closes, 200);
      const rsi = lastDefined(rsiSeries(closes, 14));
      const macdRes = macdCalc(closes);
      const atr = lastDefined(atrSeries(bars, 14));
      const adx = adxCalc(bars);
      const supertrend = supertrendCalc(bars);
      const ichimoku = ichimokuCalc(bars);
      const volProfile = volumeProfileCalc(bars.slice(-60));
      const obv = obvTrend(bars);
      const cmf = cmfCalc(bars);
      const stochRsi = stochRsiCalc(closes);
      const fib = fibonacciCalc(bars);
      const anchoredVwap = anchoredVwapCalc(bars);
      const relVol = relativeVolumeCalc(bars);
      const intradayBars = intradayRes.bars || [];
      let sessionVwap = null;
      if (intradayBars.length) {
        let cumPV = 0, cumV = 0;
        for (const b of intradayBars) { const tp = (b.high + b.low + b.close) / 3; cumPV += tp * b.volume; cumV += b.volume; }
        sessionVwap = cumV ? cumPV / cumV : null;
      }

      const technicalReadings = [
        { name: "20 EMA", value: fmt(ema20), tag: ema20 !== null ? (price > ema20 ? "bullish" : "bearish") : "neutral", note: ema20 !== null ? `Price is ${price > ema20 ? "above" : "below"} the 20 EMA` : "Insufficient data" },
        { name: "50 SMA", value: fmt(sma50), tag: sma50 !== null ? (price > sma50 ? "bullish" : "bearish") : "neutral", note: sma50 !== null ? `Price is ${price > sma50 ? "above" : "below"} the 50 SMA` : "Insufficient data" },
        { name: "100 SMA", value: fmt(sma100), tag: sma100 !== null ? (price > sma100 ? "bullish" : "bearish") : "neutral", note: sma100 !== null ? `Price is ${price > sma100 ? "above" : "below"} the 100 SMA` : "Insufficient data" },
        { name: "200 SMA", value: fmt(sma200), tag: sma200 !== null ? (price > sma200 ? "bullish" : "bearish") : "neutral", note: sma200 !== null ? `Long-term trend is ${price > sma200 ? "bullish (above 200 SMA)" : "bearish (below 200 SMA)"}` : "Insufficient data" },
        { name: "Anchored VWAP", value: fmt(anchoredVwap.value), tag: anchoredVwap.value !== null ? (price > anchoredVwap.value ? "bullish" : "bearish") : "neutral", note: `Anchored to swing low on ${anchoredVwap.anchorDate.toLocaleDateString()} (last ~1 quarter)` },
        { name: "RSI (14)", value: fmt(rsi, 1), tag: rsi !== null ? (rsi > 60 ? "bullish" : rsi < 40 ? "bearish" : "neutral") : "neutral", note: rsi !== null ? (rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "No extreme reading") : "Insufficient data" },
        { name: "MACD (12,26,9)", value: macdRes?.histogram !== null ? `hist ${fmt(macdRes.histogram, 2)}` : "N/A", tag: macdRes?.histogram !== null ? (macdRes.histogram > 0 ? "bullish" : "bearish") : "neutral", note: "MACD line vs signal line" },
        { name: "ATR (14)", value: fmt(atr), tag: "neutral", note: `${fmt((atr / price) * 100, 1)}% of price — daily volatility magnitude, not directional` },
        { name: "Bollinger Bands (20,2)", value: bb ? `${fmt(bb.lower)} – ${fmt(bb.upper)}` : "N/A", tag: bb ? (price > bb.upper ? "bearish" : price < bb.lower ? "bullish" : "neutral") : "neutral", note: bb ? (price > bb.upper ? "Price above upper band — extended" : price < bb.lower ? "Price below lower band — extended" : "Trading inside the bands") : "Insufficient data" },
        { name: "Fibonacci", value: fib ? `${fmt(fib.swingLow)} – ${fmt(fib.swingHigh)}` : "N/A", tag: "neutral", note: fib ? `${fib.uptrend ? "Uptrend" : "Downtrend"} retracement range, last 90 sessions` : "Insufficient data" },
        { name: "ADX (14)", value: adx ? fmt(adx.adx, 1) : "N/A", tag: adx ? (adx.adx > 25 ? (adx.plusDI > adx.minusDI ? "bullish" : "bearish") : "neutral") : "neutral", note: adx ? (adx.adx > 25 ? `Trending market (+DI ${fmt(adx.plusDI, 0)} vs -DI ${fmt(adx.minusDI, 0)})` : "Weak/no trend (ADX below 25)") : "Insufficient data" },
        { name: "Supertrend (10,3)", value: supertrend ? fmt(supertrend.value) : "N/A", tag: supertrend ? (supertrend.direction === "up" ? "bullish" : "bearish") : "neutral", note: supertrend ? `Flipped ${supertrend.direction === "up" ? "bullish" : "bearish"}` : "Insufficient data" },
        { name: "Ichimoku Cloud", value: ichimoku ? `${ichimoku.position} cloud` : "N/A", tag: ichimoku ? (ichimoku.position === "above" ? "bullish" : ichimoku.position === "below" ? "bearish" : "neutral") : "neutral", note: ichimoku ? `Tenkan/Kijun cross: ${ichimoku.tkCross}` : "Insufficient data" },
        { name: "Volume Profile (VPVR)", value: volProfile ? `POC ${fmt(volProfile.poc)}` : "N/A", tag: volProfile ? (price > volProfile.poc ? "bullish" : "bearish") : "neutral", note: "Point of control, last 60 sessions" },
        { name: "OBV", value: obv ? fmtBig(obv.value) : "N/A", tag: obv ? (obv.slopeUp ? "bullish" : "bearish") : "neutral", note: obv ? `${obv.slopeUp ? "Rising" : "Falling"} vs 21 sessions ago — ${obv.slopeUp ? "accumulation" : "distribution"} signature` : "Insufficient data" },
        { name: "CMF (20)", value: cmf !== null ? fmt(cmf, 3) : "N/A", tag: cmf !== null ? (cmf > 0.05 ? "bullish" : cmf < -0.05 ? "bearish" : "neutral") : "neutral", note: cmf !== null ? (cmf > 0 ? "Net buying pressure" : "Net selling pressure") : "Insufficient data" },
        { name: "Stochastic RSI", value: stochRsi ? `K ${fmt(stochRsi.k, 0)} / D ${fmt(stochRsi.d, 0)}` : "N/A", tag: stochRsi ? (stochRsi.k > 80 ? "bearish" : stochRsi.k < 20 ? "bullish" : "neutral") : "neutral", note: stochRsi ? (stochRsi.k > 80 ? "Overbought" : stochRsi.k < 20 ? "Oversold" : "Neutral zone") : "Insufficient data" },
      ];

      // ================= 3. VOLUME ANALYSIS =================
      const volumeReadings = [
        { name: "Relative Volume", value: relVol !== null ? `${fmt(relVol, 2)}x` : "N/A", tag: relVol !== null ? (relVol > 1.3 ? "bullish" : relVol < 0.7 ? "neutral" : "neutral") : "neutral", note: relVol !== null ? (relVol > 1.5 ? "Well above average — high conviction move" : relVol < 0.7 ? "Below average — light participation" : "Roughly average") : "Insufficient data" },
        { name: "Volume Spike Check", value: relVol !== null ? (relVol > 2 ? "Spike detected" : "No spike") : "N/A", tag: relVol !== null && relVol > 2 ? "bullish" : "neutral", note: "Flagged when today's volume exceeds 2x the 20-day average" },
        { name: "Accumulation / Distribution", value: obv && cmf !== null ? (obv.slopeUp && cmf > 0 ? "Accumulation" : !obv.slopeUp && cmf < 0 ? "Distribution" : "Mixed") : "N/A", tag: obv && cmf !== null ? (obv.slopeUp && cmf > 0 ? "bullish" : !obv.slopeUp && cmf < 0 ? "bearish" : "neutral") : "neutral", note: "OBV trend + CMF sign combined" },
        { name: "Session VWAP Positioning", value: sessionVwap !== null ? fmt(sessionVwap) : "N/A", tag: sessionVwap !== null ? (price > sessionVwap ? "bullish" : "bearish") : "neutral", note: sessionVwap !== null ? `Price is ${price > sessionVwap ? "above" : "below"} today's VWAP` : "Intraday data unavailable" },
        { name: "Buying / Selling Pressure", value: cmf !== null ? (cmf > 0 ? "Buyers in control" : "Sellers in control") : "N/A", tag: cmf !== null ? (cmf > 0 ? "bullish" : "bearish") : "neutral", note: "Chaikin Money Flow sign over 20 sessions" },
      ];

      // ================= 4. INSTITUTIONAL ACTIVITY =================
      const institutionalReadings = [];
      if (apiKey && Array.isArray(insiders) && insiders.length) {
        const recent = insiders.slice(0, 20);
        const buyShares = recent.filter((t) => t.transactionCode === "P" || t.change > 0).reduce((a, t) => a + Math.abs(t.change || 0), 0);
        const sellShares = recent.filter((t) => t.transactionCode === "S" || t.change < 0).reduce((a, t) => a + Math.abs(t.change || 0), 0);
        const net = buyShares - sellShares;
        institutionalReadings.push({
          name: "Insider Transactions (Finnhub, recent filings)",
          value: `${fmtBig(buyShares)} bought / ${fmtBig(sellShares)} sold`,
          tag: net > 0 ? "bullish" : net < 0 ? "bearish" : "neutral",
          note: "Real SEC Form 4 data — most recent filings on record",
        });
      } else if (insiders === AUTH_ERR) {
        institutionalReadings.push({ name: "Insider Transactions", value: "Not on your Finnhub plan", tag: "unavailable", note: "This endpoint returned 401/403 — it may require a paid Finnhub plan, not just a key" });
      } else {
        institutionalReadings.push({ name: "Insider Transactions", value: apiKey ? "No recent filings" : "Requires Finnhub API key", tag: "unavailable", note: apiKey ? "No Form 4 activity in Finnhub's recent window" : "Add a free Finnhub key from the Watchlist tab to enable" });
      }
      if (apiKey && recTrend && recTrend !== AUTH_ERR) {
        const total = recTrend.strongBuy + recTrend.buy + recTrend.hold + recTrend.sell + recTrend.strongSell;
        const bullish = recTrend.strongBuy + recTrend.buy, bearish = recTrend.sell + recTrend.strongSell;
        institutionalReadings.push({
          name: "Analyst Recommendation Trend",
          value: `${recTrend.strongBuy}SB / ${recTrend.buy}B / ${recTrend.hold}H / ${recTrend.sell}S / ${recTrend.strongSell}SS`,
          tag: bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral",
          note: `${total} covering analysts, period ${recTrend.period}`,
        });
      } else if (recTrend === AUTH_ERR) {
        institutionalReadings.push({ name: "Analyst Recommendation Trend", value: "Not on your Finnhub plan", tag: "unavailable", note: "This endpoint returned 401/403 — it may require a paid Finnhub plan, not just a key" });
      } else {
        institutionalReadings.push({ name: "Analyst Recommendation Trend", value: apiKey ? "N/A for this ticker" : "Requires Finnhub API key", tag: "unavailable", note: "Real analyst buy/hold/sell counts when available" });
      }
      institutionalReadings.push(
        { name: "Dark Pool Activity", value: "Not available", tag: "unavailable", note: "Requires a paid dark-pool print feed (e.g. FlowAlgo, Cheddar Flow) — not accessible via free APIs" },
        { name: "13F Filings", value: "Not available", tag: "unavailable", note: "13F data is quarterly and delayed up to 45 days; no free real-time API exists" },
        { name: "Block Trades", value: "Not available", tag: "unavailable", note: "Requires a Tape/consolidated print feed with block-trade tagging — not accessible via free APIs" },
        { name: "ETF Inflows/Outflows", value: "Not available", tag: "unavailable", note: "Requires a paid fund-flow data provider (e.g. ETF.com, VettaFi)" },
        { name: "Mutual Fund Accumulation", value: "Not available", tag: "unavailable", note: "Requires holdings-change data not exposed by free APIs" }
      );
      const instScoreable = institutionalReadings.filter((r) => r.tag !== "unavailable");
      const institutionalSentiment = instScoreable.length ? (instScoreable.filter((r) => r.tag === "bullish").length >= instScoreable.filter((r) => r.tag === "bearish").length ? "Mildly Positive" : "Mildly Negative") : "No real institutional signal available";

      // ================= 5. OPTIONS MARKET =================
      const optionsReadings = [];
      let optionsData = null;
      if (optionsRes) {
        const { calls, puts, expirations } = optionsRes;
        const pcr = putCallRatios(calls, puts);
        const maxPain = computeMaxPain(calls, puts);
        const walls = callPutWalls(calls, puts);
        const iv = atmIV(calls, puts, price);
        const T = expirations[0] ? Math.max(1 / 365, (expirations[0] * 1000 - Date.now()) / (365 * 24 * 3600 * 1000)) : 7 / 365;
        const riskFree = (macroList.find((m) => m?.symbol === "^IRX")?.price || 4.5) / 100;
        const gex = computeGEX(calls, puts, price, riskFree, T);
        const expectedMoveW = price * ((iv || 30) / 100) * Math.sqrt(7 / 365);
        optionsData = { pcr, maxPain, walls, iv, gex, expectedMoveW, expiry: expirations[0] ? new Date(expirations[0] * 1000) : null };
        optionsReadings.push(
          { name: "Put/Call OI Ratio", value: pcr.oiRatio !== null ? fmt(pcr.oiRatio, 2) : "N/A", tag: pcr.oiRatio !== null ? (pcr.oiRatio < 0.7 ? "bullish" : pcr.oiRatio > 1.3 ? "bearish" : "neutral") : "neutral", note: `Call OI ${fmtBig(pcr.callOI)} vs Put OI ${fmtBig(pcr.putOI)}, nearest expiry` },
          { name: "Max Pain", value: maxPain !== null ? fmt(maxPain, 0) : "N/A", tag: maxPain !== null ? (price > maxPain ? "bearish" : "bullish") : "neutral", note: maxPain !== null ? `Price is ${fmt(Math.abs(((price - maxPain) / maxPain) * 100), 1)}% ${price > maxPain ? "above" : "below"} max pain` : "N/A" },
          { name: "Call Wall / Put Wall", value: `${fmt(walls.callWall, 0)} / ${fmt(walls.putWall, 0)}`, tag: "neutral", note: "Strikes with the largest call and put open interest — common gamma-driven pin/resistance/support zones" },
          { name: "Gamma Exposure (GEX, approx.)", value: fmtBig(gex), tag: gex > 0 ? "bullish" : "bearish", note: gex > 0 ? "Net positive — dealer positioning historically associated with vol-dampening, range-bound action" : "Net negative — historically associated with vol-amplifying, trending moves. Approximated via Black-Scholes gamma × OI, not a real dealer-position feed." },
          { name: "IV (ATM, nearest expiry)", value: iv !== null ? `${fmt(iv, 1)}%` : "N/A", tag: "neutral", note: optionsData.expiry ? `Expiry ${optionsData.expiry.toLocaleDateString()}` : "N/A" },
          { name: "Expected Move (weekly)", value: `±${fmt(expectedMoveW)}`, tag: "neutral", note: "From ATM IV, nearest expiry" }
        );
      } else {
        optionsReadings.push({ name: "Options Chain", value: "Unavailable", tag: "unavailable", note: "Yahoo's options endpoint didn't respond (direct + proxy both failed) — options section can't be computed for this ticker right now" });
      }
      optionsReadings.push(
        { name: "Dealer Positioning (directional)", value: "Not available", tag: "unavailable", note: "Requires a market-maker positioning feed; GEX sign above is the closest computable proxy" },
        { name: "Large Unusual Options Trades", value: "Not available", tag: "unavailable", note: "Requires an options-flow scanner (e.g. Unusual Whales) — not accessible via free APIs" },
        { name: "IV Rank / Percentile", value: "Proxy only", tag: "unavailable", note: "True IV history isn't available for free; realized-volatility percentile is used elsewhere as an imperfect substitute" }
      );

      // ================= 6. FUNDAMENTALS =================
      const fundamentalReadings = [];
      let valuation = "Unknown";
      if (fundamentals && fundamentals !== AUTH_ERR) {
        const peTTM = pickMetric(fundamentals, ["peTTM", "peBasicExclExtraTTM", "peExclExtraTTM", "peNormalizedAnnual"]);
        const forwardPE = pickMetric(fundamentals, ["peForward", "forwardPE"]);
        const roe = pickMetric(fundamentals, ["roeTTM", "roeRfy"]);
        const roic = pickMetric(fundamentals, ["roicTTM", "roiTTM"]);
        const grossMargin = pickMetric(fundamentals, ["grossMarginTTM", "grossMarginAnnual"]);
        const netMargin = pickMetric(fundamentals, ["netProfitMarginTTM", "netProfitMarginAnnual"]);
        const debtEquity = pickMetric(fundamentals, ["totalDebt/totalEquityAnnual", "totalDebt/totalEquityQuarterly"]);
        const epsGrowth = pickMetric(fundamentals, ["epsGrowthTTMYoy", "epsGrowth5Y", "epsGrowth3Y"]);
        const revGrowth = pickMetric(fundamentals, ["revenueGrowthTTMYoy", "revenueGrowth5Y", "revenueGrowth3Y"]);
        const peg = peTTM && epsGrowth && epsGrowth > 0 ? peTTM / epsGrowth : pickMetric(fundamentals, ["pegRatio"]);
        valuation = peTTM === null ? "Unknown" : peTTM < 15 ? "Cheap" : peTTM < 25 ? "Fair" : "Expensive";
        fundamentalReadings.push(
          { name: "P/E (TTM)", value: peTTM !== null ? fmt(peTTM, 1) : "N/A", tag: "neutral", note: `Valuation read: ${valuation}` },
          { name: "Forward P/E", value: forwardPE !== null ? fmt(forwardPE, 1) : "N/A", tag: "neutral", note: forwardPE === null ? "Not provided by Finnhub free tier for this ticker" : "" },
          { name: "PEG Ratio", value: peg !== null ? fmt(peg, 2) : "N/A", tag: peg !== null ? (peg < 1 ? "bullish" : peg > 2 ? "bearish" : "neutral") : "neutral", note: peg !== null ? (peg < 1 ? "Growth-adjusted valuation looks attractive" : peg > 2 ? "Rich relative to growth" : "Reasonable") : "N/A" },
          { name: "Revenue Growth (YoY)", value: revGrowth !== null ? `${fmt(revGrowth, 1)}%` : "N/A", tag: revGrowth !== null ? (revGrowth > 10 ? "bullish" : revGrowth < 0 ? "bearish" : "neutral") : "neutral", note: "" },
          { name: "EPS Growth (YoY)", value: epsGrowth !== null ? `${fmt(epsGrowth, 1)}%` : "N/A", tag: epsGrowth !== null ? (epsGrowth > 10 ? "bullish" : epsGrowth < 0 ? "bearish" : "neutral") : "neutral", note: "" },
          { name: "ROE (TTM)", value: roe !== null ? `${fmt(roe, 1)}%` : "N/A", tag: roe !== null ? (roe > 15 ? "bullish" : roe < 5 ? "bearish" : "neutral") : "neutral", note: "" },
          { name: "ROIC (TTM)", value: roic !== null ? `${fmt(roic, 1)}%` : "N/A", tag: roic !== null ? (roic > 10 ? "bullish" : roic < 3 ? "bearish" : "neutral") : "neutral", note: "" },
          { name: "Gross / Net Margin", value: `${grossMargin !== null ? fmt(grossMargin, 1) + "%" : "N/A"} / ${netMargin !== null ? fmt(netMargin, 1) + "%" : "N/A"}`, tag: "neutral", note: "" },
          { name: "Debt / Equity", value: debtEquity !== null ? fmt(debtEquity, 2) : "N/A", tag: debtEquity !== null ? (debtEquity < 0.5 ? "bullish" : debtEquity > 1.5 ? "bearish" : "neutral") : "neutral", note: "" }
        );
      } else if (fundamentals === AUTH_ERR) {
        fundamentalReadings.push({ name: "Fundamentals", value: "Not on your Finnhub plan", tag: "unavailable", note: "The /stock/metric endpoint returned 401/403 — it may require a paid Finnhub plan, not just a key" });
      } else {
        fundamentalReadings.push({ name: "Fundamentals", value: apiKey ? "Not available for this ticker" : "Requires Finnhub API key", tag: "unavailable", note: apiKey ? "Finnhub's free-tier metric set may not cover this ticker" : "Add a free Finnhub key from the Watchlist tab to enable P/E, growth, margins, ROE/ROIC, and more" });
      }

      // ================= 7. MACRO ENVIRONMENT =================
      const macro = {};
      for (const m of macroList) if (m) macro[m.symbol] = m;
      const macroReadings = [];
      if (macro["^TNX"]) macroReadings.push({ name: "10Y Treasury Yield", value: `${fmt(macro["^TNX"].price / 10, 2)}%`, tag: macro["^TNX"].monthChangePct > 0 ? "bearish" : "bullish", note: `${fmt(macro["^TNX"].monthChangePct, 1)}% over the past month — rising yields are typically a headwind for equity valuations, especially growth` });
      if (macro["^IRX"]) macroReadings.push({ name: "13-Week T-Bill (risk-free proxy)", value: `${fmt(macro["^IRX"].price / 10, 2)}%`, tag: "neutral", note: "Used as the risk-free rate in this report's options math" });
      if (macro["DX-Y.NYB"]) macroReadings.push({ name: "US Dollar Index (DXY)", value: fmt(macro["DX-Y.NYB"].price, 1), tag: macro["DX-Y.NYB"].monthChangePct > 0 ? "bearish" : "bullish", note: `${fmt(macro["DX-Y.NYB"].monthChangePct, 1)}% over the past month — a stronger dollar is typically a headwind for multinational earnings and commodities` });
      if (macro["CL=F"]) macroReadings.push({ name: "WTI Crude Oil", value: fmt(macro["CL=F"].price, 2), tag: "neutral", note: `${fmt(macro["CL=F"].monthChangePct, 1)}% over the past month — relevant for energy-sector and input-cost exposure` });
      if (macro["^VIX"]) macroReadings.push({ name: "VIX (Volatility Index)", value: fmt(macro["^VIX"].price, 1), tag: macro["^VIX"].price > 25 ? "bearish" : macro["^VIX"].price < 15 ? "bullish" : "neutral", note: macro["^VIX"].price > 25 ? "Elevated fear/hedging demand" : macro["^VIX"].price < 15 ? "Complacent/low-fear regime" : "Normal range" });
      if (macro["SPY"]) {
        const spyBars = null; // regime approximated from month change alone to avoid another fetch
        macroReadings.push({ name: "S&P 500 (SPY) Regime", value: `${fmt(macro["SPY"].monthChangePct, 1)}% (1mo)`, tag: macro["SPY"].monthChangePct > 0 ? "bullish" : "bearish", note: "Broad market backdrop — most single stocks correlate with this regime" });
      }
      const sectorEtfs = ["XLK", "XLF", "XLE", "XLY", "XLP", "XLV"].map((s) => macro[s]).filter(Boolean);
      if (sectorEtfs.length) {
        const sorted = [...sectorEtfs].sort((a, b) => (b.monthChangePct || 0) - (a.monthChangePct || 0));
        macroReadings.push({ name: "Sector Rotation", value: `Leader: ${sorted[0].symbol} (+${fmt(sorted[0].monthChangePct, 1)}%) · Laggard: ${sorted[sorted.length - 1].symbol} (${fmt(sorted[sorted.length - 1].monthChangePct, 1)}%)`, tag: "neutral", note: "1-month relative performance across major SPDR sector ETFs" });
      }

      // ================= SCORES =================
      const momentumReadings = technicalReadings.filter((r) => ["RSI (14)", "MACD (12,26,9)", "Stochastic RSI", "ADX (14)", "OBV", "CMF (20)"].includes(r.name));
      const trendReadings = technicalReadings.filter((r) => !momentumReadings.includes(r));
      const technicalScore = categoryScore([...trendReadings, ...priceActionReadings]);
      const momentumScore = categoryScore(momentumReadings);
      const institutionalScore = instScoreable.length ? categoryScore(institutionalReadings) : 5;
      const optionsScore = categoryScore(optionsReadings);
      const fundamentalScore = (fundamentals && fundamentals !== AUTH_ERR) ? (categoryScore(fundamentalReadings) ?? 5) : 5;
      const macroScore = categoryScore(macroReadings) ?? 5;
      const vix = macro["^VIX"]?.price ?? 20;
      const atrPct = (atr / price) * 100;
      let riskScore = 6;
      if (vix > 28) riskScore -= 2; else if (vix < 15) riskScore += 1;
      if (atrPct > 5) riskScore -= 1;
      riskScore = Math.max(1, Math.min(10, riskScore));

      const weights = { technical: 0.25, momentum: 0.15, institutional: 0.1, options: 0.15, fundamentals: 0.15, macro: 0.1, risk: 0.1 };
      const scores = { technical: technicalScore ?? 5, momentum: momentumScore ?? 5, institutional: institutionalScore ?? 5, options: optionsScore ?? 5, fundamentals: fundamentalScore ?? 5, macro: macroScore ?? 5, risk: riskScore ?? 5 };
      const overallScore = Object.keys(weights).reduce((a, k) => a + scores[k] * weights[k], 0);
      const rating = investmentRating(overallScore);

      // composite z for probability model (-1..1), blends technical+momentum+options, macro/institutional as smaller tilt
      const z = Math.max(-1, Math.min(1, ((scores.technical - 5.5) / 4.5) * 0.4 + ((scores.momentum - 5.5) / 4.5) * 0.3 + ((scores.options - 5.5) / 4.5) * 0.2 + ((scores.macro - 5.5) / 4.5) * 0.1));
      const buckets = probabilityBuckets(z);
      const bucketLabels = ["Strong Bearish", "Bearish", "Neutral", "Bullish", "Strong Bullish"];

      // ================= PRICE TARGETS =================
      const targets = {
        week: { ...priceTargetsFor(price, atr, z, 5), days: 5, label: "Next Week (5 trading days)" },
        month: { ...priceTargetsFor(price, atr, z, 21), days: 21, label: "Next Month (~21 trading days)" },
        quarter: { ...priceTargetsFor(price, atr, z, 63), days: 63, label: "Next Quarter (~63 trading days)" },
      };
      for (const key of Object.keys(targets)) {
        const t = targets[key];
        t.confidence = confidenceFor(z, key === "week" ? 0 : key === "month" ? 10 : 20);
      }

      // ================= TRADING PLAN =================
      const bullishBias = z > 0.1, bearishBias = z < -0.1;
      let tradingPlan;
      if (bullishBias) {
        tradingPlan = {
          bias: "Long-biased",
          entryLow: Math.min(pivots.pp, ema20 ?? price), entryHigh: price,
          stopLoss: price - 1.5 * atr,
          tp1: price + 1 * atr, tp2: price + 2 * atr, tp3: targets.month.bull,
        };
      } else if (bearishBias) {
        tradingPlan = {
          bias: "Short-biased / defensive",
          entryLow: price, entryHigh: Math.max(pivots.pp, ema20 ?? price),
          stopLoss: price + 1.5 * atr,
          tp1: price - 1 * atr, tp2: price - 2 * atr, tp3: targets.month.bear,
        };
      } else {
        tradingPlan = {
          bias: "Range-bound / no clear edge",
          entryLow: bb?.lower ?? price - atr, entryHigh: bb?.upper ?? price + atr,
          stopLoss: null,
          tp1: bb?.middle ?? price, tp2: null, tp3: null,
        };
      }

      // ================= RISK CATALYSTS =================
      const upside = [];
      const downside = [];
      if (optionsData) {
        upside.push(`Break and hold above the call wall ($${fmt(optionsData.walls.callWall, 0)}) could accelerate gains if dealers are short gamma there.`);
        downside.push(`Failure to hold the put wall ($${fmt(optionsData.walls.putWall, 0)}) removes a key positioning-based support level.`);
        if (optionsData.gex < 0) upside.push("Negative GEX regime (approx.) — historically associated with larger, faster moves in either direction, including to the upside.");
        if (optionsData.gex > 0) downside.push("Positive GEX regime (approx.) — dealer hedging has historically dampened volatility, capping both upside and downside follow-through.");
      }
      if (sma200 !== null) (price > sma200 ? upside : downside).push(`Price is trading ${price > sma200 ? "above" : "below"} the 200 SMA ($${fmt(sma200)}) — the primary long-term trend filter most institutional trend-followers use.`);
      if (structure.tag === "bullish") upside.push("Higher-high/higher-low structure remains intact on the daily chart.");
      if (structure.tag === "bearish") downside.push("Lower-high/lower-low structure remains intact on the daily chart — trend-followers likely to stay defensive.");
      if (relVol !== null && relVol > 1.5) upside.push(`Relative volume running at ${fmt(relVol, 1)}x average — elevated participation can extend the current move.`);
      if (vix > 25) downside.push(`VIX at ${fmt(vix, 1)} — elevated market-wide fear/hedging can pressure individual names regardless of company-specific fundamentals.`);
      if (vix < 15) upside.push(`VIX at ${fmt(vix, 1)} — low market-wide fear historically correlates with risk-on conditions for equities.`);
      if (macro["^TNX"] && macro["^TNX"].monthChangePct < 0) upside.push("Falling 10Y yields over the past month ease the discount-rate headwind on equity valuations.");
      if (macro["^TNX"] && macro["^TNX"].monthChangePct > 0) downside.push("Rising 10Y yields over the past month increase the discount-rate headwind on equity valuations, especially for long-duration growth names.");
      if (apiKey && Array.isArray(earnings) && earnings.length) upside.push(`Earnings scheduled ${new Date(earnings[0].date).toLocaleDateString()} — a beat-and-raise could re-rate the stock (also a two-sided risk, see downside).`), downside.push(`Same earnings date (${new Date(earnings[0].date).toLocaleDateString()}) is a binary risk event — a miss or guide-down could gap the stock lower.`);
      if (fundamentals && fundamentals !== AUTH_ERR) {
        const revGrowth = pickMetric(fundamentals, ["revenueGrowthTTMYoy"]);
        if (revGrowth !== null && revGrowth > 15) upside.push(`Revenue growing ${fmt(revGrowth, 1)}% YoY — durable top-line momentum supports a premium multiple if sustained.`);
        if (revGrowth !== null && revGrowth < 0) downside.push(`Revenue contracting ${fmt(Math.abs(revGrowth), 1)}% YoY — a fundamental headwind to any technical bounce.`);
      }
      upside.push("Sector rotation into this stock's sector (see Macro section) could bring incremental flows.");
      downside.push("Broad market drawdown risk — even fundamentally sound stocks typically fall in a systemic risk-off event.");
      upside.push("Short-covering potential if positioning is crowded short (directional short interest itself isn't available from free data, but a negative GEX/heavy put OI combination is a loose proxy).");
      downside.push("Liquidity/volume risk — the sharper relative volume declines below 0.7x, the less reliable technical signals become in this name.");
      while (upside.length < 6) upside.push("See the News and Events tabs for company- and macro-specific catalysts not captured by this quantitative framework.");
      while (downside.length < 6) downside.push("See the News and Events tabs for company- and macro-specific risks not captured by this quantitative framework.");

      const resultData = {
        symbol, price, rating, overallScore, scores, weights,
        priceActionReadings, technicalReadings, volumeReadings, institutionalReadings, institutionalSentiment,
        optionsReadings, optionsData, fundamentalReadings, valuation, macroReadings,
        buckets, bucketLabels, targets, tradingPlan, upside: upside.slice(0, 10), downside: downside.slice(0, 10),
        z, atr, dataSource: dailyRes.source, hasKey: !!apiKey,
      };
      setResult(resultData);
      analysisCache.set(symbol, { data: resultData, at: Date.now() });
      writeLocal(LAST_SYMBOL_KEY, symbol);
    } catch (e) {
      setError(e?.message || `Couldn't complete the deep dive for ${symbol}. Try again in a moment.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dd-root">
      <style>{`
        .dd-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 50px; }
        .dd-header { padding: 22px 24px 6px; }
        .dd-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .dd-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .dd-search-row { padding: 16px 24px 6px; display: flex; gap: 10px; }
        .dd-search-box { flex: 1; max-width: 420px; display: flex; align-items: center; gap: 8px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 6px; padding: 0 12px; }
        .dd-search-box:focus-within { border-color: #FFB454; }
        .dd-search-box input { background: transparent; border: none; outline: none; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 10px 4px; width: 100%; }
        .dd-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 0 18px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; cursor: pointer; }
        .dd-btn:disabled { opacity: 0.6; }
        .dd-error { margin: 10px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .dd-loading { display: flex; align-items: center; gap: 8px; padding: 60px 24px; justify-content: center; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .dd-skel { background: linear-gradient(90deg, #1C1F25 25%, #24272E 37%, #1C1F25 63%); background-size: 400% 100%; animation: dd-shimmer 1.4s ease infinite; border-radius: 8px; border: 1px solid #2A2E36; }
        .dd-skel-summary { height: 90px; margin-bottom: 22px; }
        .dd-skel-card { height: 76px; }
        @keyframes dd-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .dd-body { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 22px; }
        .dd-section-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.02em; margin: 0 0 8px; color: #FFB454; border-bottom: 1px solid #2A2E36; padding-bottom: 6px; }
        .dd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
        .dd-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 12px 13px; }
        .dd-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
        .dd-card-name { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
        .dd-help-btn { background: transparent; border: none; color: #5A5F68; cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
        .dd-help-btn:hover { color: #FFB454; }
        .dd-card-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #ADB1B9; margin-top: 3px; }
        .dd-card-note { font-size: 11px; color: #888E99; margin-top: 5px; line-height: 1.4; }
        .dd-tag-icon.bullish { color: #5FCBA0; } .dd-tag-icon.bearish { color: #E8697A; } .dd-tag-icon.neutral { color: #C99A4B; } .dd-tag-icon.unavailable { color: #5A5F68; }
        .dd-summary { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 12px; padding: 20px; display: flex; flex-wrap: wrap; gap: 22px; align-items: center; }
        .dd-sym { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 24px; }
        .dd-price { font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #ADB1B9; }
        .dd-rating { padding: 10px 20px; border-radius: 10px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 18px; }
        .dd-rating.buy { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .dd-rating.hold { background: rgba(201,154,75,0.14); color: #C99A4B; }
        .dd-rating.sell { background: rgba(232,105,122,0.14); color: #E8697A; }
        .dd-overall { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #888E99; }
        .dd-scorebar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .dd-scorebar-label { width: 100px; font-size: 12px; color: #ADB1B9; font-family: 'IBM Plex Sans Condensed', sans-serif; }
        .dd-scorebar-track { flex: 1; height: 8px; background: #0D0E11; border-radius: 4px; overflow: hidden; }
        .dd-scorebar-fill { height: 100%; border-radius: 4px; }
        .dd-scorebar-val { width: 28px; text-align: right; font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; }
        .dd-buckets { display: flex; gap: 8px; flex-wrap: wrap; }
        .dd-bucket { flex: 1; min-width: 90px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 10px; text-align: center; }
        .dd-bucket-pct { font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 700; color: #FFB454; }
        .dd-bucket-label { font-size: 10px; color: #888E99; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
        .dd-targets-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: 'IBM Plex Mono', monospace; }
        .dd-targets-table th, .dd-targets-table td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #2A2E36; }
        .dd-targets-table th:first-child, .dd-targets-table td:first-child { text-align: left; }
        .dd-targets-table th { color: #888E99; font-weight: 600; font-size: 10.5px; text-transform: uppercase; }
        .dd-plan-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
        .dd-plan-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 12px; text-align: center; }
        .dd-plan-card .lbl { font-size: 10px; color: #888E99; text-transform: uppercase; letter-spacing: 0.04em; }
        .dd-plan-card .val { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 700; margin-top: 4px; }
        .dd-risk-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 600px) { .dd-risk-cols { grid-template-columns: 1fr; } }
        .dd-risk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .dd-risk-item { font-size: 12px; line-height: 1.5; padding: 8px 10px; border-radius: 6px; background: #1C1F25; border: 1px solid #2A2E36; }
        .dd-disclaimer { font-size: 10.5px; color: #5A5F68; line-height: 1.6; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 14px; }
        .dd-valuation-badge { display: inline-block; padding: 3px 10px; border-radius: 5px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 12px; }
        .dd-valuation-badge.Cheap { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .dd-valuation-badge.Fair { background: rgba(201,154,75,0.14); color: #C99A4B; }
        .dd-valuation-badge.Expensive { background: rgba(232,105,122,0.14); color: #E8697A; }
        .dd-valuation-badge.Unknown { background: rgba(90,95,104,0.2); color: #888E99; }
      `}</style>

      <div className="dd-header">
        <h1>DEEP DIVE</h1>
        <p>Institutional-framework research report — 12-part analysis with real data where available, honest gaps where not</p>
      </div>

      <form className="dd-search-row" onSubmit={handleAnalyze}>
        <div className="dd-search-box">
          <Search size={15} color="#5A5F68" />
          <input placeholder="Enter a ticker, e.g. AAPL" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={10} />
        </div>
        <button className="dd-btn" type="submit" disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          {loading ? "Analyzing" : "Deep Dive"}
        </button>
      </form>

      {error && (
        <div className="dd-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}
      {loading && (
        <>
          <div className="dd-loading">
            <Loader2 size={16} className="spin" /> pulling price history, options chain, fundamentals, and macro data — this takes longer than the quick Analyzer, and retries automatically if a data source is briefly unavailable…
          </div>
          <div className="dd-body" style={{ paddingTop: 0 }}>
            <div className="dd-skel dd-skel-summary" />
            <div className="dd-grid">
              {Array.from({ length: 8 }).map((_, i) => <div className="dd-skel dd-skel-card" key={i} />)}
            </div>
          </div>
        </>
      )}

      {result && !loading && (
        <div className="dd-body">
          {!result.hasKey && (
            <div className="dd-error" style={{ background: "rgba(255,180,84,0.08)", borderColor: "rgba(255,180,84,0.3)", color: "#E0B872" }}>
              <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>No Finnhub key found — Fundamentals, Insider Transactions, and Analyst Recommendations are skipped. Add a free key from the Watchlist tab's "connect data" button to unlock them.</span>
            </div>
          )}

          {/* Summary */}
          <div className="dd-summary">
            <div>
              <div className="dd-sym">{result.symbol}</div>
              <div className="dd-price">${fmt(result.price)}</div>
            </div>
            <div className={`dd-rating ${result.rating.includes("Buy") || result.rating === "Accumulate" ? "buy" : result.rating === "Hold" ? "hold" : "sell"}`}>
              {result.rating}
            </div>
            <div className="dd-overall">
              Overall Score: {fmt(result.overallScore, 1)}/10 (weighted)
              <br />
              Data: {result.dataSource === "yahoo" ? "Yahoo" : "Finnhub"} daily · {result.optionsData ? "live options chain" : "options unavailable"}
            </div>
          </div>

          {/* 1. Price Action */}
          <div>
            <div className="dd-section-title">1 · Price Action</div>
            <ReadingGrid readings={result.priceActionReadings} />
          </div>

          {/* 2. Technical Indicators */}
          <div>
            <div className="dd-section-title">2 · Technical Indicators (17)</div>
            <ReadingGrid readings={result.technicalReadings} />
          </div>

          {/* 3. Volume Analysis */}
          <div>
            <div className="dd-section-title">3 · Volume Analysis</div>
            <ReadingGrid readings={result.volumeReadings} />
          </div>

          {/* 4. Institutional Activity */}
          <div>
            <div className="dd-section-title">4 · Institutional Activity — Institutional Sentiment: {result.institutionalSentiment}</div>
            <ReadingGrid readings={result.institutionalReadings} />
          </div>

          {/* 5. Options Market */}
          <div>
            <div className="dd-section-title">5 · Options Market</div>
            <ReadingGrid readings={result.optionsReadings} />
          </div>

          {/* 6. Fundamentals */}
          <div>
            <div className="dd-section-title">
              6 · Fundamentals — Valuation: <span className={`dd-valuation-badge ${result.valuation}`}>{result.valuation}</span>
            </div>
            <ReadingGrid readings={result.fundamentalReadings} />
          </div>

          {/* 7. Macro Environment */}
          <div>
            <div className="dd-section-title">7 · Macro Environment</div>
            <ReadingGrid readings={result.macroReadings.length ? result.macroReadings : [{ name: "Macro", value: "Unavailable", tag: "unavailable", note: "Macro ticker fetch failed" }]} />
          </div>

          {/* 8. AI Probability Analysis */}
          <div>
            <div className="dd-section-title">8 · AI Probability Analysis</div>
            <div className="dd-buckets">
              {result.bucketLabels.map((l, i) => (
                <div className="dd-bucket" key={l}>
                  <div className="dd-bucket-pct">{result.buckets[i]}%</div>
                  <div className="dd-bucket-label">{l}</div>
                </div>
              ))}
            </div>
            <div className="dd-card-note" style={{ marginTop: 8 }}>
              Model-generated distribution from this report's technical/momentum/options/macro composite score (z = {fmt(result.z, 2)}) — not a calibrated statistical forecast, and does not incorporate institutional flow data unavailable to this tool.
            </div>
          </div>

          {/* 9. Price Targets */}
          <div>
            <div className="dd-section-title">9 · Price Targets</div>
            <table className="dd-targets-table">
              <thead>
                <tr>
                  <th>Horizon</th><th>Bear</th><th>Conservative</th><th>Base</th><th>Bull</th><th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(result.targets).map((t) => (
                  <tr key={t.label}>
                    <td>{t.label}</td>
                    <td style={{ color: "#E8697A" }}>${fmt(t.bear)}</td>
                    <td>${fmt(t.conservative)}</td>
                    <td style={{ color: "#FFB454" }}>${fmt(t.base)}</td>
                    <td style={{ color: "#5FCBA0" }}>${fmt(t.bull)}</td>
                    <td>{t.confidence}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dd-card-note" style={{ marginTop: 8 }}>
              Derived from ATR-based volatility scaling (±ATR×√trading-days) with directional drift from the composite score. Confidence is a heuristic (higher indicator agreement + shorter horizon = higher), not a statistical guarantee.
            </div>
          </div>

          {/* 10. Trading Plan */}
          <div>
            <div className="dd-section-title">10 · Trading Plan — {result.tradingPlan.bias}</div>
            <div className="dd-plan-grid">
              <div className="dd-plan-card"><div className="lbl">Entry Zone</div><div className="val">${fmt(result.tradingPlan.entryLow)}–${fmt(result.tradingPlan.entryHigh)}</div></div>
              <div className="dd-plan-card"><div className="lbl">Stop Loss</div><div className="val" style={{ color: "#E8697A" }}>{result.tradingPlan.stopLoss ? `$${fmt(result.tradingPlan.stopLoss)}` : "N/A"}</div></div>
              <div className="dd-plan-card"><div className="lbl">Take Profit 1</div><div className="val" style={{ color: "#5FCBA0" }}>${fmt(result.tradingPlan.tp1)}</div></div>
              <div className="dd-plan-card"><div className="lbl">Take Profit 2</div><div className="val" style={{ color: "#5FCBA0" }}>{result.tradingPlan.tp2 ? `$${fmt(result.tradingPlan.tp2)}` : "N/A"}</div></div>
              <div className="dd-plan-card"><div className="lbl">Take Profit 3</div><div className="val" style={{ color: "#5FCBA0" }}>{result.tradingPlan.tp3 ? `$${fmt(result.tradingPlan.tp3)}` : "N/A"}</div></div>
            </div>
          </div>

          {/* 11. Risk Analysis */}
          <div>
            <div className="dd-section-title">11 · Risk Analysis</div>
            <div className="dd-risk-cols">
              <div>
                <div className="dd-card-name" style={{ color: "#5FCBA0", marginBottom: 6 }}>Top Upside Catalysts</div>
                <ul className="dd-risk-list">{result.upside.map((u, i) => <li className="dd-risk-item" key={i}>{u}</li>)}</ul>
              </div>
              <div>
                <div className="dd-card-name" style={{ color: "#E8697A", marginBottom: 6 }}>Top Downside Risks</div>
                <ul className="dd-risk-list">{result.downside.map((d, i) => <li className="dd-risk-item" key={i}>{d}</li>)}</ul>
              </div>
            </div>
          </div>

          {/* 12. Final Rating */}
          <div>
            <div className="dd-section-title">12 · Final Rating</div>
            <ScoreBar label="Technical" score={result.scores.technical} />
            <ScoreBar label="Momentum" score={result.scores.momentum} />
            <ScoreBar label="Institutional" score={result.scores.institutional} />
            <ScoreBar label="Options" score={result.scores.options} />
            <ScoreBar label="Fundamentals" score={result.scores.fundamentals} />
            <ScoreBar label="Macro" score={result.scores.macro} />
            <ScoreBar label="Risk" score={result.scores.risk} />
            <div className="dd-summary" style={{ marginTop: 14 }}>
              <div>
                <div className="dd-card-name">Investment Rating</div>
                <div className={`dd-rating ${result.rating.includes("Buy") || result.rating === "Accumulate" ? "buy" : result.rating === "Hold" ? "hold" : "sell"}`} style={{ marginTop: 6 }}>{result.rating}</div>
              </div>
              <div className="dd-overall">
                P(reach Base Target, next month): {probToExceed(result.targets.month.base, result.price, result.targets.month.move) ?? "N/A"}%
                <br />
                P(exceed Bull Case, next month): {probToExceed(result.targets.month.bull, result.price, result.targets.month.move) ?? "N/A"}%
                <br />
                P(fall below Bear Case, next month): {probBelow(result.targets.month.bear, result.price, result.targets.month.move) ?? "N/A"}%
              </div>
            </div>
            <div className="dd-card-note" style={{ marginTop: 8 }}>
              Overall score is a weighted average (Technical 25%, Momentum 15%, Options 15%, Fundamentals 15%, Institutional 10%, Macro 10%, Risk 10%). Reach/exceed/fall-below probabilities assume approximately normally distributed returns with standard deviation equal to this report's ATR-derived expected move — a simplification, not a calibrated options-market-implied distribution.
            </div>
          </div>

          <div className="dd-disclaimer">
            <strong>What's real vs. modeled:</strong> Price action, all 17 technical indicators, volume metrics, options OI/max-pain/walls/GEX-approximation, macro tickers, and (with a Finnhub key) fundamentals/insider filings/analyst trends are computed from live market data. Dark pool activity, 13F filings, block trades, ETF fund flows, mutual fund accumulation, true dealer positioning, and unusual-options-flow scanning are <strong>not available from free data sources</strong> and are explicitly marked "Not available" above rather than estimated. AI probability buckets, price target confidence, and reach/exceed probabilities are this tool's own statistical model built on the indicators above — not predictions, not calibrated to historical accuracy, and not financial advice. This is not a substitute for a licensed financial advisor.
          </div>
        </div>
      )}
    </div>
  );
}
