// Server-side passthrough proxy for a small allowlist of market-data hosts.
// Runs on Vercel as a Node.js serverless function (any file under /api is auto-deployed).
// Because this executes server-side, there's no browser CORS restriction to work around —
// this replaces the need for third-party CORS proxies (allorigins.win, corsproxy.io, etc.)
// which are free, unauthenticated, and prone to being rate-limited or going down.

const ALLOWED_HOSTS = new Set([
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "www.cnbc.com",
  "nfs.faireconomy.media",
  "finnhub.io",
]);

export default async function handler(req, res) {
  // Lightweight abuse deterrent: only this app's own frontend sends this header, so a random
  // bot/script that discovers the URL and hits it directly gets turned away. This isn't real
  // authentication (there's no secret worth protecting here — the allowlisted hosts are all
  // public APIs) — it just keeps this function from becoming an open relay for anyone who finds
  // the URL, which could otherwise burn through rate limits on the upstream services.
  if (req.headers["x-app-proxy"] !== "stockdesk") {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const { url } = req.query;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "missing url parameter" });
    return;
  }

  let target;
  try {
    target = new URL(url);
  } catch (e) {
    res.status(400).json({ error: "invalid url" });
    return;
  }

  if (!ALLOWED_HOSTS.has(target.hostname)) {
    res.status(403).json({ error: `host not allowed: ${target.hostname}` });
    return;
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json, text/xml, text/plain, */*",
      },
    });
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const body = await upstream.text();
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "public, max-age=10, stale-while-revalidate=30");
    res.status(upstream.status).send(body);
  } catch (e) {
    res.status(502).json({ error: "upstream fetch failed", message: String(e && e.message ? e.message : e) });
  }
}
