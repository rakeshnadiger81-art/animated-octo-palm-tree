// Pings each upstream data source this app depends on and reports whether it's currently
// reachable. Useful for quickly telling "is it my code or is it them" apart when something
// breaks. Runs server-side so it also implicitly tests the same network path the /api/proxy
// and /api/heatmap functions use.

async function ping(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 6000);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" },
      ...opts,
    });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, status: null, latencyMs: Date.now() - start, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req, res) {
  const [yahoo, cnbc, finnhub, forexFactory] = await Promise.all([
    ping("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=5m"),
    ping("https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ping("https://finnhub.io/api/v1/quote?symbol=AAPL&token=demo"), // "demo" will 401, but a fast 401 still proves reachability
    ping("https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
  ]);

  const services = {
    yahoo: { ...yahoo, note: "Powers Watchlist, Analyzer, Deep Dive, Invest, Heatmap" },
    cnbc: { ...cnbc, note: "Powers News tab headlines" },
    finnhub: { ...finnhub, ok: finnhub.status === 401 || finnhub.ok, note: "A 401 here just means the demo token was rejected — it still confirms Finnhub is reachable. Powers Deep Dive/Invest fundamentals and the optional live-data key." },
    forexFactory: { ...forexFactory, note: "Powers Events tab live calendar" },
  };

  const allOk = Object.values(services).every((s) => s.ok);
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ healthy: allOk, checkedAt: Date.now(), services });
}
