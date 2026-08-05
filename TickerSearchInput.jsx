import React, { useState, useEffect, useRef } from "react";
import { searchSymbols } from "./tickerSearch.js";

// Drop-in replacement for a plain <input> inside an existing search-box wrapper. Renders its
// own position:relative wrapper so the suggestion dropdown works regardless of the parent's
// CSS, but intentionally has no inline styling on the <input> itself — it relies on the
// parent's existing descendant CSS selector (e.g. ".an-search-box input") to pick up the same
// look every tab already has, so no per-tab CSS changes are needed.
export default function TickerSearchInput({ value, onChange, onSelect, placeholder, maxLength = 10 }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = (value || "").trim();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const myReqId = ++reqIdRef.current;
      try {
        const results = await searchSymbols(q);
        if (myReqId !== reqIdRef.current) return; // a newer keystroke superseded this request
        setSuggestions(results);
        setOpen(results.length > 0);
      } catch (e) {
        if (myReqId === reqIdRef.current) {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [value]);

  const handlePick = (symbol) => {
    onChange(symbol);
    setOpen(false);
    if (onSelect) onSelect(symbol);
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { if (suggestions.length) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50,
            background: "#1C1F25", border: "1px solid #2A2E36", borderRadius: 8,
            maxHeight: 260, overflowY: "auto", boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
          }}
        >
          {suggestions.map((s) => (
            <div
              key={s.symbol}
              onClick={() => handlePick(s.symbol)}
              style={{
                padding: "9px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between",
                gap: 10, borderBottom: "1px solid #22252B", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <span style={{ fontWeight: 700, color: "#FFB454", flexShrink: 0 }}>{s.symbol}</span>
              <span style={{ color: "#888E99", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
