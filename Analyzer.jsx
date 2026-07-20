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
  ReferenceLine,
} from "recharts";
import {
  Search,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  HelpCircle,
} from "lucide-react";

const FETCH_TIMEOUT_MS = 8000;
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
const LAST_SYMBOL_KEY = "stockdesk:lastSymbol:analyzer";
// Short-TTL client-side cache: re-analyzing the same ticker within a minute (easy to do by
// accident — switching tabs and back, or a duplicate submit) reuses the last result instead of
// refiring 10+ requests.
const analysisCache = new Map();
const CACHE_TTL_MS = 60000;

// ---------- data fetching: Yahoo direct -> Yahoo via proxy -> Finnhub backup ----------

function parseYahooOHLCV(data) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("no result");
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i],
      h = q.high?.[i],
      l = q.low?.[i],
      c = q.close?.[i],
      v = q.volume?.[i];
    if ([o, h, l, c].some((x) => x === null || x === undefined)) continue;
    bars.push({ t: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: v || 0 });
  }
  if (!bars.length) throw new Error("no bars");
  return bars;
}

async function fetchYahoo(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}`;
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

async function fetchFinnhubDaily(symbol, apiKey, days) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 60 * 60;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
    symbol
  )}&resolution=D&from=${from}&to=${now}&token=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`finnhub http ${res.status}`);
  const c = await res.json();
  if (c.s !== "ok" || !Array.isArray(c.c) || !c.c.length) throw new Error("no finnhub data");
  return c.t.map((t, i) => ({
    t: t * 1000,
    open: c.o[i],
    high: c.h[i],
    low: c.l[i],
    close: c.c[i],
    volume: c.v[i] || 0,
  }));
}

async function fetchFinnhubIntraday(symbol, apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 24 * 60 * 60;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
    symbol
  )}&resolution=5&from=${from}&to=${now}&token=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`finnhub http ${res.status}`);
  const c = await res.json();
  if (c.s !== "ok" || !Array.isArray(c.c) || !c.c.length) throw new Error("no finnhub data");
  return c.t.map((t, i) => ({
    t: t * 1000,
    open: c.o[i],
    high: c.h[i],
    low: c.l[i],
    close: c.c[i],
    volume: c.v[i] || 0,
  }));
}

async function fetchDaily(symbol, apiKey) {
  try {
    return { bars: await fetchYahoo(symbol, "6mo", "1d"), source: "yahoo" };
  } catch (e) {
    if (apiKey) {
      return { bars: await fetchFinnhubDaily(symbol, apiKey, 180), source: "finnhub" };
    }
    throw e;
  }
}

async function fetchIntraday(symbol, apiKey) {
  try {
    return { bars: await fetchYahoo(symbol, "1d", "5m"), source: "yahoo" };
  } catch (e) {
    if (apiKey) {
      return { bars: await fetchFinnhubIntraday(symbol, apiKey), source: "finnhub" };
    }
    throw e;
  }
}

// Best-effort implied volatility from Yahoo's options chain (nearest weekly expiry, ATM strike).
// Falls back to null if unavailable — caller uses historical volatility instead.
async function fetchImpliedVolatility(symbol, currentPrice) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const tryParse = (data) => {
    const result = data?.optionChain?.result?.[0];
    if (!result) return null;
    const expirations = result.expirationDates || [];
    if (!expirations.length) return null;
    const options = result.options?.[0];
    if (!options) return null;
    const calls = options.calls || [];
    const puts = options.puts || [];
    const all = [...calls, ...puts].filter((o) => o.impliedVolatility);
    if (!all.length) return null;
    let closest = all[0];
    let bestDiff = Math.abs(closest.strike - currentPrice);
    for (const o of all) {
      const diff = Math.abs(o.strike - currentPrice);
      if (diff < bestDiff) {
        bestDiff = diff;
        closest = o;
      }
    }
    const expiryDays = Math.max(
      1,
      Math.round((expirations[0] * 1000 - Date.now()) / (24 * 60 * 60 * 1000))
    );
    return { iv: closest.impliedVolatility * 100, expiryDays };
  };
  try {
    const res = await fetchWithTimeout(url, { mode: "cors" });
    if (!res.ok) throw new Error("http error");
    const parsed = tryParse(await res.json());
    if (parsed) return parsed;
    throw new Error("unparseable");
  } catch (e) {
    try {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
      const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
      if (!res.ok) throw new Error("proxy http error");
      const parsed = tryParse(await res.json());
      return parsed;
    } catch (e2) {
      return null;
    }
  }
}

// ---------- indicator math ----------

function sma(values, period) {
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

function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== undefined) return arr[i];
  return null;
}

function rsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  if (!ema12.length || !ema26.length) return null;
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] !== undefined && ema26[i] !== undefined) macdLine[i] = ema12[i] - ema26[i];
  }
  const macdValues = macdLine.filter((v) => v !== undefined);
  const signalSeries = emaSeries(macdValues, 9);
  const signal = lastDefined(signalSeries);
  const macdNow = lastDefined(macdLine);
  if (macdNow === null || signal === null) return { macd: macdNow, signal: null, histogram: null };
  return { macd: macdNow, signal, histogram: macdNow - signal };
}

function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

function atr14(bars) {
  const period = 14;
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high,
      l = bars[i].low,
      pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function pivotPoints(prevBar) {
  const { high: h, low: l, close: c } = prevBar;
  const pp = (h + l + c) / 3;
  return {
    pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + (h - l),
    s2: pp - (h - l),
    r3: h + 2 * (pp - l),
    s3: l - 2 * (h - pp),
  };
}

// Aggregate daily bars into Monday-start weekly OHLCV bars.
function aggregateWeekly(bars) {
  const weeks = new Map();
  for (const b of bars) {
    const d = new Date(b.t);
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = (day + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - diffToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.getTime();
    if (!weeks.has(key)) {
      weeks.set(key, { weekStart: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      const w = weeks.get(key);
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
    }
  }
  return Array.from(weeks.values()).sort((a, b) => a.weekStart - b.weekStart);
}

function currentWeekMonday() {
  const d = new Date();
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.getTime();
}

// Weekly price range per the requested 4-step method:
// 1) options-implied weekly move  2) compare vs ATR-based move
// 3) weekly pivot levels (from the last fully completed week)
// 4) confirm/tilt with volume profile + moving-average trend
function computeWeeklyRange({ price, impliedMove, atrMove, weeklyBars, ema20, ema50, volProfile }) {
  const thisMonday = currentWeekMonday();
  const priorWeeks = weeklyBars.filter((w) => w.weekStart < thisMonday);
  if (!priorWeeks.length) return null;
  const lastWeek = priorWeeks[priorWeeks.length - 1];
  const weeklyPivots = pivotPoints(lastWeek);

  const moveUsed = impliedMove !== null ? (impliedMove + atrMove) / 2 : atrMove;
  const moveCompareNote =
    impliedMove !== null
      ? impliedMove > atrMove
        ? `Options-implied move (±$${fmt(impliedMove)}) is larger than the ATR-based move (±$${fmt(atrMove)}) — options are pricing in more movement than recent realized volatility, often a sign of event risk (earnings, macro) ahead.`
        : `Options-implied move (±$${fmt(impliedMove)}) is smaller than the ATR-based move (±$${fmt(atrMove)}) — options may be underpricing recent realized volatility.`
      : `No live options-implied move available; using the ATR-based estimate (±$${fmt(atrMove)}) only.`;

  let rawHigh = (price + moveUsed + weeklyPivots.r1) / 2;
  let rawLow = (price - moveUsed + weeklyPivots.s1) / 2;

  const trendBias = ema20 !== null && ema50 !== null ? (price > ema20 && ema20 > ema50 ? 1 : price < ema20 && ema20 < ema50 ? -1 : 0) : 0;
  const volBias = volProfile ? (price > volProfile.poc ? 1 : -1) : 0;
  const combined = trendBias + volBias;
  const tilt = combined !== 0 ? moveUsed * 0.08 * combined : 0;

  const weeklyHigh = rawHigh + tilt;
  const weeklyLow = rawLow + tilt;

  let confirmationNote;
  if (combined >= 1) {
    confirmationNote = "20/50 EMA trend and volume profile both lean bullish — range nudged toward the upside.";
  } else if (combined <= -1) {
    confirmationNote = "20/50 EMA trend and volume profile both lean bearish — range nudged toward the downside.";
  } else {
    confirmationNote = "Trend and volume profile don't agree on direction — range left roughly centered on spot.";
  }

  return {
    weeklyPivots,
    lastWeek,
    moveUsed,
    moveCompareNote,
    confirmationNote,
    weeklyHigh,
    weeklyLow,
  };
}

function vwap(intradayBars) {
  let cumPV = 0,
    cumV = 0;
  for (const b of intradayBars) {
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * b.volume;
    cumV += b.volume;
  }
  if (!cumV) return null;
  return cumPV / cumV;
}

function volumeProfile(bars, bins = 22) {
  if (!bars.length) return null;
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const maxP = Math.max(...highs);
  const minP = Math.min(...lows);
  if (maxP === minP) return null;
  const binSize = (maxP - minP) / bins;
  const volumes = new Array(bins).fill(0);
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    let idx = Math.floor((typical - minP) / binSize);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    volumes[idx] += b.volume;
  }
  const totalVol = volumes.reduce((a, b) => a + b, 0);
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (volumes[i] > volumes[pocIdx]) pocIdx = i;
  const poc = minP + binSize * (pocIdx + 0.5);

  // value area: expand outward from POC until ~70% of volume is captured
  let included = new Set([pocIdx]);
  let coveredVol = volumes[pocIdx];
  let lo = pocIdx,
    hi = pocIdx;
  while (coveredVol / totalVol < 0.7 && (lo > 0 || hi < bins - 1)) {
    const nextLo = lo > 0 ? volumes[lo - 1] : -1;
    const nextHi = hi < bins - 1 ? volumes[hi + 1] : -1;
    if (nextHi >= nextLo) {
      hi++;
      coveredVol += volumes[hi];
      included.add(hi);
    } else {
      lo--;
      coveredVol += volumes[lo];
      included.add(lo);
    }
  }
  const vaHigh = minP + binSize * (hi + 1);
  const vaLow = minP + binSize * lo;

  const chartData = volumes.map((v, i) => ({
    price: minP + binSize * (i + 0.5),
    volume: v,
    isPoc: i === pocIdx,
  }));
  return { poc, vaHigh, vaLow, chartData };
}

function fibonacci(bars, lookback = 90) {
  const slice = bars.slice(Math.max(0, bars.length - lookback));
  if (slice.length < 5) return null;
  let highIdx = 0,
    lowIdx = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high > slice[highIdx].high) highIdx = i;
    if (slice[i].low < slice[lowIdx].low) lowIdx = i;
  }
  const swingHigh = slice[highIdx].high;
  const swingLow = slice[lowIdx].low;
  const uptrend = lowIdx < highIdx; // low happened before high -> rally, measuring pullback levels
  const range = swingHigh - swingLow;
  const levelPct = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const retracements = levelPct.map((p) => ({
    pct: p,
    price: uptrend ? swingHigh - range * p : swingLow + range * p,
  }));
  const extPct = [1.272, 1.618, 2.618];
  const extensions = extPct.map((p) => ({
    pct: p,
    price: uptrend ? swingHigh - range * p : swingLow + range * p,
  }));
  return { swingHigh, swingLow, uptrend, retracements, extensions };
}

function relativeVolume(bars) {
  if (bars.length < 21) return null;
  const today = bars[bars.length - 1].volume;
  const prior = bars.slice(bars.length - 21, bars.length - 1);
  const avg = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  if (!avg) return null;
  return today / avg;
}

function historicalVolatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const rets = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ---------- composite scoring ----------

function buildReadings(ctx) {
  const { price, ema20, ema50, rsi, macdRes, bb, vwapVal, pivots, volProfile, fib, relVol } = ctx;
  const readings = [];
  let score = 0;

  // Trend: price vs EMA20/EMA50
  if (ema20 !== null && ema50 !== null) {
    if (price > ema20 && ema20 > ema50) {
      score += 2;
      readings.push({ name: "20/50 EMA Trend", value: `${fmt(ema20)} / ${fmt(ema50)}`, tag: "bullish", note: "Price above both, short EMA above long — uptrend" });
    } else if (price < ema20 && ema20 < ema50) {
      score -= 2;
      readings.push({ name: "20/50 EMA Trend", value: `${fmt(ema20)} / ${fmt(ema50)}`, tag: "bearish", note: "Price below both, short EMA below long — downtrend" });
    } else {
      readings.push({ name: "20/50 EMA Trend", value: `${fmt(ema20)} / ${fmt(ema50)}`, tag: "neutral", note: "EMAs mixed with price — no clean trend" });
    }
  }

  // RSI
  if (rsi !== null) {
    if (rsi < 30) {
      score += 1;
      readings.push({ name: "RSI (14)", value: fmt(rsi, 1), tag: "bullish", note: "Oversold — momentum stretched to the downside" });
    } else if (rsi > 70) {
      score -= 1;
      readings.push({ name: "RSI (14)", value: fmt(rsi, 1), tag: "bearish", note: "Overbought — momentum stretched to the upside" });
    } else if (rsi >= 50) {
      score += 0.5;
      readings.push({ name: "RSI (14)", value: fmt(rsi, 1), tag: "neutral", note: "Above midline — mild bullish momentum" });
    } else {
      score -= 0.5;
      readings.push({ name: "RSI (14)", value: fmt(rsi, 1), tag: "neutral", note: "Below midline — mild bearish momentum" });
    }
  }

  // MACD
  if (macdRes && macdRes.histogram !== null) {
    if (macdRes.histogram > 0) {
      score += 1;
      readings.push({ name: "MACD (12,26,9)", value: `hist ${fmt(macdRes.histogram, 2)}`, tag: "bullish", note: "MACD above signal — bullish momentum" });
    } else {
      score -= 1;
      readings.push({ name: "MACD (12,26,9)", value: `hist ${fmt(macdRes.histogram, 2)}`, tag: "bearish", note: "MACD below signal — bearish momentum" });
    }
  }

  // Bollinger Bands
  if (bb) {
    if (price > bb.upper) {
      score -= 1;
      readings.push({ name: "Bollinger Bands (20,2)", value: `${fmt(bb.lower)} – ${fmt(bb.upper)}`, tag: "bearish", note: "Price above upper band — extended, pullback risk" });
    } else if (price < bb.lower) {
      score += 1;
      readings.push({ name: "Bollinger Bands (20,2)", value: `${fmt(bb.lower)} – ${fmt(bb.upper)}`, tag: "bullish", note: "Price below lower band — extended, bounce potential" });
    } else {
      readings.push({ name: "Bollinger Bands (20,2)", value: `${fmt(bb.lower)} – ${fmt(bb.upper)}`, tag: "neutral", note: "Trading inside the bands" });
    }
  }

  // VWAP
  if (vwapVal !== null) {
    if (price > vwapVal) {
      score += 1;
      readings.push({ name: "VWAP", value: fmt(vwapVal), tag: "bullish", note: "Price above session VWAP — intraday buyers in control" });
    } else {
      score -= 1;
      readings.push({ name: "VWAP", value: fmt(vwapVal), tag: "bearish", note: "Price below session VWAP — intraday sellers in control" });
    }
  }

  // Pivot points
  if (pivots) {
    if (price > pivots.pp) {
      score += 0.5;
      readings.push({ name: "Pivot Points", value: `PP ${fmt(pivots.pp)}`, tag: "bullish", note: `Above pivot — R1 ${fmt(pivots.r1)}, S1 ${fmt(pivots.s1)}` });
    } else {
      score -= 0.5;
      readings.push({ name: "Pivot Points", value: `PP ${fmt(pivots.pp)}`, tag: "bearish", note: `Below pivot — R1 ${fmt(pivots.r1)}, S1 ${fmt(pivots.s1)}` });
    }
  }

  // Volume Profile
  if (volProfile) {
    if (price > volProfile.poc) {
      score += 0.5;
      readings.push({ name: "Volume Profile", value: `POC ${fmt(volProfile.poc)}`, tag: "bullish", note: "Trading above point of control — above accepted value" });
    } else {
      score -= 0.5;
      readings.push({ name: "Volume Profile", value: `POC ${fmt(volProfile.poc)}`, tag: "bearish", note: "Trading below point of control — below accepted value" });
    }
  }

  // Fibonacci — proximity to a level within 1%
  if (fib) {
    const allLevels = [...fib.retracements, ...fib.extensions];
    let nearest = allLevels[0];
    let bestDiff = Math.abs(nearest.price - price);
    for (const lvl of allLevels) {
      const diff = Math.abs(lvl.price - price);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = lvl;
      }
    }
    const pctAway = (bestDiff / price) * 100;
    if (pctAway < 1) {
      const supportive = fib.uptrend ? price >= nearest.price : price <= nearest.price;
      if (supportive) {
        score += 0.5;
        readings.push({ name: "Fibonacci", value: `${(nearest.pct * 100).toFixed(1)}% level`, tag: "bullish", note: `Within 1% of the ${(nearest.pct * 100).toFixed(1)}% level, holding as support` });
      } else {
        score -= 0.5;
        readings.push({ name: "Fibonacci", value: `${(nearest.pct * 100).toFixed(1)}% level`, tag: "bearish", note: `Within 1% of the ${(nearest.pct * 100).toFixed(1)}% level, acting as resistance` });
      }
    } else {
      readings.push({ name: "Fibonacci", value: `${fmt(fib.swingLow)} – ${fmt(fib.swingHigh)} range`, tag: "neutral", note: "Not currently near a key retracement level" });
    }
  }

  // Relative volume — conviction multiplier, not directional on its own
  if (relVol !== null) {
    const tag = relVol > 1.5 ? "bullish" : relVol < 0.5 ? "neutral" : "neutral";
    readings.push({
      name: "Relative Volume",
      value: `${fmt(relVol, 2)}x`,
      tag,
      note: relVol > 1.5 ? "Well above average — conviction behind the move" : relVol < 0.5 ? "Below average — light participation" : "Roughly average volume",
    });
    if (relVol > 1.5) score = score * 1.15;
  }

  return { readings, score };
}

function signalFromScore(score) {
  if (score >= 3) return { label: "BUY", tag: "bullish" };
  if (score <= -3) return { label: "SELL", tag: "bearish" };
  return { label: "HOLD", tag: "neutral" };
}

// ---------- component ----------

const TAG_ICON = { bullish: TrendingUp, bearish: TrendingDown, neutral: Minus };

function fibStatus(levelPrice, currentPrice) {
  const pctAway = Math.abs(levelPrice - currentPrice) / currentPrice;
  if (pctAway < 0.0015) return "current";
  return levelPrice > currentPrice ? "resistance" : "support";
}
const FIB_STATUS_LABEL = { resistance: "Resistance", support: "Support", current: "At price" };

export default function Analyzer() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [activeHelp, setActiveHelp] = useState(null);
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
      const [dailyRes, intradayRes] = await Promise.all([
        fetchDaily(symbol, apiKey),
        fetchIntraday(symbol, apiKey).catch(() => null),
      ]);
      const bars = dailyRes.bars;
      if (bars.length < 55) {
        throw new Error("Not enough daily history returned to compute 50 EMA / Bollinger Bands reliably.");
      }
      const closes = bars.map((b) => b.close);
      const price = closes[closes.length - 1];
      const prevBar = bars[bars.length - 2];

      const ema20Series = emaSeries(closes, 20);
      const ema50Series = emaSeries(closes, 50);
      const ema20 = lastDefined(ema20Series);
      const ema50 = lastDefined(ema50Series);
      const rsi = rsi14(closes);
      const macdRes = macd(closes);
      const bb = bollinger(closes);
      const atr = atr14(bars);
      const pivots = pivotPoints(prevBar);
      const intradayBars = intradayRes?.bars || [];
      const vwapVal = intradayBars.length ? vwap(intradayBars) : null;
      const volProfile = volumeProfile(bars.slice(-30));
      const fib = fibonacci(bars);
      const relVol = relativeVolume(bars);
      const histVol = historicalVolatility(closes);

      let ivResult = null;
      try {
        ivResult = await fetchImpliedVolatility(symbol, price);
      } catch (e) {
        ivResult = null;
      }
      const iv = ivResult?.iv ?? histVol;
      const ivIsProxy = !ivResult;
      const ivExpiryDays = ivResult?.expiryDays ?? 7;

      const { readings, score } = buildReadings({
        price,
        ema20,
        ema50,
        rsi,
        macdRes,
        bb,
        vwapVal,
        pivots,
        volProfile,
        fib,
        relVol,
      });
      const signal = signalFromScore(score);

      // Daily target range: blend pivot R1/S1 with an ATR band around the prior close
      const atrHigh = price + atr;
      const atrLow = price - atr;
      const dailyHigh = pivots ? (pivots.r1 + atrHigh) / 2 : atrHigh;
      const dailyLow = pivots ? (pivots.s1 + atrLow) / 2 : atrLow;

      // Weekly expected move from IV (or historical-vol proxy) and separately from ATR
      const weeklyMoveFromIV = iv ? price * (iv / 100) * Math.sqrt(ivExpiryDays / 365) : null;
      const weeklyMoveFromATR = atr * Math.sqrt(5);
      const weeklyMove = weeklyMoveFromIV ?? weeklyMoveFromATR;

      // Weekly price range: implied move vs ATR, weekly pivots, confirmed by volume profile + EMAs
      const weeklyBars = aggregateWeekly(bars);
      const weeklyRange = computeWeeklyRange({
        price,
        impliedMove: weeklyMoveFromIV,
        atrMove: weeklyMoveFromATR,
        weeklyBars,
        ema20,
        ema50,
        volProfile,
      });

      let optionsIdea;
      if (signal.label === "BUY") {
        optionsIdea = {
          structure: "Bullish credit put spread",
          detail: `Short put near ${fmt(price - weeklyMove)} (~1 weekly expected move below spot), long put further out of the money for defined risk. Profits if ${symbol} stays above the short strike through expiry.`,
        };
      } else if (signal.label === "SELL") {
        optionsIdea = {
          structure: "Bearish credit call spread",
          detail: `Short call near ${fmt(price + weeklyMove)} (~1 weekly expected move above spot), long call further out of the money for defined risk. Profits if ${symbol} stays below the short strike through expiry.`,
        };
      } else {
        optionsIdea = {
          structure: "Neutral iron condor",
          detail: `Short strikes near ${fmt(price - weeklyMove)} and ${fmt(price + weeklyMove)} (~1 weekly expected move on each side), long strikes further out for defined risk. Profits if ${symbol} stays inside that range through expiry.`,
        };
      }

      const resultData = {
        symbol,
        price,
        signal,
        score,
        readings,
        dailyHigh,
        dailyLow,
        pivots,
        atr,
        weeklyMove,
        weeklyMoveFromIV,
        weeklyMoveFromATR,
        weeklyRange,
        iv,
        ivIsProxy,
        optionsIdea,
        volProfile,
        fib,
        relVol,
        dataSource: dailyRes.source,
        intradaySource: intradayRes?.source ?? null,
      };
      setResult(resultData);
      analysisCache.set(symbol, { data: resultData, at: Date.now() });
      writeLocal(LAST_SYMBOL_KEY, symbol);
    } catch (e) {
      setError(
        e?.message ||
          `Couldn't pull enough data for ${symbol}. Yahoo and the proxy fallback both failed — try again, or add a Finnhub API key as backup from the Watchlist tab.`
      );
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

        .an-body { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 16px; }
        .an-summary { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 12px; padding: 20px; display: flex; flex-wrap: wrap; gap: 24px; align-items: center; }
        .an-sym { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 26px; }
        .an-price { font-family: 'IBM Plex Mono', monospace; font-size: 15px; color: #ADB1B9; margin-top: 2px; }
        .an-signal { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 22px; border-radius: 10px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 20px; letter-spacing: 0.05em; }
        .an-signal.bullish { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .an-signal.bearish { background: rgba(232,105,122,0.14); color: #E8697A; }
        .an-signal.neutral { background: rgba(201,154,75,0.14); color: #C99A4B; }
        .an-signal small { font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 500; letter-spacing: 0.02em; text-transform: none; }
        .an-range { display: flex; gap: 24px; }
        .an-range-item { display: flex; flex-direction: column; gap: 2px; }
        .an-range-item .lbl { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #888E99; text-transform: uppercase; letter-spacing: 0.06em; }
        .an-range-item .val { font-family: 'IBM Plex Mono', monospace; font-size: 17px; font-weight: 600; }
        .an-range-item.high .val { color: #5FCBA0; }
        .an-range-item.low .val { color: #E8697A; }

        .an-section-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 0.03em; margin: 4px 0 0; color: #EDEBE4; }
        .an-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
        .an-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 13px 14px; }
        .an-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
        .an-card-name { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; }
        .an-help-btn { background: transparent; border: none; color: #5A5F68; cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
        .an-help-btn:hover { color: #FFB454; }
        .an-card-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #ADB1B9; }
        .an-card-note { font-size: 11.5px; color: #888E99; margin-top: 6px; line-height: 1.4; }
        .an-tag-icon { display: inline-flex; }
        .an-tag-icon.bullish { color: #5FCBA0; }
        .an-tag-icon.bearish { color: #E8697A; }
        .an-tag-icon.neutral { color: #C99A4B; }

        .an-options-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 18px; }
        .an-options-card h3 { margin: 0 0 6px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-size: 15px; }
        .an-options-card p { margin: 0; font-size: 13px; color: #C7CAD1; line-height: 1.6; }
        .an-options-meta { display: flex; gap: 18px; margin-top: 12px; flex-wrap: wrap; }
        .an-options-meta div { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #888E99; }
        .an-options-meta b { color: #FFB454; }
        .an-disclaimer { font-size: 10.5px; color: #5A5F68; margin-top: 12px; line-height: 1.5; }

        .an-fib-list { display: flex; flex-direction: column; gap: 4px; }
        .an-fib-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; padding: 5px 10px; border-radius: 5px; background: #1C1F25; border: 1px solid #2A2E36; }
        .an-fib-row.ext { opacity: 0.7; }
        .an-fib-tag { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 10px; letter-spacing: 0.03em; padding: 2px 8px; border-radius: 4px; text-align: center; }
        .an-fib-tag.resistance { color: #E8697A; background: rgba(232,105,122,0.12); }
        .an-fib-tag.support { color: #5FCBA0; background: rgba(95,203,160,0.12); }
        .an-fib-tag.current { color: #FFB454; background: rgba(255,180,84,0.14); }
        .an-fib-pct { color: #888E99; }
        .an-fib-price { color: #EDEBE4; font-weight: 600; }

        .an-sources { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #5A5F68; margin-top: 4px; }
      `}</style>

      <div className="an-header">
        <h1>ANALYZER</h1>
        <p>Multi-indicator technical read: ATR · Pivots · VWAP · Volume Profile · RSI/MACD · EMAs · Bollinger · Fibonacci · IV · Rel. Volume</p>
      </div>

      <form className="an-search-row" onSubmit={handleAnalyze}>
        <div className="an-search-box">
          <Search size={15} color="#5A5F68" />
          <input
            placeholder="Enter a ticker, e.g. AAPL"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={10}
          />
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
          <Loader2 size={16} className="spin" /> pulling price history and running indicators…
        </div>
      )}

      {result && !loading && (
        <div className="an-body">
          <div className="an-summary">
            <div>
              <div className="an-sym">{result.symbol}</div>
              <div className="an-price">${fmt(result.price)}</div>
            </div>
            <div className={`an-signal ${result.signal.tag}`}>
              {result.signal.label}
              <small>composite score {fmt(result.score, 1)}</small>
            </div>
            <div className="an-range">
              <div className="an-range-item high">
                <span className="lbl">
                  <ArrowUp size={10} style={{ verticalAlign: "-1px" }} /> Target High
                </span>
                <span className="val">${fmt(result.dailyHigh)}</span>
              </div>
              <div className="an-range-item low">
                <span className="lbl">
                  <ArrowDown size={10} style={{ verticalAlign: "-1px" }} /> Target Low
                </span>
                <span className="val">${fmt(result.dailyLow)}</span>
              </div>
              <div className="an-range-item">
                <span className="lbl">ATR (14)</span>
                <span className="val">{fmt(result.atr)}</span>
              </div>
            </div>
          </div>
          <div className="an-sources">
            Daily data: {result.dataSource === "yahoo" ? "Yahoo" : "Finnhub"} · Intraday/VWAP: {result.intradaySource ? (result.intradaySource === "yahoo" ? "Yahoo" : "Finnhub") : "unavailable"} ·{" "}
            {result.ivIsProxy ? "IV: historical-vol proxy (options chain unavailable)" : "IV: live options chain"}
          </div>

          {result.weeklyRange && (
            <div>
              <div className="an-section-title">Weekly price range</div>
              <div className="an-summary" style={{ marginTop: 8, gap: 20 }}>
                <div className="an-range-item high">
                  <span className="lbl">
                    <ArrowUp size={10} style={{ verticalAlign: "-1px" }} /> Weekly High
                  </span>
                  <span className="val">${fmt(result.weeklyRange.weeklyHigh)}</span>
                </div>
                <div className="an-range-item low">
                  <span className="lbl">
                    <ArrowDown size={10} style={{ verticalAlign: "-1px" }} /> Weekly Low
                  </span>
                  <span className="val">${fmt(result.weeklyRange.weeklyLow)}</span>
                </div>
              </div>
              <div className="an-grid" style={{ marginTop: 10 }}>
                <div className="an-card">
                  <div className="an-card-name">1 · Options-implied move</div>
                  <div className="an-card-val">
                    {result.weeklyMoveFromIV !== null ? `±$${fmt(result.weeklyMoveFromIV)}` : "unavailable"}
                  </div>
                  <div className="an-card-note">
                    {result.ivIsProxy ? "From historical-vol proxy (no live options chain)" : "From nearest weekly options expiry, ATM strike"} — {fmt(result.iv, 1)}% {result.ivIsProxy ? "hist. vol" : "IV"}
                  </div>
                </div>
                <div className="an-card">
                  <div className="an-card-name">2 · ATR-based move</div>
                  <div className="an-card-val">±${fmt(result.weeklyMoveFromATR)}</div>
                  <div className="an-card-note">{result.weeklyRange.moveCompareNote}</div>
                </div>
                <div className="an-card">
                  <div className="an-card-name">3 · Weekly pivot levels</div>
                  <div className="an-card-val">PP ${fmt(result.weeklyRange.weeklyPivots.pp)}</div>
                  <div className="an-card-note">
                    R1 ${fmt(result.weeklyRange.weeklyPivots.r1)} / R2 ${fmt(result.weeklyRange.weeklyPivots.r2)} · S1 ${fmt(result.weeklyRange.weeklyPivots.s1)} / S2 ${fmt(result.weeklyRange.weeklyPivots.s2)}
                    <br />
                    from last completed week's H/L/C
                  </div>
                </div>
                <div className="an-card">
                  <div className="an-card-name">4 · Confirmation</div>
                  <div className="an-card-val">Volume Profile + 20/50 EMA</div>
                  <div className="an-card-note">{result.weeklyRange.confirmationNote}</div>
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="an-section-title">Indicator breakdown</div>
            <div className="an-grid" style={{ marginTop: 8 }}>
              {result.readings.map((r, i) => {
                const Icon = TAG_ICON[r.tag];
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
                      <span className={`an-tag-icon ${r.tag}`}>
                        <Icon size={14} />
                      </span>
                    </div>
                    <div className="an-card-val">{r.value}</div>
                    <div className="an-card-note">{r.note}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {result.volProfile && (
            <div>
              <div className="an-section-title">Volume Profile (last 30 sessions)</div>
              <div className="an-card" style={{ marginTop: 8 }}>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={result.volProfile.chartData} layout="vertical" margin={{ left: 0, right: 10, top: 4, bottom: 4 }}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="price"
                      tickFormatter={(v) => fmt(v, 0)}
                      width={52}
                      tick={{ fill: "#888E99", fontSize: 10, fontFamily: "IBM Plex Mono, monospace" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <ReferenceLine x={0} stroke="#2A2E36" />
                    <Bar dataKey="volume" radius={[0, 3, 3, 0]}>
                      {result.volProfile.chartData.map((d, i) => (
                        <Cell key={i} fill={d.isPoc ? "#FFB454" : "#3A3F49"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="an-card-note" style={{ marginTop: 4 }}>
                  POC (point of control) ${fmt(result.volProfile.poc)} · Value area ${fmt(result.volProfile.vaLow)} – ${fmt(result.volProfile.vaHigh)}
                </div>
              </div>
            </div>
          )}

          {result.fib && (
            <div>
              <div className="an-section-title">Fibonacci levels ({result.fib.uptrend ? "uptrend retracement" : "downtrend retracement"})</div>
              <div className="an-fib-list" style={{ marginTop: 8 }}>
                {[...result.fib.extensions].reverse().map((l, i) => {
                  const status = fibStatus(l.price, result.price);
                  return (
                    <div className="an-fib-row ext" key={`e${i}`}>
                      <span className="an-fib-pct">{(l.pct * 100).toFixed(1)}% ext</span>
                      <span className={`an-fib-tag ${status}`}>{FIB_STATUS_LABEL[status]}</span>
                      <span className="an-fib-price">${fmt(l.price)}</span>
                    </div>
                  );
                })}
                {[...result.fib.retracements].reverse().map((l, i) => {
                  const status = fibStatus(l.price, result.price);
                  return (
                    <div className="an-fib-row" key={`r${i}`}>
                      <span className="an-fib-pct">{(l.pct * 100).toFixed(1)}%</span>
                      <span className={`an-fib-tag ${status}`}>{FIB_STATUS_LABEL[status]}</span>
                      <span className="an-fib-price">${fmt(l.price)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="an-card-note" style={{ marginTop: 6 }}>
                Levels above the current price (${fmt(result.price)}) act as potential resistance; levels below act as potential support.
              </div>
            </div>
          )}

          <div>
            <div className="an-section-title">Weekly options idea</div>
            <div className="an-options-card" style={{ marginTop: 8 }}>
              <h3>{result.optionsIdea.structure}</h3>
              <p>{result.optionsIdea.detail}</p>
              <div className="an-options-meta">
                <div>
                  Weekly expected move: <b>±${fmt(result.weeklyMove)}</b>
                </div>
                <div>
                  {result.ivIsProxy ? "Historical vol" : "Implied vol"}: <b>{fmt(result.iv, 1)}%</b>
                </div>
              </div>
              <div className="an-disclaimer">
                Informational output from the indicators above, not financial advice. Options
                carry risk of loss up to the full width of the spread; expected move is a
                statistical estimate, not a guarantee. Verify strikes and pricing in your broker
                before placing any trade.
              </div>
            </div>
          </div>
        </div>
      )}
      <HelpModal entry={activeHelp} onClose={() => setActiveHelp(null)} />
    </div>
  );
}
