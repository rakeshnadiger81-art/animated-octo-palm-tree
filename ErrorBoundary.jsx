import React from "react";
import { AlertOctagon, RefreshCw } from "lucide-react";

// Wraps a single tab. If that tab throws during render, this catches it and shows a recoverable
// message instead of the crash taking down the whole app (React unmounts the entire tree on an
// uncaught render error by default — without this, one bad response from a data source could
// blank every tab, not just the one that failed).
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`Error in tab "${this.props.label || "unknown"}":`, error, info);
  }
  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", background: "#14161A", color: "#EDEBE4", fontFamily: "Inter, sans-serif", padding: "60px 24px", textAlign: "center" }}>
          <AlertOctagon size={28} color="#E8697A" style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontWeight: 700, fontSize: 17, marginBottom: 8 }}>
            {this.props.label || "This tab"} hit an unexpected error
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#888E99", marginBottom: 20, maxWidth: 420, marginLeft: "auto", marginRight: "auto" }}>
            {String(this.state.error?.message || this.state.error || "Unknown error")}
          </div>
          <button
            onClick={this.handleReset}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#FFB454", color: "#14161A", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
          >
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
