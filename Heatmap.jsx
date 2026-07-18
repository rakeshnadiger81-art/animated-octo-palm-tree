import React, { useState } from "react";
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Info,
  Flame,
  Activity,
} from "lucide-react";

const FETCH_TIMEOUT_MS = 35000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "N/A";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtVol(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return fmt(n, 0);
}

// 7-bucket color scheme exactly as specified
function bucketColor(pct) {
  if (pct === null || pct === undefined) return "#3A3F49";
  if (pct > 5) return "#1B7A4A";
  if (pct >= 2) return "#2FA968";
  if (pct >= 0) return "#5FCBA0";
  if (pct >= -2) return "#EE97A2";
  if (pct >= -5) return "#D9556A";
  return "#8E1F35";
}
function bucketLabel(pct) {
  if (pct === null || pct === undefined) return "Flat/No data";
  if (pct > 5) return "> +5%";
  if (pct >= 2) return "+2% to +5%";
  if (pct >= 0) return "0% to +2%";
  if (pct >= -2) return "0% to -2%";
  if (pct >= -5) return "-2% to -5%";
  return "< -5%";
}
const TIER_SIZE = { 3: 128, 2: 100, 1: 78 };

function Tile({ s }) {
  const bg = bucketColor(s.changePercent);
  const size = TIER_SIZE[s.tier] || 78;
  const textColor = s.changePercent !== null && Math.abs(s.changePercent) < 3.5 && s.changePercent >= -2 ? "#14161A" : "#F4F2EC";
  return (
    <div className="hm-tile" style={{ background: bg, width: size, height: size * 0.72, color: textColor }} title={`${s.name}`}>
      <div className="hm-tile-sym">{s.symbol}</div>
      <div className="hm-tile-pct">{s.changePercent !== null ? `${s.changePercent >= 0 ? "+" : ""}${fmt(s.changePercent, 1)}%` : "N/A"}</div>
      <div className="hm-tile-price">${fmt(s.price)}</div>
      {s.relVolume !== null && s.relVolume > 1.8 && <div className="hm-tile-rvol">{fmt(s.relVolume, 1)}x</div>}
    </div>
  );
}

function IndexCard({ label, d }) {
  if (!d) return (
    <div className="hm-index-card">
      <div className="hm-index-label">{label}</div>
      <div className="hm-index-val">N/A</div>
    </div>
  );
  const positive = d.changePercent >= 0;
  return (
    <div className="hm-index-card">
      <div className="hm-index-label">{label}</div>
      <div className="hm-index-val">{fmt(d.price)}</div>
      <div className={`hm-index-chg ${positive ? "up" : "down"}`}>{positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{fmt(Math.abs(d.changePercent), 2)}%</div>
    </div>
  );
}

function RankList({ title, items, valueFn, icon: Icon }) {
  return (
    <div className="hm-ranklist">
      <div className="hm-ranklist-title"><Icon size={13} /> {title}</div>
      <ol className="hm-ranklist-items">
        {items.map((s, i) => (
          <li key={s.symbol + i}>
            <span className="hm-rank-sym">{s.symbol}</span>
            <span className="hm-rank-name">{s.sector}</span>
            <span className="hm-rank-val">{valueFn(s)}</span>
          </li>
        ))}
        {!items.length && <li className="hm-rank-empty">No matches</li>}
      </ol>
    </div>
  );
}

export default function Heatmap() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchWithTimeout("/api/heatmap");
      if (!res.ok) throw new Error(`http ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (e) {
      setError(e?.message || "Couldn't build the heatmap right now. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  };

  let allStocks = [], sectorStats = [], gainers = [], losers = [], mostActive = [], unusualVolume = [], new52High = [], new52Low = [];
  let advancers = 0, decliners = 0, upVolume = 0, downVolume = 0;
  let leadingSector = null, laggingSector = null, riskOn = null, swingCandidates = [], accumulationCandidates = [];

  if (data) {
    for (const [sector, stocks] of Object.entries(data.sectors)) {
      allStocks.push(...stocks);
      const withChange = stocks.filter((s) => s.changePercent !== null);
      const avgChange = withChange.length ? withChange.reduce((a, s) => a + s.changePercent, 0) / withChange.length : null;
      const adv = withChange.filter((s) => s.changePercent > 0).length;
      const dec = withChange.filter((s) => s.changePercent < 0).length;
      sectorStats.push({ sector, avgChange, adv, dec, count: stocks.length });
    }
    sectorStats.sort((a, b) => (b.avgChange ?? -999) - (a.avgChange ?? -999));
    leadingSector = sectorStats[0];
    laggingSector = sectorStats[sectorStats.length - 1];

    const withChange = allStocks.filter((s) => s.changePercent !== null);
    advancers = withChange.filter((s) => s.changePercent > 0).length;
    decliners = withChange.filter((s) => s.changePercent < 0).length;
    for (const s of allStocks) {
      if (s.volume === null) continue;
      if (s.changePercent > 0) upVolume += s.volume;
      else if (s.changePercent < 0) downVolume += s.volume;
    }

    const bySymbolUnique = Array.from(new Map(allStocks.map((s) => [s.symbol, s])).values());
    gainers = [...bySymbolUnique].filter((s) => s.changePercent !== null).sort((a, b) => b.changePercent - a.changePercent).slice(0, 20);
    losers = [...bySymbolUnique].filter((s) => s.changePercent !== null).sort((a, b) => a.changePercent - b.changePercent).slice(0, 20);
    mostActive = [...bySymbolUnique].filter((s) => s.volume !== null).sort((a, b) => b.volume - a.volume).slice(0, 10);
    unusualVolume = [...bySymbolUnique].filter((s) => s.relVolume !== null && s.relVolume > 1.8).sort((a, b) => b.relVolume - a.relVolume).slice(0, 10);
    new52High = bySymbolUnique.filter((s) => s.isNew52High);
    new52Low = bySymbolUnique.filter((s) => s.isNew52Low);

    const vix = data.indices?.VIX?.price ?? null;
    const rutChg = data.indices?.RUT?.changePercent ?? null;
    const spxChg = data.indices?.SPX?.changePercent ?? null;
    const cyclicalSectors = ["Technology", "AI", "Semiconductors", "Consumer Discretionary", "Financials"];
    const defensiveSectors = ["Utilities", "Consumer Staples", "Healthcare"];
    const cyclicalAvg = sectorStats.filter((s) => cyclicalSectors.includes(s.sector) && s.avgChange !== null);
    const defensiveAvg = sectorStats.filter((s) => defensiveSectors.includes(s.sector) && s.avgChange !== null);
    const cyclicalScore = cyclicalAvg.length ? cyclicalAvg.reduce((a, s) => a + s.avgChange, 0) / cyclicalAvg.length : 0;
    const defensiveScore = defensiveAvg.length ? defensiveAvg.reduce((a, s) => a + s.avgChange, 0) / defensiveAvg.length : 0;
    let riskScore = 0;
    if (vix !== null) riskScore += vix < 16 ? 1 : vix > 24 ? -1 : 0;
    if (rutChg !== null && spxChg !== null) riskScore += rutChg > spxChg ? 1 : rutChg < spxChg ? -1 : 0;
    riskScore += cyclicalScore > defensiveScore ? 1 : cyclicalScore < defensiveScore ? -1 : 0;
    riskScore += advancers > decliners ? 1 : advancers < decliners ? -1 : 0;
    riskOn = riskScore > 0 ? "Risk-On" : riskScore < 0 ? "Risk-Off" : "Mixed/Neutral";

    swingCandidates = bySymbolUnique
      .filter((s) => s.relVolume !== null && s.relVolume > 1.5 && s.changePercent !== null && s.changePercent > 2 && s.changePercent < 8)
      .sort((a, b) => b.relVolume - a.relVolume)
      .slice(0, 8);
    accumulationCandidates = bySymbolUnique
      .filter((s) => s.sma200 !== null && s.price > s.sma200 && s.high52 !== null && s.price < s.high52 * 0.95 && s.price > s.high52 * 0.8)
      .sort((a, b) => (a.price / a.high52) - (b.price / b.high52))
      .slice(0, 8);
  }

  return (
    <div className="hm-root">
      <style>{`
        .hm-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 50px; }
        .hm-header { padding: 22px 24px 6px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; }
        .hm-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .hm-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .hm-btn { display: flex; align-items: center; gap: 6px; background: #FFB454; color: #14161A; border: none; border-radius: 6px; padding: 10px 18px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; cursor: pointer; }
        .hm-btn:disabled { opacity: 0.6; }
        .hm-error { margin: 10px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .hm-loading { display: flex; align-items: center; gap: 8px; padding: 60px 24px; justify-content: center; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .hm-empty { padding: 60px 24px; text-align: center; color: #5A5F68; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .hm-body { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 24px; }
        .hm-section-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.02em; margin: 0 0 8px; color: #FFB454; border-bottom: 1px solid #2A2E36; padding-bottom: 6px; }

        .hm-indices-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .hm-index-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 10px 14px; min-width: 100px; }
        .hm-index-label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #888E99; text-transform: uppercase; }
        .hm-index-val { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 600; margin-top: 2px; }
        .hm-index-chg { display: flex; align-items: center; gap: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; margin-top: 2px; }
        .hm-index-chg.up { color: #5FCBA0; } .hm-index-chg.down { color: #E8697A; }

        .hm-breadth-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
        .hm-breadth-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 12px; }
        .hm-breadth-label { font-size: 10.5px; color: #888E99; text-transform: uppercase; letter-spacing: 0.04em; font-family: 'IBM Plex Mono', monospace; }
        .hm-breadth-val { font-family: 'IBM Plex Mono', monospace; font-size: 17px; font-weight: 700; margin-top: 4px; }

        .hm-sector-block { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 14px 16px; }
        .hm-sector-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
        .hm-sector-name { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 14px; }
        .hm-sector-meta { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #888E99; display: flex; gap: 10px; align-items: center; }
        .hm-sector-avg { font-weight: 700; padding: 2px 8px; border-radius: 4px; }
        .hm-sector-avg.up { color: #5FCBA0; background: rgba(95,203,160,0.12); }
        .hm-sector-avg.down { color: #E8697A; background: rgba(232,105,122,0.12); }
        .hm-tiles { display: flex; flex-wrap: wrap; gap: 6px; }
        .hm-tile { border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; justify-content: center; position: relative; font-family: 'IBM Plex Mono', monospace; }
        .hm-tile-sym { font-weight: 700; font-size: 12px; letter-spacing: 0.02em; }
        .hm-tile-pct { font-size: 11px; margin-top: 2px; font-weight: 600; }
        .hm-tile-price { font-size: 9.5px; opacity: 0.85; margin-top: 1px; }
        .hm-tile-rvol { position: absolute; top: 3px; right: 4px; font-size: 8px; background: rgba(0,0,0,0.3); padding: 1px 3px; border-radius: 3px; }

        .hm-legend { display: flex; gap: 10px; flex-wrap: wrap; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #888E99; }
        .hm-legend-item { display: flex; align-items: center; gap: 5px; }
        .hm-legend-swatch { width: 12px; height: 12px; border-radius: 3px; }

        .hm-highlights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
        .hm-ranklist { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 14px; }
        .hm-ranklist-title { display: flex; align-items: center; gap: 6px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 13px; color: #FFB454; margin-bottom: 8px; }
        .hm-ranklist-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 260px; overflow-y: auto; }
        .hm-ranklist-items li { display: flex; align-items: center; gap: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; padding: 4px 6px; border-radius: 4px; background: #14161A; }
        .hm-rank-sym { font-weight: 700; color: #EDEBE4; width: 48px; }
        .hm-rank-name { color: #6B7078; flex: 1; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hm-rank-val { font-weight: 600; }
        .hm-rank-empty { color: #5A5F68; padding: 8px; }

        .hm-unavailable-box { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 16px; font-size: 12px; color: #888E99; line-height: 1.6; display: flex; gap: 10px; align-items: flex-start; }

        .hm-summary-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 18px; }
        .hm-riskonoff { display: inline-block; padding: 5px 14px; border-radius: 8px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; margin-bottom: 10px; }
        .hm-riskonoff.on { background: rgba(95,203,160,0.14); color: #5FCBA0; }
        .hm-riskonoff.off { background: rgba(232,105,122,0.14); color: #E8697A; }
        .hm-riskonoff.mixed { background: rgba(201,154,75,0.14); color: #C99A4B; }
        .hm-summary-line { font-size: 12.5px; color: #C7CAD1; margin: 6px 0; line-height: 1.6; }
        .hm-disclaimer { font-size: 10.5px; color: #5A5F68; line-height: 1.6; background: #1C1F25; border: 1px solid #2A2E36; border-radius: 8px; padding: 14px; }
      `}</style>

      <div className="hm-header">
        <div>
          <h1>HEATMAP</h1>
          <p>Sector-grouped market heatmap — {"~"}156 large-cap names across 13 sectors, built fresh on demand</p>
        </div>
        <button className="hm-btn" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          {loading ? "Building…" : data ? "Refresh Heatmap" : "Load Heatmap"}
        </button>
      </div>

      {error && (
        <div className="hm-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}
      {loading && (
        <div className="hm-loading">
          <Loader2 size={16} className="spin" /> fetching ~160 tickers server-side (indices + 13 sectors) — this can take 15–25 seconds…
        </div>
      )}
      {!data && !loading && !error && (
        <div className="hm-empty">Tap "Load Heatmap" to pull today's session data.</div>
      )}

      {data && !loading && (
        <div className="hm-body">
          <div className="hm-sources" style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5, color: "#5A5F68" }}>
            {data.totalLoaded}/{data.totalRequested} tickers loaded · generated {new Date(data.generatedAt).toLocaleTimeString()}
          </div>

          {/* Market Internals */}
          <div>
            <div className="hm-section-title">Market Internals</div>
            <div className="hm-indices-row" style={{ marginBottom: 12 }}>
              <IndexCard label="S&P 500" d={data.indices.SPX} />
              <IndexCard label="Nasdaq" d={data.indices.NDX} />
              <IndexCard label="Dow Jones" d={data.indices.DJI} />
              <IndexCard label="Russell 2000" d={data.indices.RUT} />
              <IndexCard label="VIX" d={data.indices.VIX} />
            </div>
            <div className="hm-breadth-grid">
              <div className="hm-breadth-card"><div className="hm-breadth-label">Advancers (sample)</div><div className="hm-breadth-val" style={{ color: "#5FCBA0" }}>{advancers}</div></div>
              <div className="hm-breadth-card"><div className="hm-breadth-label">Decliners (sample)</div><div className="hm-breadth-val" style={{ color: "#E8697A" }}>{decliners}</div></div>
              <div className="hm-breadth-card"><div className="hm-breadth-label">A/D Ratio (sample)</div><div className="hm-breadth-val">{decliners ? fmt(advancers / decliners, 2) : "N/A"}</div></div>
              <div className="hm-breadth-card"><div className="hm-breadth-label">Up Volume</div><div className="hm-breadth-val" style={{ color: "#5FCBA0" }}>{fmtVol(upVolume)}</div></div>
              <div className="hm-breadth-card"><div className="hm-breadth-label">Down Volume</div><div className="hm-breadth-val" style={{ color: "#E8697A" }}>{fmtVol(downVolume)}</div></div>
            </div>
            <div className="hm-card-note" style={{ fontSize: 11, color: "#888E99", marginTop: 8 }}>
              Advance/decline and volume figures are based on this heatmap's ~156-stock large-cap sample, not the full exchange-wide tape (which requires a paid market-internals feed).
            </div>
          </div>

          {/* Sector Heatmap */}
          <div>
            <div className="hm-section-title">Sector Heatmap</div>
            <div className="hm-legend" style={{ marginBottom: 14 }}>
              {[">+5%", "+2% to +5%", "0% to +2%", "Flat", "0% to -2%", "-2% to -5%", "<-5%"].map((l, i) => {
                const sampleVals = [6, 3, 1, null, -1, -3, -6];
                return (
                  <div className="hm-legend-item" key={l}>
                    <span className="hm-legend-swatch" style={{ background: bucketColor(sampleVals[i]) }} />
                    {l}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {sectorStats.map((stat) => (
                <div className="hm-sector-block" key={stat.sector}>
                  <div className="hm-sector-top">
                    <span className="hm-sector-name">{stat.sector}</span>
                    <span className="hm-sector-meta">
                      <span className={`hm-sector-avg ${stat.avgChange >= 0 ? "up" : "down"}`}>{stat.avgChange !== null ? `${stat.avgChange >= 0 ? "+" : ""}${fmt(stat.avgChange, 2)}%` : "N/A"} avg</span>
                      <span style={{ color: "#5FCBA0" }}>{stat.adv}↑</span>
                      <span style={{ color: "#E8697A" }}>{stat.dec}↓</span>
                    </span>
                  </div>
                  <div className="hm-tiles">
                    {data.sectors[stat.sector].map((s) => <Tile s={s} key={s.symbol + stat.sector} />)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Highlights */}
          <div>
            <div className="hm-section-title">Highlights</div>
            <div className="hm-highlights-grid">
              <RankList title="Top Gainers" items={gainers} icon={TrendingUp} valueFn={(s) => `+${fmt(s.changePercent, 1)}%`} />
              <RankList title="Top Losers" items={losers} icon={TrendingDown} valueFn={(s) => `${fmt(s.changePercent, 1)}%`} />
              <RankList title="Most Active (Volume)" items={mostActive} icon={Activity} valueFn={(s) => fmtVol(s.volume)} />
              <RankList title="Unusual Volume (RVOL > 1.8x)" items={unusualVolume} icon={Flame} valueFn={(s) => `${fmt(s.relVolume, 2)}x`} />
              <RankList title="New 52-Week Highs" items={new52High} icon={TrendingUp} valueFn={(s) => `$${fmt(s.price)}`} />
              <RankList title="New 52-Week Lows" items={new52Low} icon={TrendingDown} valueFn={(s) => `$${fmt(s.price)}`} />
            </div>
          </div>

          {/* Institutional Activity */}
          <div>
            <div className="hm-section-title">Institutional Activity</div>
            <div className="hm-unavailable-box">
              <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Dark pool activity, large block trades, unusual options activity, gamma exposure (GEX), and dealer positioning aren't available at market-wide scale from free data sources — running real options-chain analysis across ~156 tickers isn't practical here. For a real, computed GEX approximation, max pain, and options walls on a single ticker, use the <strong>Deep Dive</strong> tab.
              </span>
            </div>
          </div>

          {/* Summary */}
          <div>
            <div className="hm-section-title">Market Summary</div>
            <div className="hm-summary-card">
              <div className={`hm-riskonoff ${riskOn === "Risk-On" ? "on" : riskOn === "Risk-Off" ? "off" : "mixed"}`}>{riskOn}</div>
              <div className="hm-summary-line"><strong>Leading sector:</strong> {leadingSector?.sector} ({leadingSector?.avgChange >= 0 ? "+" : ""}{fmt(leadingSector?.avgChange, 2)}% avg)</div>
              <div className="hm-summary-line"><strong>Lagging sector:</strong> {laggingSector?.sector} ({laggingSector?.avgChange >= 0 ? "+" : ""}{fmt(laggingSector?.avgChange, 2)}% avg)</div>
              <div className="hm-summary-line">
                <strong>Read:</strong> {riskOn === "Risk-On"
                  ? "Cyclical sectors and small caps (Russell 2000) are outperforming defensives, and breadth/VIX support a risk-on tape."
                  : riskOn === "Risk-Off"
                  ? "Defensive sectors are holding up better than cyclicals, and breadth/VIX point to a risk-off tape."
                  : "Signals are mixed — no clean risk-on/risk-off read today."} This is a data-driven read from sector spread, VIX, breadth, and small-vs-large-cap performance, not a claim about specific news catalysts — check the <strong>News</strong> tab for the "why" behind today's move.
              </div>

              <div className="hm-summary-line" style={{ marginTop: 14 }}><strong>Potential swing trade candidates</strong> (elevated relative volume + strong up move, not yet extended):</div>
              <div className="hm-tiles" style={{ marginTop: 6 }}>
                {swingCandidates.length ? swingCandidates.map((s) => <Tile s={s} key={"swing" + s.symbol} />) : <span style={{ color: "#5A5F68", fontSize: 12 }}>No matches today</span>}
              </div>

              <div className="hm-summary-line" style={{ marginTop: 14 }}><strong>Potential long-term accumulation candidates</strong> (above 200-day SMA, pulled back 5–20% from 52-week high):</div>
              <div className="hm-tiles" style={{ marginTop: 6 }}>
                {accumulationCandidates.length ? accumulationCandidates.map((s) => <Tile s={s} key={"acc" + s.symbol} />) : <span style={{ color: "#5A5F68", fontSize: 12 }}>No matches today</span>}
              </div>
            </div>
          </div>

          <div className="hm-disclaimer">
            <strong>What's real vs. modeled:</strong> every price, % change, volume, relative volume, and 52-week high/low above is live data for the ticker shown. The sector universe (which ~12 tickers represent each sector) is a curated snapshot, not a live "top 20 by market cap" ranking. Advance/decline, breadth, and up/down volume are computed from this ~156-stock sample, not the full market. Institutional/options-flow data is explicitly marked unavailable rather than estimated. Risk-on/risk-off, swing candidates, and accumulation candidates are this tool's own transparent screening logic over real data — not predictions, not personalized advice, and not a substitute for a licensed financial advisor.
          </div>
        </div>
      )}
    </div>
  );
}
