import React, { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import {
  Search,
  X,
  Plus,
  TrendingUp,
  TrendingDown,
  Wifi,
  WifiOff,
  Loader2,
  Radio,
  RefreshCw,
  Settings,
  Check,
  ExternalLink,
} from "lucide-react";

// ---- design tokens ----
// bg-void #14161A, panel #1C1F25, border #2A2E36
// amber (phosphor) #FFB454, teal (up) #5FCBA0, rose (down) #E8697A
// text hi #EDEBE4, text lo #888E99

const WATCHLIST_KEY = "stockdesk:watchlist";
const APIKEY_KEY = "stockdesk:finnhub_key";
const REFRESH_MS = 20000;
const FETCH_TIMEOUT_MS = 6000;

// fetch with a hard timeout so a blocked/hanging request never stalls the UI
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function seedRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1) >>> 0;
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateQuote(symbol) {
  const rng = seedRandom(symbol + new Date().toDateString());
  const base = 20 + rng() * 380;
  const history = [];
  let p = base * (0.97 + rng() * 0.02);
  for (let i = 0; i < 30; i++) {
    p = p * (1 + (rng() - 0.5) * 0.012);
    history.push({ t: i, close: p });
  }
  const jitter = 1 + (Math.random() - 0.5) * 0.004;
  const price = history[history.length - 1].close * jitter;
  const prevClose = history[0].close;
  const change = price - prevClose;
  return {
    symbol,
    name: symbol,
    price,
    prevClose,
    change,
    changePercent: (change / prevClose) * 100,
    history,
    live: false,
    source: "sim",
  };
}

async function fetchQuoteFinnhub(symbol, apiKey) {
  const qRes = await fetchWithTimeout(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`
  );
  if (!qRes.ok) throw new Error(`finnhub quote http ${qRes.status}`);
  const q = await qRes.json();
  if ((q.c === 0 || q.c === undefined) && (q.pc === 0 || q.pc === undefined)) {
    throw new Error("invalid symbol");
  }
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 8;
  let history = [];
  try {
    const cRes = await fetchWithTimeout(
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
        symbol
      )}&resolution=5&from=${from}&to=${now}&token=${apiKey}`
    );
    const c = await cRes.json();
    if (c.s === "ok" && Array.isArray(c.c) && c.c.length > 1) {
      history = c.c.map((close, i) => ({ t: i, close }));
    }
  } catch (e) {
    // candle endpoint failed or timed out; fall back to a 2-point line below
  }
  if (!history.length) {
    history = [
      { t: 0, close: q.pc },
      { t: 1, close: q.c },
    ];
  }
  const change = q.d ?? q.c - q.pc;
  const changePercent = q.dp ?? (q.pc ? (change / q.pc) * 100 : 0);
  return {
    symbol,
    name: symbol,
    price: q.c,
    prevClose: q.pc,
    change,
    changePercent,
    history,
    live: true,
    source: "finnhub",
  };
}

function parseYahooChart(data, symbol) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("no result");
  const meta = result.meta;
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (v) => v !== null && v !== undefined
  );
  if (!closes.length) throw new Error("no closes");
  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? closes[0];
  const change = price - prevClose;
  const history = closes.map((c, i) => ({ t: i, close: c }));
  return {
    symbol: meta.symbol || symbol,
    name: meta.shortName || meta.longName || symbol,
    price,
    prevClose,
    change,
    changePercent: prevClose ? (change / prevClose) * 100 : 0,
    history,
  };
}

// Direct browser call to Yahoo's public chart endpoint. Works when Yahoo grants CORS to the
// calling origin — this varies and isn't guaranteed, which is why there's a proxied fallback.
async function fetchQuoteYahooDirect(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=1d&interval=5m`;
  const res = await fetchWithTimeout(url, { mode: "cors" });
  if (!res.ok) throw new Error(`yahoo http ${res.status}`);
  const data = await res.json();
  return { ...parseYahooChart(data, symbol), live: true, source: "yahoo" };
}

// Same Yahoo data, routed through a public CORS-passthrough proxy for browsers Yahoo blocks
// directly. This is a second attempt, not the primary path, since public proxies can be flaky.
async function fetchQuoteYahooProxied(symbol) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=1d&interval=5m`;
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(target)}`;
  const res = await fetchWithTimeout(proxyUrl);
  if (!res.ok) throw new Error(`yahoo-proxy http ${res.status}`);
  const data = await res.json();
  return { ...parseYahooChart(data, symbol), live: true, source: "yahoo-proxy" };
}

async function fetchQuoteYahoo(symbol) {
  try {
    return await fetchQuoteYahooDirect(symbol);
  } catch (e) {
    return await fetchQuoteYahooProxied(symbol);
  }
}

// Always resolves — never throws, never hangs past ~3x FETCH_TIMEOUT_MS.
// Priority: Yahoo (direct, then proxied) -> Finnhub if a key is set -> simulated as last resort.
async function getQuote(symbol, apiKey) {
  try {
    return await fetchQuoteYahoo(symbol);
  } catch (e) {
    // fall through to Finnhub backup
  }
  if (apiKey) {
    try {
      return await fetchQuoteFinnhub(symbol, apiKey);
    } catch (e) {
      // fall through to simulated
    }
  }
  return simulateQuote(symbol);
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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

function Sparkline({ history, positive }) {
  const color = positive ? "#5FCBA0" : "#E8697A";
  const gradId = `grad-${positive ? "up" : "down"}-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <ResponsiveContainer width="100%" height={44}>
      <AreaChart data={history} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="close"
          stroke={color}
          strokeWidth={1.75}
          fill={`url(#${gradId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function TickerTape({ items }) {
  if (!items.length) return null;
  const doubled = [...items, ...items];
  return (
    <div className="tape-wrap">
      <div className="tape-track">
        {doubled.map((s, i) => {
          const positive = s.change >= 0;
          return (
            <span className="tape-item" key={i}>
              <span className="tape-sym">{s.symbol}</span>
              <span className={`tape-px ${positive ? "up" : "down"}`}>
                {fmt(s.price)} {positive ? "▲" : "▼"} {fmt(Math.abs(s.changePercent))}%
              </span>
            </span>
          );
        })}
      </div>
      <style>{`
        .tape-wrap { overflow: hidden; background: #0D0E11; border-bottom: 1px solid #2A2E36; }
        .tape-track { display: flex; width: max-content; animation: scroll-left 38s linear infinite; }
        .tape-wrap:hover .tape-track { animation-play-state: paused; }
        .tape-item { display: flex; align-items: center; gap: 8px; padding: 7px 22px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; white-space: nowrap; border-right: 1px solid #22252B; }
        .tape-sym { color: #FFB454; font-weight: 600; letter-spacing: 0.03em; }
        .tape-px.up { color: #5FCBA0; }
        .tape-px.down { color: #E8697A; }
        @keyframes scroll-left { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      `}</style>
    </div>
  );
}

const SOURCE_LABEL = {
  finnhub: "Finnhub (backup)",
  yahoo: "Yahoo",
  "yahoo-proxy": "Yahoo (proxied)",
  sim: "Simulated",
};

export default function StockDesk() {
  const [watchlist, setWatchlist] = useState([]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const errorTimer = useRef(null);
  const apiKeyRef = useRef("");
  const watchlistRef = useRef([]);

  useEffect(() => {
    watchlistRef.current = watchlist;
  }, [watchlist]);

  const persistWatchlist = useCallback((list) => {
    writeLocal(WATCHLIST_KEY, JSON.stringify(list.map((s) => s.symbol)));
  }, []);

  const refreshSymbols = useCallback(async (symbols) => {
    if (!symbols.length) {
      setWatchlist([]);
      return [];
    }
    const results = await Promise.all(symbols.map((s) => getQuote(s, apiKeyRef.current)));
    setWatchlist(results);
    return results;
  }, []);

  // initial load
  useEffect(() => {
    (async () => {
      let symbols = ["AAPL", "NVDA", "MSFT"];
      const stored = readLocal(WATCHLIST_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length) symbols = parsed;
        } catch (e) {
          // ignore corrupt storage
        }
      }
      const storedKey = readLocal(APIKEY_KEY);
      if (storedKey) {
        apiKeyRef.current = storedKey;
        setApiKey(storedKey);
        setKeyDraft(storedKey);
      }
      await refreshSymbols(symbols);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // periodic refresh
  useEffect(() => {
    if (!loaded) return;
    const id = setInterval(() => {
      refreshSymbols(watchlistRef.current.map((s) => s.symbol));
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [loaded, refreshSymbols]);

  const showError = (msg) => {
    setErrorMsg(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setErrorMsg(""), 4000);
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    const symbol = query.trim().toUpperCase();
    if (!symbol) return;
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
      showError(`"${symbol}" doesn't look like a valid ticker.`);
      return;
    }
    if (watchlistRef.current.some((s) => s.symbol === symbol)) {
      showError(`${symbol} is already on your desk.`);
      setQuery("");
      return;
    }
    setAdding(true);
    setErrorMsg("");
    try {
      const quote = await getQuote(symbol, apiKeyRef.current);
      setWatchlist((current) => {
        const next = [...current, quote];
        persistWatchlist(next);
        return next;
      });
      if (!quote.live) {
        showError(`${symbol} added — live feed didn't respond, showing simulated data.`);
      }
      setQuery("");
    } catch (e) {
      showError(`Couldn't add ${symbol}. Try again.`);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = (symbol) => {
    setWatchlist((current) => {
      const next = current.filter((s) => s.symbol !== symbol);
      persistWatchlist(next);
      return next;
    });
  };

  const handleRetry = async () => {
    setRetrying(true);
    await refreshSymbols(watchlistRef.current.map((s) => s.symbol));
    setRetrying(false);
  };

  const handleSaveKey = async () => {
    const trimmed = keyDraft.trim();
    apiKeyRef.current = trimmed;
    setApiKey(trimmed);
    writeLocal(APIKEY_KEY, trimmed);
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
    setRetrying(true);
    await refreshSymbols(watchlistRef.current.map((s) => s.symbol));
    setRetrying(false);
  };

  const liveSources = new Set(watchlist.filter((s) => s.live).map((s) => s.source));
  const overallSource = liveSources.has("yahoo")
    ? "yahoo"
    : liveSources.has("yahoo-proxy")
    ? "yahoo-proxy"
    : liveSources.has("finnhub")
    ? "finnhub"
    : null;

  return (
    <div className="desk">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=Inter:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .desk { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; }
        .header { padding: 22px 24px 16px; display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 14px; border-bottom: 1px solid #22252B; }
        .brand { display: flex; align-items: baseline; gap: 10px; }
        .brand h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; letter-spacing: 0.02em; margin: 0; color: #EDEBE4; }
        .brand .dot { color: #FFB454; }
        .count { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #888E99; }

        .status-cluster { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .status { display: flex; align-items: center; gap: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #888E99; text-transform: uppercase; letter-spacing: 0.06em; }
        .status.live { color: #5FCBA0; }
        .status.sim { color: #C99A4B; }
        .icon-btn { display: flex; align-items: center; gap: 5px; background: #1C1F25; border: 1px solid #2A2E36; color: #ADB1B9; border-radius: 6px; padding: 6px 10px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.04em; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
        .icon-btn:hover { border-color: #FFB454; color: #FFB454; }
        .icon-btn:disabled { opacity: 0.5; cursor: default; }

        .nudge-banner { margin: 0 24px 14px; display: flex; align-items: center; gap: 10px; background: rgba(201,154,75,0.1); border: 1px solid rgba(201,154,75,0.35); color: #E0B872; border-radius: 8px; padding: 10px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; flex-wrap: wrap; }
        .nudge-banner span { flex: 1; min-width: 200px; }
        .nudge-btn { background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 6px 12px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .settings-panel { margin: 0 24px 18px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 16px; }
        .settings-panel h3 { margin: 0 0 4px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-size: 14px; font-weight: 600; color: #EDEBE4; }
        .settings-panel p { margin: 0 0 12px; font-size: 12px; color: #888E99; line-height: 1.5; }
        .settings-panel a { color: #FFB454; text-decoration: none; display: inline-flex; align-items: center; gap: 3px; }
        .key-row { display: flex; gap: 8px; }
        .key-row input { flex: 1; background: #14161A; border: 1px solid #2A2E36; border-radius: 6px; padding: 9px 10px; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 12px; outline: none; }
        .key-row input:focus { border-color: #FFB454; }
        .save-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 0 14px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer; }
        .save-btn.saved { background: #5FCBA0; }
        .key-status { margin-top: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #5FCBA0; }

        .search-row { padding: 18px 24px 6px; display: flex; gap: 10px; }
        .search-box { flex: 1; max-width: 420px; display: flex; align-items: center; gap: 8px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 6px; padding: 0 12px; transition: border-color 0.15s; }
        .search-box:focus-within { border-color: #FFB454; }
        .search-box input { background: transparent; border: none; outline: none; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 10px 4px; width: 100%; letter-spacing: 0.03em; }
        .search-box input::placeholder { color: #5A5F68; }
        .add-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 0 16px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 0.03em; cursor: pointer; transition: background 0.15s, transform 0.1s; }
        .add-btn:hover { background: #FFC57A; }
        .add-btn:active { transform: scale(0.97); }
        .add-btn:disabled { opacity: 0.6; cursor: default; }
        .error-msg { padding: 0 24px; color: #E8697A; font-family: 'IBM Plex Mono', monospace; font-size: 12px; min-height: 20px; margin-top: 6px; }

        .grid { padding: 16px 24px 40px; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
        .card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 16px; position: relative; transition: border-color 0.15s; }
        .card:hover { border-color: #3A3F49; }
        .card:hover .remove-btn { opacity: 1; }
        .card-top { display: flex; justify-content: space-between; align-items: flex-start; }
        .sym { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 17px; letter-spacing: 0.02em; }
        .name { font-size: 11px; color: #888E99; margin-top: 2px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .remove-btn { opacity: 0; background: transparent; border: none; color: #5A5F68; cursor: pointer; padding: 2px; transition: opacity 0.15s, color 0.15s; }
        .remove-btn:hover { color: #E8697A; }
        .price-row { display: flex; align-items: baseline; gap: 10px; margin-top: 10px; }
        .price { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 24px; }
        .chg { display: flex; align-items: center; gap: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; }
        .chg.up { color: #5FCBA0; } .chg.down { color: #E8697A; }
        .spark { margin-top: 6px; }
        .card-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
        .tag { font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 3px; }
        .tag.live { color: #5FCBA0; background: rgba(95,203,160,0.12); }
        .tag.sim { color: #C99A4B; background: rgba(201,154,75,0.12); }
        .empty { padding: 60px 24px; text-align: center; color: #5A5F68; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .loading-row { display:flex; align-items:center; gap:8px; padding: 60px 24px; justify-content:center; color:#888E99; font-family:'IBM Plex Mono', monospace; font-size:13px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <TickerTape items={watchlist} />

      <div className="header">
        <div className="brand">
          <h1>STOCK DESK</h1>
          <span className="dot">●</span>
          <span className="count">{watchlist.length} tracked</span>
        </div>
        <div className="status-cluster">
          <div className={`status ${overallSource ? "live" : loaded ? "sim" : ""}`}>
            {!loaded ? (
              <>
                <Loader2 size={13} className="spin" /> checking feed
              </>
            ) : overallSource ? (
              <>
                <Wifi size={13} /> live — {SOURCE_LABEL[overallSource]}
              </>
            ) : (
              <>
                <WifiOff size={13} /> unreachable — simulated
              </>
            )}
          </div>
          <button className="icon-btn" onClick={handleRetry} disabled={retrying || !loaded}>
            <RefreshCw size={12} className={retrying ? "spin" : ""} />
            {retrying ? "retrying" : "retry live"}
          </button>
          <button className="icon-btn" onClick={() => setShowSettings((v) => !v)}>
            <Settings size={12} />
            {apiKey ? "key set" : "connect data"}
          </button>
        </div>
      </div>

      {loaded && !overallSource && !apiKey && (
        <div className="nudge-banner">
          <WifiOff size={14} />
          <span>
            Yahoo's feed (direct and proxied) didn't respond. Add a free Finnhub key as backup, or
            tap retry — Yahoo access can be intermittent.
          </span>
          <button className="nudge-btn" onClick={() => setShowSettings(true)}>
            Add backup key
          </button>
        </div>
      )}

      {showSettings && (
        <div className="settings-panel">
          <h3>Finnhub API key (backup source)</h3>
          <p>
            This dashboard tries Yahoo's public chart feed first — direct, then through a CORS
            proxy if Yahoo blocks the direct request. If both fail, it falls back to Finnhub, then
            simulated data as a last resort. A free Finnhub key makes that backup actually work.{" "}
            <a href="https://finnhub.io/register" target="_blank" rel="noreferrer">
              Get a free key <ExternalLink size={11} />
            </a>{" "}
            (takes about a minute, no credit card). Stored only in your browser's local storage on
            this device — never sent anywhere but Finnhub.
          </p>
          <div className="key-row">
            <input
              type="password"
              placeholder="Paste your Finnhub API key"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <button className={`save-btn ${keySaved ? "saved" : ""}`} onClick={handleSaveKey}>
              {keySaved ? <Check size={13} /> : null}
              {keySaved ? "Saved" : "Save & connect"}
            </button>
          </div>
          {apiKey && <div className="key-status">Key active — used automatically if Yahoo doesn't respond.</div>}
        </div>
      )}

      <form className="search-row" onSubmit={handleAdd}>
        <div className="search-box">
          <Search size={15} color="#5A5F68" />
          <input
            placeholder="Add ticker, e.g. TSLA"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={10}
          />
        </div>
        <button className="add-btn" type="submit" disabled={adding}>
          {adding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
          {adding ? "Adding" : "Add"}
        </button>
      </form>
      <div className="error-msg">{errorMsg}</div>

      {!loaded ? (
        <div className="loading-row">
          <Loader2 size={16} className="spin" /> loading desk…
        </div>
      ) : watchlist.length === 0 ? (
        <div className="empty">
          <Radio size={18} style={{ marginBottom: 8 }} />
          <div>No tickers yet. Add one above to start tracking.</div>
        </div>
      ) : (
        <div className="grid">
          {watchlist.map((s) => {
            const positive = s.change >= 0;
            return (
              <div className="card" key={s.symbol}>
                <div className="card-top">
                  <div>
                    <div className="sym">{s.symbol}</div>
                    <div className="name">{s.name}</div>
                  </div>
                  <button className="remove-btn" onClick={() => handleRemove(s.symbol)} aria-label={`Remove ${s.symbol}`}>
                    <X size={15} />
                  </button>
                </div>
                <div className="price-row">
                  <span className="price">${fmt(s.price)}</span>
                  <span className={`chg ${positive ? "up" : "down"}`}>
                    {positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                    {fmt(Math.abs(s.change))} ({fmt(Math.abs(s.changePercent))}%)
                  </span>
                </div>
                <div className="spark">
                  <Sparkline history={s.history} positive={positive} />
                </div>
                <div className="card-foot">
                  <span className={`tag ${s.live ? "live" : "sim"}`}>{s.live ? "LIVE" : "SIM"}</span>
                  <span className="name" style={{ maxWidth: "none" }}>{SOURCE_LABEL[s.source]}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
