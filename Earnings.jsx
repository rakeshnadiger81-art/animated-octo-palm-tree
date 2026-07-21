import React, { useState, useEffect, useCallback, useRef } from "react";
import { Search, Loader2, AlertTriangle, CalendarClock, Sun, Moon, Clock3, Info } from "lucide-react";

const FETCH_TIMEOUT_MS = 12000;
const APIKEY_KEY = "stockdesk:finnhub_key";
const LAST_SYMBOL_KEY = "stockdesk:lastSymbol:earnings";

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

// Curated large-cap universe, reused from the same spirit as the Heatmap tab, used to filter the
// broad market-wide earnings calendar down to companies most people would recognize — the raw
// Finnhub calendar for a 30-day window includes thousands of small/micro-cap tickers otherwise.
const KNOWN_TICKERS = new Set([
  "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA", "AVGO", "TSM", "ORCL", "ADBE", "CRM", "NOW", "INTU", "IBM", "ACN", "CSCO", "SHOP",
  "PLTR", "AMD", "SNOW", "CRWD", "QCOM", "TXN", "INTC", "AMAT", "MU", "LRCX",
  "JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "SPGI", "V", "MA", "PYPL",
  "LLY", "UNH", "JNJ", "ABBV", "MRK", "TMO", "ABT", "PFE", "DHR", "BMY", "AMGN", "ISRG", "CVS",
  "HD", "MCD", "NKE", "LOW", "SBUX", "BKNG", "TJX", "CMG", "MAR", "ABNB", "DIS",
  "WMT", "PG", "KO", "PEP", "COST", "PM", "MDLZ", "CL", "KMB", "GIS", "TGT",
  "GE", "CAT", "RTX", "HON", "UNP", "BA", "DE", "LMT", "UPS", "ETN", "FDX",
  "XOM", "CVX", "COP", "SLB", "EOG", "PSX", "MPC", "OXY", "WMB", "KMI",
  "NEE", "SO", "DUK", "AEP", "SRE", "D", "EXC", "XEL",
  "NFLX", "TMUS", "VZ", "T", "CMCSA", "CHTR", "EA", "WBD", "SPOT", "UBER", "LYFT", "SNAP", "PINS",
  "PLD", "AMT", "EQIX", "SPG", "PSA", "O", "WELL", "DLR", "CCI", "VICI",
  "LIN", "SHW", "APD", "ECL", "FCX", "NEM", "DOW", "DD", "NUE",
  "PANW", "NET", "DDOG", "MDB", "ZS", "OKTA", "TEAM", "WDAY", "ADSK", "ANET", "MRVL",
  "SOFI", "COIN", "HOOD", "SQ", "AFRM", "RBLX", "DKNG", "RIVN", "LCID", "F", "GM",
  "DAL", "UAL", "AAL", "LUV", "CCL", "RCL", "NCLH", "MGM", "WYNN", "LVS",
]);

async function fetchEarningsCalendarRange(from, to, apiKey, symbol) {
  const symbolPart = symbol ? `&symbol=${encodeURIComponent(symbol)}` : "";
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}${symbolPart}&token=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (res.status === 401 || res.status === 403) {
    const err = new Error("finnhub auth");
    err.finnhubAuth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`http ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
}

async function fetchHistoricalEarnings(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`http ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function fmtDateStr(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function daysFromToday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / (24 * 60 * 60 * 1000));
}
const HOUR_LABEL = {
  bmo: { label: "Before Market Open", Icon: Sun },
  amc: { label: "After Market Close", Icon: Moon },
  dmh: { label: "During Market Hours", Icon: Clock3 },
};

export default function Earnings() {
  const [calendar, setCalendar] = useState([]);
  const [loadingCalendar, setLoadingCalendar] = useState(true);
  const [calendarError, setCalendarError] = useState("");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const apiKeyRef = useRef("");

  const loadCalendar = useCallback(async () => {
    setLoadingCalendar(true);
    setCalendarError("");
    apiKeyRef.current = readLocal(APIKEY_KEY) || "";
    if (!apiKeyRef.current) {
      setCalendarError("The Earnings tab needs a Finnhub API key — add a free one from the Watchlist tab's \"connect data\" button, then reload this tab.");
      setLoadingCalendar(false);
      return;
    }
    try {
      const from = new Date();
      const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const items = await fetchEarningsCalendarRange(fmt(from), fmt(to), apiKeyRef.current);
      const filtered = items
        .filter((e) => KNOWN_TICKERS.has(e.symbol))
        .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
      const seen = new Set();
      const deduped = filtered.filter((e) => {
        const key = `${e.symbol}-${e.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setCalendar(deduped);
    } catch (e) {
      if (e.finnhubAuth) {
        setCalendarError("Finnhub rejected this request (401/403) — the earnings calendar endpoint may not be included in your plan.");
      } else {
        setCalendarError("Couldn't load the earnings calendar right now. Try again in a moment.");
      }
    } finally {
      setLoadingCalendar(false);
    }
  }, []);

  useEffect(() => {
    loadCalendar();
    const saved = readLocal(LAST_SYMBOL_KEY);
    if (saved) setQuery(saved);
  }, [loadCalendar]);

  const handleSearch = async (e) => {
    e.preventDefault();
    const symbol = query.trim().toUpperCase();
    if (!symbol) return;
    apiKeyRef.current = readLocal(APIKEY_KEY) || "";
    if (!apiKeyRef.current) {
      setSearchError("This needs a Finnhub API key — add one from the Watchlist tab's \"connect data\" button.");
      return;
    }
    setSearchLoading(true);
    setSearchError("");
    setSearchResult(null);
    try {
      const from = new Date();
      const to = new Date(Date.now() + 210 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const confirmed = await fetchEarningsCalendarRange(fmt(from), fmt(to), apiKeyRef.current, symbol);
      const upcoming = confirmed
        .filter((e) => e.date >= fmt(from))
        .sort((a, b) => (a.date > b.date ? 1 : -1));

      if (upcoming.length) {
        setSearchResult({
          symbol,
          confirmed: true,
          date: upcoming[0].date,
          hour: upcoming[0].hour,
          epsEstimate: upcoming[0].epsEstimate,
          revenueEstimate: upcoming[0].revenueEstimate,
        });
        writeLocal(LAST_SYMBOL_KEY, symbol);
      } else {
        const hist = await fetchHistoricalEarnings(symbol, apiKeyRef.current);
        const validDates = hist
          .map((h) => h.period)
          .filter(Boolean)
          .sort((a, b) => (a > b ? -1 : 1));
        if (validDates.length >= 2) {
          const last = new Date(validDates[0] + "T00:00:00");
          const prior = new Date(validDates[1] + "T00:00:00");
          const intervalDays = Math.round((last - prior) / (24 * 60 * 60 * 1000));
          const estimated = new Date(last.getTime() + intervalDays * 24 * 60 * 60 * 1000);
          setSearchResult({
            symbol,
            confirmed: false,
            date: estimated.toISOString().slice(0, 10),
            lastReported: validDates[0],
            intervalDays,
          });
          writeLocal(LAST_SYMBOL_KEY, symbol);
        } else if (validDates.length === 1) {
          const last = new Date(validDates[0] + "T00:00:00");
          const estimated = new Date(last.getTime() + 91 * 24 * 60 * 60 * 1000);
          setSearchResult({
            symbol,
            confirmed: false,
            date: estimated.toISOString().slice(0, 10),
            lastReported: validDates[0],
            intervalDays: 91,
            assumedQuarterly: true,
          });
          writeLocal(LAST_SYMBOL_KEY, symbol);
        } else {
          setSearchError(`No confirmed date and no earnings history found for ${symbol} — check the ticker, or this may be a newly-listed company.`);
        }
      }
    } catch (e) {
      setSearchError(e?.finnhubAuth ? "Finnhub rejected this request (401/403) — check your plan." : `Couldn't look up ${symbol}. Try again in a moment.`);
    } finally {
      setSearchLoading(false);
    }
  };

  const grouped = {};
  for (const e of calendar) {
    if (!grouped[e.date]) grouped[e.date] = [];
    grouped[e.date].push(e);
  }
  const dates = Object.keys(grouped).sort();

  return (
    <div className="er-root">
      <style>{`
        .er-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 50px; }
        .er-header { padding: 22px 24px 6px; }
        .er-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .er-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .er-search-row { padding: 16px 24px 6px; display: flex; gap: 10px; }
        .er-search-box { flex: 1; max-width: 380px; display: flex; align-items: center; gap: 8px; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 6px; padding: 0 12px; }
        .er-search-box:focus-within { border-color: #FFB454; }
        .er-search-box input { background: transparent; border: none; outline: none; color: #EDEBE4; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 10px 4px; width: 100%; }
        .er-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 0 18px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; cursor: pointer; }
        .er-btn:disabled { opacity: 0.6; }
        .er-error { margin: 10px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .er-loading { display: flex; align-items: center; gap: 8px; padding: 30px 24px; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .er-search-result { margin: 12px 24px 0; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 16px; }
        .er-search-result.confirmed { border-color: rgba(95,203,160,0.4); }
        .er-search-result.estimated { border-color: rgba(255,180,84,0.4); }
        .er-sr-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
        .er-sr-sym { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 17px; }
        .er-sr-badge { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 10.5px; padding: 3px 10px; border-radius: 5px; letter-spacing: 0.03em; }
        .er-sr-badge.confirmed { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .er-sr-badge.estimated { background: rgba(255,180,84,0.14); color: #FFB454; }
        .er-sr-date { font-family: 'IBM Plex Mono', monospace; font-size: 20px; font-weight: 700; margin-top: 8px; }
        .er-sr-meta { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: #888E99; margin-top: 6px; line-height: 1.6; }

        .er-section-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.02em; margin: 20px 24px 10px; color: #FFB454; }
        .er-calendar { padding: 0 24px; display: flex; flex-direction: column; gap: 12px; }
        .er-day-block { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 14px 16px; }
        .er-day-top { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; }
        .er-day-badge { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #5A5F68; font-weight: 400; }
        .er-tickers-row { display: flex; flex-wrap: wrap; gap: 8px; }
        .er-ticker-chip { display: flex; align-items: center; gap: 5px; background: #14161A; border: 1px solid #2A2E36; border-radius: 6px; padding: 5px 10px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; }
        .er-ticker-sym { font-weight: 700; color: #EDEBE4; }
        .er-hour-icon.bmo { color: #FFB454; } .er-hour-icon.amc { color: #8FA6E8; } .er-hour-icon.dmh { color: #888E99; }
        .er-empty { padding: 40px 24px; text-align: center; color: #5A5F68; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .er-disclaimer { margin: 20px 24px 0; font-size: 10.5px; color: #5A5F68; line-height: 1.6; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 14px; display: flex; gap: 8px; }
      `}</style>

      <div className="er-header">
        <h1>EARNINGS</h1>
        <p>Upcoming earnings dates for major companies over the next 30 days, plus per-ticker lookup</p>
      </div>

      <form className="er-search-row" onSubmit={handleSearch}>
        <div className="er-search-box">
          <Search size={14} color="#5A5F68" />
          <input placeholder="Look up a ticker, e.g. AAPL" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={10} />
        </div>
        <button className="er-btn" type="submit" disabled={searchLoading}>
          {searchLoading ? <Loader2 size={14} className="spin" /> : <CalendarClock size={14} />}
          {searchLoading ? "Looking up" : "Find Date"}
        </button>
      </form>

      {searchError && (
        <div className="er-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{searchError}</span>
        </div>
      )}

      {searchResult && (
        <div className={`er-search-result ${searchResult.confirmed ? "confirmed" : "estimated"}`}>
          <div className="er-sr-top">
            <span className="er-sr-sym">{searchResult.symbol}</span>
            <span className={`er-sr-badge ${searchResult.confirmed ? "confirmed" : "estimated"}`}>
              {searchResult.confirmed ? "Officially Confirmed" : "Estimated — Not Yet Announced"}
            </span>
          </div>
          <div className="er-sr-date">
            {fmtDateStr(searchResult.date)}
            <span style={{ fontSize: 12, color: "#888E99", fontWeight: 400, marginLeft: 8 }}>
              ({(() => { const d = daysFromToday(searchResult.date); return d === 0 ? "today" : d > 0 ? `in ${d} day${d === 1 ? "" : "s"}` : `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago`; })()})
            </span>
          </div>
          <div className="er-sr-meta">
            {searchResult.confirmed ? (
              <>
                {searchResult.hour && HOUR_LABEL[searchResult.hour] && <>Timing: {HOUR_LABEL[searchResult.hour].label}<br /></>}
                {searchResult.epsEstimate !== null && searchResult.epsEstimate !== undefined && <>EPS estimate: ${searchResult.epsEstimate}<br /></>}
                {searchResult.revenueEstimate ? <>Revenue estimate: ${(searchResult.revenueEstimate / 1e9).toFixed(2)}B</> : null}
              </>
            ) : (
              <>
                No official date announced yet. Estimated by adding {searchResult.intervalDays} days (the
                {searchResult.assumedQuarterly ? " standard quarterly assumption, since only one prior report was found" : " gap between this company's last two reports"}) to its last reported
                earnings date, {fmtDateStr(searchResult.lastReported)}. Companies sometimes shift by a few days
                from their historical pattern, so treat this as a rough estimate, not a confirmed date.
              </>
            )}
          </div>
        </div>
      )}

      <div className="er-section-title">Next 30 Days — Major Companies</div>

      {calendarError && (
        <div className="er-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{calendarError}</span>
        </div>
      )}
      {loadingCalendar && (
        <div className="er-loading">
          <Loader2 size={16} className="spin" /> loading the earnings calendar…
        </div>
      )}
      {!loadingCalendar && !calendarError && dates.length === 0 && (
        <div className="er-empty">No major-company earnings found in the next 30 days from Finnhub's calendar.</div>
      )}
      {!loadingCalendar && dates.length > 0 && (
        <div className="er-calendar">
          {dates.map((date) => (
            <div className="er-day-block" key={date}>
              <div className="er-day-top">
                {fmtDateStr(date)}
                <span className="er-day-badge">
                  {(() => { const d = daysFromToday(date); return d === 0 ? "today" : `in ${d} day${d === 1 ? "" : "s"}`; })()}
                </span>
              </div>
              <div className="er-tickers-row">
                {grouped[date].map((e, i) => {
                  const hourInfo = HOUR_LABEL[e.hour];
                  const HourIcon = hourInfo?.Icon;
                  return (
                    <span className="er-ticker-chip" key={i} title={hourInfo ? hourInfo.label : "Timing not specified"}>
                      <span className="er-ticker-sym">{e.symbol}</span>
                      {HourIcon && <HourIcon size={11} className={`er-hour-icon ${e.hour}`} />}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="er-disclaimer">
        <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          The 30-day calendar is filtered to a curated list of well-known large-cap tickers, not
          every company reporting — Finnhub's raw calendar includes thousands of small/micro-cap
          names each month. Dates come directly from Finnhub and can shift; companies sometimes
          move their earnings date with little notice. Estimated dates (per-ticker search, when
          no official date is announced) are a simple historical-cadence projection, not a
          confirmed schedule.
        </span>
      </div>
    </div>
  );
}
