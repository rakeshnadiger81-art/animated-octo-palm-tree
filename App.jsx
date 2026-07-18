import React, { useState } from "react";
import { LayoutGrid, LineChart, Newspaper, CalendarDays, Microscope, Landmark, Grid3x3 } from "lucide-react";
import StockDesk from "./StockDesk.jsx";
import Analyzer from "./Analyzer.jsx";
import News from "./News.jsx";
import Events from "./Events.jsx";
import DeepDive from "./DeepDive.jsx";
import Invest from "./Invest.jsx";
import Heatmap from "./Heatmap.jsx";

const TABS = [
  { key: "desk", label: "Watchlist", icon: LayoutGrid },
  { key: "analyzer", label: "Analyzer", icon: LineChart },
  { key: "deepdive", label: "Deep Dive", icon: Microscope },
  { key: "invest", label: "Invest", icon: Landmark },
  { key: "heatmap", label: "Heatmap", icon: Grid3x3 },
  { key: "news", label: "News", icon: Newspaper },
  { key: "events", label: "Events", icon: CalendarDays },
];

export default function App() {
  const [tab, setTab] = useState("desk");

  return (
    <div style={{ background: "#14161A", minHeight: "100vh" }}>
      <style>{`
        .tab-bar { display: flex; gap: 2px; background: #0D0E11; border-bottom: 1px solid #2A2E36; padding: 0 24px; overflow-x: auto; }
        .tab-btn { display: flex; align-items: center; gap: 7px; background: transparent; border: none; color: #6B7078; padding: 12px 16px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 600; font-size: 13px; letter-spacing: 0.03em; cursor: pointer; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; white-space: nowrap; }
        .tab-btn:hover { color: #ADB1B9; }
        .tab-btn.active { color: #FFB454; border-bottom-color: #FFB454; }
      `}</style>
      <div className="tab-bar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`tab-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {tab === "desk" && <StockDesk />}
      {tab === "analyzer" && <Analyzer />}
      {tab === "deepdive" && <DeepDive />}
      {tab === "invest" && <Invest />}
      {tab === "heatmap" && <Heatmap />}
      {tab === "news" && <News />}
      {tab === "events" && <Events />}
    </div>
  );
}
