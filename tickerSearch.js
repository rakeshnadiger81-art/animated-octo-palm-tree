// Shared across every tab with a ticker input. Uses Yahoo's public autocomplete/search
// endpoint so typing a company name ("oracle") or partial symbol resolves to real tickers
// ("ORCL"), not just exact-symbol matches.

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function searchSymbols(query) {
  const q = query.trim();
  if (q.length < 1) return [];
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  let data;
  try {
    const res = await fetchWithTimeout(url, { mode: "cors" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    data = await res.json();
  } catch (e) {
    const res = await fetchWithTimeout(`/api/proxy?url=${encodeURIComponent(url)}`, { headers: { "x-app-proxy": "stockdesk" } });
    if (!res.ok) throw new Error(`proxy http ${res.status}`);
    data = await res.json();
  }
  const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
  const mapped = quotes
    .filter((q2) => q2.symbol)
    .map((q2) => ({
      symbol: q2.symbol,
      name: q2.shortname || q2.longname || q2.symbol,
      exchange: q2.exchDisp || "",
      type: q2.quoteType || "",
    }));
  const preferred = mapped.filter((m) => m.type === "EQUITY" || m.type === "ETF");
  return (preferred.length ? preferred : mapped).slice(0, 8);
}
