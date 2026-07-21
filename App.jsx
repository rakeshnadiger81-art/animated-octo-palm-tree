import React, { useState, useEffect, Suspense, lazy } from "react";
import { LayoutGrid, LineChart, Newspaper, CalendarDays, Microscope, Landmark, Grid3x3, CalendarClock, WifiOff, Activity, Loader2, X, CheckCircle2, XCircle } from "lucide-react";
import ErrorBoundary from "./ErrorBoundary.jsx";

// Lazy-loaded: each tab only downloads its JS when first opened, instead of all seven shipping
// in one bundle up front. Meaningfully cuts initial load time since most tabs (Deep Dive, Invest,
// Heatmap especially) are large and most visits only touch one or two tabs.
const StockDesk = lazy(() => import("./StockDesk.jsx"));
const Analyzer = lazy(() => import("./Analyzer.jsx"));
const News = lazy(() => import("./News.jsx"));
const Events = lazy(() => import("./Events.jsx"));
const Earnings = lazy(() => import("./Earnings.jsx"));
const DeepDive = lazy(() => import("./DeepDive.jsx"));
const Invest = lazy(() => import("./Invest.jsx"));
const Heatmap = lazy(() => import("./Heatmap.jsx"));

const TABS = [
  { key: "desk", label: "Watchlist", icon: LayoutGrid, Component: StockDesk },
  { key: "analyzer", label: "Analyzer", icon: LineChart, Component: Analyzer },
  { key: "deepdive", label: "Deep Dive", icon: Microscope, Component: DeepDive },
  { key: "invest", label: "Invest", icon: Landmark, Component: Invest },
  { key: "heatmap", label: "Heatmap", icon: Grid3x3, Component: Heatmap },
  { key: "news", label: "News", icon: Newspaper, Component: News },
  { key: "events", label: "Events", icon: CalendarDays, Component: Events },
  { key: "earnings", label: "Earnings", icon: CalendarClock, Component: Earnings },
];

function TabLoadingFallback() {
  return (
    <div style={{ minHeight: "100vh", background: "#14161A", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#888E99", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
      <Loader2 size={16} className="app-spin" /> loading tab…
    </div>
  );
}

function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  if (online) return null;
  return (
    <div style={{ background: "#8E1F35", color: "#F4F2EC", padding: "8px 16px", display: "flex", alignItems: "center", gap: 8, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, justifyContent: "center" }}>
      <WifiOff size={14} /> You're offline — data won't load until your connection is back.
    </div>
  );
}

function HealthPanel({ onClose }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/health");
        setStatus(await res.json());
      } catch (e) {
        setStatus({ error: "Couldn't reach the health check endpoint itself." });
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onClose}>
      <div
        style={{ background: "#1C1F25", border: "1px solid #2A2E36", borderRadius: 12, padding: 20, maxWidth: 420, width: "100%", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#EDEBE4" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontWeight: 700, fontSize: 15, color: "#FFB454" }}>Data Source Status</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#888E99", cursor: "pointer" }}>
            <X size={16} />
          </button>
        </div>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#888E99", padding: "16px 0" }}>
            <Loader2 size={14} className="app-spin" /> checking…
          </div>
        )}
        {!loading && status?.error && <div style={{ color: "#E8697A" }}>{status.error}</div>}
        {!loading && status?.services && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(status.services).map(([name, s]) => (
              <div key={name} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#14161A", borderRadius: 6, padding: "8px 10px" }}>
                {s.ok ? <CheckCircle2 size={14} color="#5FCBA0" style={{ flexShrink: 0, marginTop: 1 }} /> : <XCircle size={14} color="#E8697A" style={{ flexShrink: 0, marginTop: 1 }} />}
                <div>
                  <div style={{ fontWeight: 700, textTransform: "capitalize" }}>{name} {s.latencyMs !== undefined && <span style={{ color: "#5A5F68", fontWeight: 400 }}>({s.latencyMs}ms)</span>}</div>
                  <div style={{ color: "#888E99", fontSize: 10.5, marginTop: 2 }}>{s.note}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("desk");
  const [showHealth, setShowHealth] = useState(false);
  const activeTab = TABS.find((t) => t.key === tab);
  const ActiveComponent = activeTab.Component;

  return (
    <div style={{ background: "#14161A", minHeight: "100vh" }}>
      <style>{`
        .tab-bar { display: flex; gap: 2px; background: #0D0E11; border-bottom: 1px solid #2A2E36; padding: 0 8px 0 24px; overflow-x: auto; align-items: center; }
        .tab-btn { display: flex; align-items: center; gap: 7px; background: transparent; border: none; color: #6B7078; padding: 12px 16px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 13px; letter-spacing: 0.03em; cursor: pointer; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; white-space: nowrap; }
        .tab-btn:hover { color: #ADB1B9; }
        .tab-btn.active { color: #FFB454; border-bottom-color: #FFB454; }
        .health-btn { margin-left: auto; background: transparent; border: none; color: #5A5F68; cursor: pointer; padding: 8px; display: flex; align-items: center; flex-shrink: 0; }
        .health-btn:hover { color: #FFB454; }
        .app-spin { animation: app-spin 1s linear infinite; }
        @keyframes app-spin { to { transform: rotate(360deg); } }
      `}</style>
      <OfflineBanner />
      <div className="tab-bar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`tab-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            <Icon size={14} /> {label}
          </button>
        ))}
        <button className="health-btn" onClick={() => setShowHealth(true)} title="Data source status">
          <Activity size={15} />
        </button>
      </div>
      <ErrorBoundary label={activeTab.label} key={tab}>
        <Suspense fallback={<TabLoadingFallback />}>
          <ActiveComponent />
        </Suspense>
      </ErrorBoundary>
      {showHealth && <HealthPanel onClose={() => setShowHealth(false)} />}
    </div>
  );
}
