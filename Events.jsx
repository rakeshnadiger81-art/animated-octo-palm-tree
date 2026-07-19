import React, { useState, useEffect, useCallback } from "react";
import { Loader2, AlertTriangle, TrendingUp, TrendingDown, CalendarDays } from "lucide-react";

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Curated, manually-verified major US macro events (accurate as of when this was built —
// mid-July 2026). These are the highest-impact, most-anticipated releases; anything beyond
// this list within the 30-day window is filled in live from the ForexFactory calendar below.
const CURATED_EVENTS = [
  {
    date: "2026-07-15T12:30:00Z",
    title: "PPI (Producer Price Index) — June 2026",
    category: "Inflation",
    impactUp: "A softer-than-expected PPI print (cooling wholesale inflation) is typically read as disinflationary and can lift equities on reduced rate-hike/hold pressure.",
    impactDown: "A hotter-than-expected PPI print can revive inflation concerns, pushing yields up and pressuring equities, especially rate-sensitive growth stocks.",
  },
  {
    date: "2026-07-29T18:00:00Z",
    title: "FOMC Rate Decision & Press Conference",
    category: "Fed / Rates",
    impactUp: "A hold or a dovish tone (openness to future cuts) is often read bullishly — lower discount rates support equity valuations, especially growth/tech.",
    impactDown: "A hawkish hold or surprise emphasis on persistent inflation can pressure equities and lift the dollar, as markets price in \"higher for longer\" rates.",
  },
  {
    date: "2026-08-07T12:30:00Z",
    title: "Employment Situation (Jobs Report) — July 2026",
    category: "Labor",
    impactUp: "A cooler jobs report (softer payrolls growth, ticking-up unemployment) can boost rate-cut odds, often lifting equities and pressuring the dollar.",
    impactDown: "A hot jobs report (strong payrolls, falling unemployment) can reduce rate-cut odds and pressure equities on \"good news is bad news\" concerns about inflation.",
  },
  {
    date: "2026-08-12T12:30:00Z",
    title: "CPI (Consumer Price Index) — July 2026",
    category: "Inflation",
    impactUp: "Lower-than-expected CPI (cooling inflation) tends to move markets upward — it raises the odds of rate cuts and eases pressure on borrowing costs.",
    impactDown: "Higher-than-expected CPI tends to move markets downward — it raises the odds the Fed stays restrictive for longer, pressuring equity valuations.",
  },
];

function impactTemplateFor(title) {
  const t = title.toLowerCase();
  if (t.includes("interest rate") || t.includes("fomc") || t.includes("rate decision")) {
    return {
      category: "Fed / Rates",
      impactUp: "A hold or dovish surprise is often read bullishly for equities as it lowers the discount rate on future earnings.",
      impactDown: "A hawkish surprise or unexpected hike typically pressures equities and lifts the dollar.",
    };
  }
  if (t.includes("cpi") || t.includes("inflation") || t.includes("pce")) {
    return {
      category: "Inflation",
      impactUp: "A cooler-than-expected reading tends to move markets upward on improved rate-cut odds.",
      impactDown: "A hotter-than-expected reading tends to move markets downward on reduced rate-cut odds.",
    };
  }
  if (t.includes("employment") || t.includes("payroll") || t.includes("unemployment") || t.includes("jobless") || t.includes("nonfarm")) {
    return {
      category: "Labor",
      impactUp: "A softer print can lift equities on higher rate-cut odds, though a very weak print can spook markets on growth concerns.",
      impactDown: "A stronger-than-expected print can pressure equities on reduced rate-cut odds.",
    };
  }
  if (t.includes("gdp")) {
    return {
      category: "Growth",
      impactUp: "Stronger-than-expected growth is typically supportive for equities, particularly cyclicals.",
      impactDown: "Weaker-than-expected growth can weigh on risk assets on recession concerns.",
    };
  }
  if (t.includes("retail sales")) {
    return {
      category: "Consumer",
      impactUp: "Stronger consumer spending is typically supportive for equities, especially consumer discretionary names.",
      impactDown: "Weaker retail sales can weigh on consumer-linked sectors and broader sentiment.",
    };
  }
  if (t.includes("pmi") || t.includes("ism") || t.includes("manufacturing") || t.includes("services")) {
    return {
      category: "Business Activity",
      impactUp: "A reading above expectations (and above 50, indicating expansion) is typically supportive for equities.",
      impactDown: "A reading below expectations (or below 50, indicating contraction) can weigh on cyclicals and broader sentiment.",
    };
  }
  return {
    category: "Scheduled Release",
    impactUp: "A better-than-forecast print is generally read as a positive surprise.",
    impactDown: "A worse-than-forecast print is generally read as a negative surprise.",
  };
}

async function fetchFFWeek(which) {
  const url = `https://nfs.faireconomy.media/ff_calendar_${which}.json`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } catch (e) {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(proxyUrl, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error(`proxy http ${res.status}`);
    return await res.json();
  }
}

function fmtDate(d) {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export default function Events() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [liveCount, setLiveCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const now = Date.now();
    const horizon = now + 30 * 24 * 60 * 60 * 1000;

    const curated = CURATED_EVENTS.map((e) => ({
      title: e.title,
      category: e.category,
      date: new Date(e.date),
      impactUp: e.impactUp,
      impactDown: e.impactDown,
      confirmed: true,
    })).filter((e) => e.date.getTime() >= now && e.date.getTime() <= horizon);

    let live = [];
    try {
      const [thisWeek, nextWeek] = await Promise.all([
        fetchFFWeek("thisweek").catch(() => []),
        fetchFFWeek("nextweek").catch(() => []),
      ]);
      const combined = [...(Array.isArray(thisWeek) ? thisWeek : []), ...(Array.isArray(nextWeek) ? nextWeek : [])];
      live = combined
        .filter((e) => e.country === "USD" && (e.impact === "High" || e.impact === "Medium"))
        .map((e) => {
          const d = new Date(e.date);
          const tpl = impactTemplateFor(e.title || "");
          return {
            title: e.title,
            category: tpl.category,
            date: d,
            impactUp: tpl.impactUp,
            impactDown: tpl.impactDown,
            confirmed: false,
            impactLevel: e.impact,
          };
        })
        .filter((e) => !isNaN(e.date.getTime()) && e.date.getTime() >= now && e.date.getTime() <= horizon);
    } catch (e) {
      // live feed unavailable — curated list still stands on its own
    }

    // merge, de-duping anything that's essentially the same event/day as a curated entry
    const merged = [...curated];
    for (const ev of live) {
      const dupe = curated.some(
        (c) => Math.abs(c.date.getTime() - ev.date.getTime()) < 12 * 60 * 60 * 1000 && c.title.toLowerCase().includes(ev.title.toLowerCase().split(" ")[0])
      );
      if (!dupe) merged.push(ev);
    }
    merged.sort((a, b) => a.date.getTime() - b.date.getTime());

    setLiveCount(live.length);
    setEvents(merged);
    if (!merged.length) setError("Couldn't load the live economic calendar feed, and no curated events fall in the next 30 days.");
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="ev-root">
      <style>{`
        .ev-root { min-height: 100vh; background: #14161A; color: #EDEBE4; font-family: 'Inter', sans-serif; padding-bottom: 40px; }
        .ev-header { padding: 22px 24px 6px; }
        .ev-header h1 { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 22px; margin: 0 0 4px; }
        .ev-header p { color: #888E99; font-size: 12px; margin: 0; font-family: 'IBM Plex Mono', monospace; }
        .ev-sources { padding: 10px 24px 0; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #5A5F68; }
        .ev-error { margin: 14px 24px 0; display: flex; gap: 8px; align-items: flex-start; background: rgba(232,105,122,0.1); border: 1px solid rgba(232,105,122,0.35); color: #F0919E; border-radius: 8px; padding: 12px 14px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; line-height: 1.5; }
        .ev-loading { display: flex; align-items: center; gap: 8px; padding: 60px 24px; justify-content: center; color: #888E99; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .ev-list { padding: 18px 24px 0; display: flex; flex-direction: column; gap: 12px; }
        .ev-card { background: #1C1F25; border: 1px solid #2A2E36; border-radius: 10px; padding: 16px; }
        .ev-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
        .ev-date-badge { display: flex; flex-direction: column; align-items: center; justify-content: center; background: #0D0E11; border: 1px solid #2A2E36; border-radius: 8px; padding: 8px 12px; min-width: 62px; font-family: 'IBM Plex Mono', monospace; }
        .ev-date-badge .d { font-size: 17px; font-weight: 700; color: #FFB454; line-height: 1; }
        .ev-date-badge .m { font-size: 9px; color: #888E99; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 3px; }
        .ev-title-block { flex: 1; min-width: 200px; }
        .ev-title { font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 15px; }
        .ev-meta { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #888E99; margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .ev-tag { padding: 1px 7px; border-radius: 4px; background: rgba(255,180,84,0.12); color: #FFB454; }
        .ev-tag.confirmed { background: rgba(95,203,160,0.12); color: #5FCBA0; }
        .ev-impacts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
        .ev-impact { border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.5; }
        .ev-impact.up { background: rgba(95,203,160,0.08); border: 1px solid rgba(95,203,160,0.25); color: #C7CAD1; }
        .ev-impact.down { background: rgba(232,105,122,0.08); border: 1px solid rgba(232,105,122,0.25); color: #C7CAD1; }
        .ev-impact-label { display: flex; align-items: center; gap: 5px; font-family: 'IBM Plex Sans Condensed', sans-serif; font-weight: 700; font-size: 11px; margin-bottom: 4px; letter-spacing: 0.03em; }
        .ev-impact-label.up { color: #5FCBA0; }
        .ev-impact-label.down { color: #E8697A; }
        @media (max-width: 480px) { .ev-impacts { grid-template-columns: 1fr; } }
        .ev-disclaimer { padding: 20px 24px 0; font-size: 10.5px; color: #5A5F68; line-height: 1.5; }
      `}</style>

      <div className="ev-header">
        <h1>EVENTS</h1>
        <p>Major scheduled market-moving events over the next 30 days, with directional context</p>
      </div>
      <div className="ev-sources">
        Curated Fed/BLS release dates (verified) + live ForexFactory economic calendar ({liveCount} additional USD events)
      </div>

      {error && (
        <div className="ev-error">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div className="ev-loading">
          <Loader2 size={16} className="spin" /> loading calendar…
        </div>
      )}

      {!loading && events.length > 0 && (
        <div className="ev-list">
          {events.map((ev, i) => (
            <div className="ev-card" key={i}>
              <div className="ev-top">
                <div className="ev-date-badge">
                  <span className="d">{ev.date.getDate()}</span>
                  <span className="m">{ev.date.toLocaleDateString("en-US", { month: "short" })}</span>
                </div>
                <div className="ev-title-block">
                  <div className="ev-title">{ev.title}</div>
                  <div className="ev-meta">
                    <CalendarDays size={11} />
                    {fmtDate(ev.date)} · {fmtTime(ev.date)}
                    <span className={`ev-tag ${ev.confirmed ? "confirmed" : ""}`}>
                      {ev.confirmed ? "verified date" : `${ev.impactLevel || ""} impact`}
                    </span>
                    <span className="ev-tag">{ev.category}</span>
                  </div>
                </div>
              </div>
              <div className="ev-impacts">
                <div className="ev-impact up">
                  <div className="ev-impact-label up">
                    <TrendingUp size={12} /> If better / dovish
                  </div>
                  {ev.impactUp}
                </div>
                <div className="ev-impact down">
                  <div className="ev-impact-label down">
                    <TrendingDown size={12} /> If worse / hawkish
                  </div>
                  {ev.impactDown}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="ev-disclaimer">
        Directional notes describe typical historical market reactions, not predictions — actual
        reactions depend on how far results diverge from consensus and the broader market
        backdrop. Not financial advice. Curated events reflect officially published Fed/BLS
        schedules; the ForexFactory feed covers the current and next calendar week live and may
        shift as it's revised upstream.
      </div>
    </div>
  );
}
