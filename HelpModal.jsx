import React from "react";
import { X } from "lucide-react";

// Shared across Analyzer.jsx, DeepDive.jsx, and Invest.jsx.
export default function HelpModal({ entry, onClose }) {
  if (!entry) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#1C1F25", border: "1px solid #2A2E36", borderRadius: 12, padding: 20, maxWidth: 420, width: "100%", fontFamily: "Inter, sans-serif" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
          <span style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontWeight: 700, fontSize: 15, color: "#FFB454" }}>{entry.term}</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#888E99", cursor: "pointer", flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ fontSize: 13, color: "#C7CAD1", lineHeight: 1.6 }}>{entry.body}</div>
      </div>
    </div>
  );
}
