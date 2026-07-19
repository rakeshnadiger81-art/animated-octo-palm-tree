import React, { useState, useEffect, useCallback, useRef } from "react";
import { Search, Loader2, ExternalLink, AlertTriangle, Newspaper } from "lucide-react";

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
const LAST_SYMBOL_KEY = "stockdesk:lastSymbol:news";

const CNBC_FEEDS = {
  top: { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", label: "Top News" },
  markets: { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", label: "Markets & Finance" },
};

function stripHtml(str) {
  if (!str) return "";
  return str.replace(/<[^>]*>/g, "").trim();
}

function parseRss(xmlText, sourceLabel) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("bad xml");
  const items = Array.from(doc.querySelectorAll("item"));
  return items.map((item) => {
    const title = item.querySelector("title")?.textContent || "Untitled";
    const link = item.querySelector("link")?.textContent || "#";
    const pubDate = item.querySelector("pubDate")?.textContent || null;
    const description = stripHtml(item.querySelector("description")?.textContent || "");
    return {
      title: stripHtml(title),
      link,
      pubDate: pubDate ? new Date(pubDate) : null,
      description,
      source: sourceLabel,
    };
  });
}

async function fetchRss(url, sourceLabel) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    return parseRss(await res.text(), sourceLabel);
  } catch (e) {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error(`proxy http ${res.status}`);
    return parseRss(await res.text(), sourceLabel);
  }
}

async function fetchFinnhubCompanyNews(symbol, apiKey) {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmtDate = (d) => d.toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
    symbol
  )}&from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`finnhub http ${res.status}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error("bad finnhub response");
  return items.map((a) => ({
    title: a.headline,
    link: a.url,
    pubDate: a.datetime ? new Date(a.datetime * 1000) : null,
    description: a.summary || "",
    source: a.source || "Finnhub",
  }));
}

function timeAgo(date) {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export default function News() {
  const [category, setCategory] = useState("top");
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tickerQuery, setTickerQuery] = useState("");
  const [tickerMode, setTickerMode] = useState(false);
  const [tickerLoading, setTickerLoading] = useState(false);
  const apiKeyRef = useRef(readLocal(APIKEY_KEY) || "");

  const loadCategory = useCallback(async (cat) => {
    setLoading(true);
    setError("");
    setTickerMode(false);
    try {
      const feed = CNBC_FEEDS[cat];
      const items = await fetchRss(feed.url, "CNBC");
      items.sort((a, b) => (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0));
      setArticles(items);
    } catch (e) {
      setError("Couldn't reach CNBC's feed right now (direct request and proxy fallback both failed). Try again in a moment.");
      setArticles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategory(category);
  }, [category, loadCategory]);

  useEffect(() => {
    const saved = readLocal(LAST_SYMBOL_KEY);
    if (saved) setTickerQuery(saved);
  }, []);

  const handleTickerSearch = async (e) => {
    e.preventDefault();
    const symbol = tickerQuery.trim().toUpperCase();
    if (!symbol) return;
    apiKeyRef.current = readLocal(APIKEY_KEY) || "";
    if (!apiKeyRef.current) {
      setError("Company-specific news needs a Finnhub API key — add one from the Watchlist tab's \"connect data\" button.");
      return;
    }
    setTickerLoading(true);
    setError("");
    try {
      const items = await fetchFinnhubCompanyNews(symbol, apiKeyRef.current);
      items.sort((a, b) => (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0));
      setArticles(items);
      setTickerMode(true);
      writeLocal(LAST_SYMBOL_KEY, symbol);
    } catch (e) {
      setError(`Couldn't pull news for ${symbol}. Check the ticker and your Finnhub key.`);
    } finally {
      setTickerLoading(false);
    }
  };

  return (
    <div className="news-root">
      <style>{`
        .news-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 40px; }
        .news-header { padding: 22px 24px 6px; }
        .news-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .news-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .news-pills { display: flex; gap: 8px; padding: 16px 24px 0; flex-wrap: wrap; }
        .news-pill { background: #1C1F25; border: 1px solid #2A2E36; color: #ADB1B9; border-radius: 20px; padding: 7px 16px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 12.5px; cursor: pointer; }
        .news-pill.active { background: #FFB454; color: #14161A; border-color: #FFB454; }
        .news-search-row { padding: 14px 24px 4px; display: flex; gap: 10px; }
        .news-search-box { flex: 1; max-width: 360px; display: flex; align-items: center; gap: 8px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 6px; padding: 0 12px; }
        .news-search-box:focus-within { border-color: #FFB454; }
        .news-search-box input { background: transparent; border: none; outline: none; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 9px 4px; width: 100%; }
        .news-search-btn { display: flex; align-items: center; gap: 6px; background: #2A2E36; color: #ADB1B9; border: none; border-radius: 6px; padding: 0 14px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 12.5px; cursor: pointer; }
        .news-search-btn:disabled { opacity: 0.5; }
        .news-error { margin: 12px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .news-loading { display: flex; align-items: center; gap: 8px; padding: 60px 24px; justify-content: center; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .news-list { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 10px; }
        .news-card { display: block; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 15px 16px; text-decoration: none; color: inherit; transition: border-color 0.15s; }
        .news-card:hover { border-color: #FFB454; }
        .news-card-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
        .news-source { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #FFB454; text-transform: uppercase; letter-spacing: 0.05em; }
        .news-time { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #5A5F68; white-space: nowrap; }
        .news-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 14.5px; line-height: 1.35; display: flex; align-items: flex-start; gap: 6px; justify-content: space-between; }
        .news-desc { font-size: 12.5px; color: #888E99; margin-top: 6px; line-height: 1.5; }
        .news-empty { padding: 60px 24px; text-align: center; color: #5A5F68; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
      `}</style>

      <div className="news-header">
        <h1>NEWS</h1>
        <p>Live headlines from CNBC — top stories and markets, plus company news lookup</p>
      </div>

      <div className="news-pills">
        <button className={`news-pill ${!tickerMode && category === "top" ? "active" : ""}`} onClick={() => setCategory("top")}>
          Top News
        </button>
        <button className={`news-pill ${!tickerMode && category === "markets" ? "active" : ""}`} onClick={() => setCategory("markets")}>
          Markets & Finance
        </button>
      </div>

      <form className="news-search-row" onSubmit={handleTickerSearch}>
        <div className="news-search-box">
          <Search size={14} color="#5A5F68" />
          <input
            placeholder="Company news by ticker, e.g. TSLA"
            value={tickerQuery}
            onChange={(e) => setTickerQuery(e.target.value)}
            maxLength={10}
          />
        </div>
        <button className="news-search-btn" type="submit" disabled={tickerLoading}>
          {tickerLoading ? <Loader2 size={13} className="spin" /> : <Newspaper size={13} />}
          {tickerLoading ? "Loading" : "Search"}
        </button>
      </form>

      {error && (
        <div className="news-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {(loading || tickerLoading) && (
        <div className="news-loading">
          <Loader2 size={16} className="spin" /> pulling headlines…
        </div>
      )}

      {!loading && !tickerLoading && articles.length === 0 && !error && (
        <div className="news-empty">No articles found.</div>
      )}

      {!loading && !tickerLoading && articles.length > 0 && (
        <div className="news-list">
          {tickerMode && (
            <div className="news-source" style={{ marginBottom: -2 }}>
              Company news — {tickerQuery.toUpperCase()}
            </div>
          )}
          {articles.slice(0, 30).map((a, i) => (
            <a className="news-card" href={a.link} target="_blank" rel="noreferrer" key={i}>
              <div className="news-card-top">
                <span className="news-source">{a.source}</span>
                <span className="news-time">{timeAgo(a.pubDate)}</span>
              </div>
              <div className="news-title">
                <span>{a.title}</span>
                <ExternalLink size={12} style={{ flexShrink: 0, marginTop: 3, color: "#5A5F68" }} />
              </div>
              {a.description && <div className="news-desc">{a.description.slice(0, 180)}{a.description.length > 180 ? "…" : ""}</div>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
