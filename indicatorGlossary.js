// Shared across Analyzer.jsx, DeepDive.jsx, and Invest.jsx. Keeps indicator explanations
// consistent and in one place instead of duplicating ~50 definitions three times.

export const GLOSSARY = {
  rsi: {
    term: "RSI (Relative Strength Index)",
    body: "Measures how fast and how far price has moved recently, on a 0–100 scale. Above 70 is typically read as overbought (a pullback becomes more likely), below 30 as oversold (a bounce becomes more likely). It drives price indirectly — traders and algorithms watch these thresholds, so crowded positioning near them can trigger reversals.",
  },
  stochRsi: {
    term: "Stochastic RSI",
    body: "Applies the Stochastic oscillator formula to RSI values instead of price, making it more sensitive and faster-reacting than plain RSI. Readings above 80 suggest overbought, below 20 oversold. Because it's more volatile, it's often used for earlier (but noisier) reversal signals.",
  },
  macd: {
    term: "MACD (Moving Average Convergence Divergence)",
    body: "The gap between a fast and slow EMA (the MACD line), plus a signal line (an EMA of that gap). When MACD crosses above its signal line, momentum is turning up; below, turning down. It's a lagging-but-reliable momentum gauge — many systematic strategies use MACD crossovers as entry/exit triggers, which is part of why the crossover itself can move price.",
  },
  ema: {
    term: "EMA (Exponential Moving Average)",
    body: "A moving average that weights recent prices more heavily than older ones, so it reacts faster than a simple average. Price crossing above/below a key EMA (like the 20-day) is a common trend-change signal. Because so many traders watch the same EMAs, they can act as dynamic support or resistance.",
  },
  sma: {
    term: "SMA (Simple Moving Average)",
    body: "The average closing price over a fixed number of periods, weighted equally. Longer SMAs (50/100/200-day) are the standard reference for trend direction — price above the 200-day SMA is the most widely used definition of a long-term uptrend. Institutional trend-following strategies often use these exact lines, so they frequently act as real support/resistance.",
  },
  bollinger: {
    term: "Bollinger Bands",
    body: "A moving average with bands plotted a set number of standard deviations above and below it, widening and narrowing with volatility. Price pressing the upper band suggests it's statistically extended to the upside (and vice versa); bands squeezing tight often precede a sharp move as volatility mean-reverts.",
  },
  atr: {
    term: "ATR (Average True Range)",
    body: "The average size of a stock's daily trading range, in dollars — a pure volatility measure with no directional bias. Used to size expected price swings (e.g. a weekly move estimate is often ATR × √5) and to set stop-losses proportional to how much a stock actually moves, rather than an arbitrary percentage.",
  },
  fibonacci: {
    term: "Fibonacci Retracement / Extension",
    body: "Horizontal levels (23.6%, 38.2%, 50%, 61.8%, etc.) drawn between a swing high and low, based on ratios found in the Fibonacci sequence. There's no fundamental reason price should respect these levels — but because so many traders draw and watch the same ones, they can become self-fulfilling support/resistance zones.",
  },
  vwap: {
    term: "VWAP (Volume-Weighted Average Price)",
    body: "The average price a stock has traded at today, weighted by volume at each price level — effectively \"what most of today's dollars paid.\" Institutional execution algorithms are frequently benchmarked against VWAP, so price trading above/below it can reflect real institutional buying/selling pressure, not just retail sentiment.",
  },
  anchoredVwap: {
    term: "Anchored VWAP",
    body: "Same calculation as VWAP, but starting from a specific chosen date (like a swing low) instead of resetting daily. It shows the average cost basis of everyone who's bought since that anchor point — price below it means the average buyer since then is underwater, which can create overhead resistance as they look to exit near breakeven.",
  },
  volumeProfile: {
    term: "Volume Profile (VPVR)",
    body: "Shows how much trading volume occurred at each price level over a period, rather than over time. The Point of Control (POC) is the price with the most volume — often the level the market has most \"agreed\" on and therefore worth defending. Price tends to move faster through low-volume areas and slower/choppier through high-volume ones.",
  },
  adx: {
    term: "ADX (Average Directional Index)",
    body: "Measures how strong a trend is, regardless of direction, on a 0–100 scale. Above 25 generally indicates a trending market (where trend-following signals are more reliable); below 20 suggests a range-bound market (where trend signals tend to whipsaw). Paired +DI/-DI lines show which direction is winning.",
  },
  supertrend: {
    term: "Supertrend",
    body: "An ATR-based trailing stop/trend indicator that flips between a line above price (downtrend) and below price (uptrend). It's popular for its simplicity — the flip itself is often used as a mechanical buy/sell signal by systematic traders, which can add real momentum right at the flip point.",
  },
  ichimoku: {
    term: "Ichimoku Cloud",
    body: "A multi-part system (Tenkan, Kijun, and a projected \"cloud\" of two Senkou spans) that shows trend direction, momentum, and support/resistance in one view. Price above the cloud is bullish, below is bearish, inside is transitional/uncertain. The cloud's thickness reflects how much support/resistance is expected at that zone.",
  },
  obv: {
    term: "OBV (On-Balance Volume)",
    body: "A running total that adds a day's volume when price closes up and subtracts it when price closes down. The idea is that volume often leads price — if OBV is rising while price is flat or falling, it can suggest quiet accumulation building beneath the surface (and vice versa for distribution).",
  },
  cmf: {
    term: "CMF (Chaikin Money Flow)",
    body: "Combines price location within each day's range and volume to estimate buying vs. selling pressure over a period, oscillating around zero. Positive readings suggest net buying pressure (closes nearer the day's highs on higher volume), negative suggests net selling pressure.",
  },
  pivot: {
    term: "Pivot Points",
    body: "Support/resistance levels calculated mechanically from the prior period's high, low, and close (a pivot, with R1/R2 resistance and S1/S2 support above/below it). Originally a floor-trader tool, still widely watched — because so many participants reference the same formula, these levels often do act as real inflection points.",
  },
  relVolume: {
    term: "Relative Volume (RVOL)",
    body: "Today's trading volume compared to the recent average (e.g. 1.5x means 50% more volume than typical). High relative volume signals unusual interest — a move on strong RVOL is generally considered more reliable/durable than the same move on light volume, since more participants are voting with real size.",
  },
  volSpike: {
    term: "Volume Spike",
    body: "A sudden, sharp jump in trading volume, typically flagged when volume runs multiple times above average. Often coincides with news, an institutional block trade, or a technical breakout — it's a signal that something changed, even before you know exactly what.",
  },
  iv: {
    term: "Implied Volatility (IV)",
    body: "The market's forecast of how much a stock is likely to move, backed out from options prices (not from historical price action). Higher IV means options are pricing in bigger expected swings — often ahead of earnings or other known catalysts — and makes options more expensive on both the call and put side.",
  },
  ivRank: {
    term: "IV Rank / Percentile",
    body: "Where current implied volatility sits relative to its own recent historical range (e.g. IV Rank 80 means IV is near the high end of the past year). High IV rank is often used by options sellers as a signal that premium is \"rich\"; low IV rank suggests options are relatively cheap.",
  },
  gex: {
    term: "Gamma Exposure (GEX)",
    body: "An estimate of how much stock market makers may need to buy or sell to stay hedged as price moves, based on options positioning. Positive GEX is associated with market makers dampening volatility (buying dips, selling rips); negative GEX is associated with amplifying moves in whichever direction price is already heading. This report's GEX is an approximation from public options data, not a real dealer-position feed.",
  },
  maxPain: {
    term: "Max Pain",
    body: "The strike price at which the largest dollar value of options (calls and puts combined) would expire worthless, theoretically causing maximum financial \"pain\" to option holders. Some traders believe price gravitates toward max pain as expiration approaches, though the evidence for this is mixed — best treated as one data point, not a rule.",
  },
  putCall: {
    term: "Put/Call Ratio",
    body: "The ratio of put options to call options being traded or held (open interest). A high ratio suggests more hedging/bearish positioning; a low ratio suggests more bullish speculation. Extreme readings in either direction are sometimes used as a contrarian signal — very high put/call can mark capitulation near a bottom.",
  },
  wall: {
    term: "Call Wall / Put Wall",
    body: "The strike prices with the largest call or put open interest. These often act as magnets or barriers — heavy call open interest above price can cap rallies (as dealers who sold those calls hedge by selling stock into strength), while heavy put open interest below can act as support.",
  },
  pe: {
    term: "P/E Ratio (Price-to-Earnings)",
    body: "Share price divided by earnings per share — the most common valuation shorthand, showing how much investors are paying per dollar of current profit. A higher P/E means the market is pricing in more future growth (or the stock is simply more expensive relative to its earnings); it's most useful compared against peers or the company's own history, not in isolation.",
  },
  peg: {
    term: "PEG Ratio",
    body: "P/E divided by the expected earnings growth rate, adjusting valuation for how fast the company is actually growing. A PEG near or below 1 is the classic Peter Lynch heuristic for \"reasonably priced given growth\"; well above 2 suggests the stock may be pricing in more growth than is likely to show up.",
  },
  evEbitda: {
    term: "EV/EBITDA",
    body: "Enterprise Value (market cap plus debt, minus cash) divided by EBITDA (earnings before interest, taxes, depreciation, and amortization). Useful for comparing companies with different capital structures or tax situations, since it strips out financing and accounting choices that P/E doesn't.",
  },
  priceSales: {
    term: "Price/Sales",
    body: "Market cap divided by trailing revenue. Useful for valuing companies that aren't yet profitable (where P/E doesn't work), though it says nothing about margins — a high P/S can be justified if margins are expected to expand significantly, or be a red flag if they aren't.",
  },
  roe: {
    term: "ROE (Return on Equity)",
    body: "Net income divided by shareholder equity — how efficiently a company turns shareholders' money into profit. Consistently high ROE (without excessive debt driving it) is a hallmark of a strong, efficiently-run business, and tends to support a premium valuation over time.",
  },
  roic: {
    term: "ROIC (Return on Invested Capital)",
    body: "Operating profit after tax divided by total invested capital (debt plus equity). Considered by many investors to be the best single measure of business quality — a company earning ROIC well above its cost of capital is genuinely creating value each year, not just growing for growth's sake.",
  },
  debtEquity: {
    term: "Debt-to-Equity",
    body: "Total debt divided by shareholder equity — how much the company relies on borrowed money versus its own capital. Higher leverage amplifies returns in good times but increases risk of financial distress in downturns or when rates rise; what counts as \"high\" varies a lot by industry (utilities normally run higher than software companies).",
  },
  currentRatio: {
    term: "Current Ratio",
    body: "Current assets divided by current liabilities — a basic liquidity check on whether a company can cover its near-term obligations. Above 1.5 is generally comfortable; below 1 can signal near-term cash-flow strain, though context (industry, cash conversion cycle) matters.",
  },
  margin: {
    term: "Profit Margins (Gross / Operating / Net)",
    body: "The percentage of revenue that survives at each stage: gross margin after cost of goods sold, operating margin after operating expenses, net margin after everything including taxes and interest. Expanding margins over time often signal pricing power or operating leverage; compressing margins can signal rising competition or cost pressure.",
  },
  marginStability: {
    term: "Margin Stability (Pricing Power Proxy)",
    body: "Whether gross margin has held steady or expanded across recent quarters despite any competitive or cost pressure. It's an indirect signal — a company that can maintain margins is generally able to pass on cost increases or has some form of pricing power, which supports earnings durability.",
  },
  epsGrowth: {
    term: "EPS Growth",
    body: "The year-over-year (or quarter-over-quarter) change in earnings per share. Consistent EPS growth is one of the strongest long-term drivers of share price, since valuation multiples applied to a growing earnings base compound the effect on the stock price itself.",
  },
  revGrowth: {
    term: "Revenue Growth",
    body: "The year-over-year (or quarter-over-quarter) change in total sales. Top-line growth is the raw fuel for everything else — sustained revenue growth gives a company more room to invest, and is usually a precondition for EPS growth unless margins are expanding on their own.",
  },
  fcf: {
    term: "Free Cash Flow",
    body: "Cash generated from operations minus capital expenditures — the actual cash a business has left over after running and reinvesting in itself. Unlike accounting earnings, FCF is hard to manipulate with non-cash accounting choices, which is why many investors weight it more heavily than reported net income.",
  },
  insider: {
    term: "Insider Transactions",
    body: "Real, SEC-disclosed (Form 4) buying or selling by company executives and directors. Insider buying is generally a stronger signal than insider selling (which can happen for many routine reasons like taxes or diversification) — but a cluster of buying, especially at higher price points, suggests people with the best information think the stock is undervalued.",
  },
  analyst: {
    term: "Analyst Recommendations",
    body: "The distribution of Wall Street analyst ratings (Strong Buy through Strong Sell) covering the stock. Useful as a sentiment gauge and to see if consensus is shifting, but analyst ratings are famously sticky and tend to lag price action rather than lead it — treat as context, not a signal on its own.",
  },
  structure: {
    term: "Market Structure (Higher Highs / Higher Lows)",
    body: "The sequence of swing highs and lows on a chart. A pattern of higher highs and higher lows defines an uptrend structurally (not just by a moving average); the structure breaking — a lower low after a series of higher lows — is often the earliest technical sign a trend is changing.",
  },
  supportResistance: {
    term: "Support & Resistance",
    body: "Price levels where buying (support) or selling (resistance) has previously been strong enough to reverse or stall price. They work partly because they're self-reinforcing — traders place orders around levels they and others can see, concentrating real buying/selling interest exactly there.",
  },
  breakout: {
    term: "Breakout / Breakdown Probability",
    body: "An estimate of how likely price is to make a decisive move beyond a recent range, often informed by volatility compression (a Bollinger Band squeeze) — tight ranges tend to precede expansion, since volatility itself mean-reverts over time even though direction isn't predictable from compression alone.",
  },
  gap: {
    term: "Gap Analysis",
    body: "A gap is when price opens meaningfully above or below the prior close, leaving a visible \"hole\" on the chart, usually from overnight news or earnings. Gaps often get \"filled\" later as price retraces into the gap range — an unfilled gap can act as a magnet, while a filled one often signals the initial move has been fully absorbed.",
  },
  trend: {
    term: "Trend (Daily / Weekly / Monthly)",
    body: "The prevailing price direction over a given timeframe, typically assessed via price relative to a short moving average. Multi-timeframe alignment (e.g. daily, weekly, and monthly all pointing the same way) generally makes a trend signal more reliable than any single timeframe alone.",
  },
  pressure: {
    term: "Buying / Selling Pressure",
    body: "A composite read (often from CMF or similar) on whether buyers or sellers are more dominant intraday, based on where price closes within its daily range relative to volume. Sustained buying pressure even during flat price action can be an early accumulation signal.",
  },
  accDist: {
    term: "Accumulation / Distribution",
    body: "Whether a stock shows signs of being quietly bought up (accumulation) or sold off (distribution) by larger participants, typically inferred from volume-based indicators like OBV and CMF moving opposite to what price alone would suggest.",
  },
  guidance: {
    term: "Guidance Accuracy (EPS Beat Rate)",
    body: "How often a company's actual earnings have beaten analyst estimates in recent quarters. A high beat rate suggests management sets conservative, achievable guidance (or is genuinely executing well) — both of which markets tend to reward with less negative surprise risk.",
  },
  execution: {
    term: "Execution Consistency",
    body: "Whether a company avoids large earnings misses quarter to quarter. Consistent execution reduces the \"surprise risk\" priced into the stock — investors will often pay a premium multiple for a business they trust to hit its numbers.",
  },
  capitalAllocation: {
    term: "Capital Allocation Quality",
    body: "A rough read on whether a company is deploying its cash sensibly — positive free cash flow combined with manageable debt suggests room for buybacks, dividends, or reinvestment without straining the balance sheet. Poor capital allocation (overpriced acquisitions, excessive buybacks at high valuations) is a common way otherwise-good businesses destroy shareholder value.",
  },
  peer: {
    term: "Peer Comparison",
    body: "How a stock's valuation multiples compare to similar companies in its industry. Valuation is inherently relative — a P/E of 30 might be cheap for a software company and expensive for a utility, so peer context matters more than the raw number.",
  },
  relStrength: {
    term: "Relative Strength vs. Index",
    body: "How a stock has performed compared to a benchmark (like the S&P 500) over the same period. A stock outperforming the index during a rally — or holding up better during a decline — is showing relative strength, often seen as a sign of underlying demand independent of the broad market.",
  },
  expectedMove: {
    term: "Expected Move",
    body: "A statistical estimate (from implied volatility or ATR) of how far a stock is likely to move over a given period, expressed as a dollar range. It's a probability-based estimate, not a prediction of direction — think of it as sizing the likely range, not calling the outcome.",
  },
  weeklyRange: {
    term: "Weekly Price Range",
    body: "The estimated high/low band for the coming week, blending the options-implied move, ATR-based volatility, weekly pivot levels, and confirmation from trend/volume signals. It's a probability range, not a target — actual price can and does move outside it.",
  },
  dailyTarget: {
    term: "Daily Target Range",
    body: "A blend of pivot resistance/support and an ATR-based volatility band around the current price, giving a rough expected range for the current session.",
  },
};

// Keyword-based lookup so the same glossary works across files without every single reading
// object needing an explicit glossary key — reading names vary slightly between tabs
// ("50 SMA" vs "50-Day SMA"), so this matches on substrings instead of exact names.
export function matchGlossary(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes("stoch")) return GLOSSARY.stochRsi;
  if (n.includes("rsi")) return GLOSSARY.rsi;
  if (n.includes("macd")) return GLOSSARY.macd;
  if (n.includes("anchored vwap")) return GLOSSARY.anchoredVwap;
  if (n.includes("vwap")) return GLOSSARY.vwap;
  if (n.includes("ema")) return GLOSSARY.ema;
  if (n.includes("sma") || n.includes("moving average")) return GLOSSARY.sma;
  if (n.includes("bollinger")) return GLOSSARY.bollinger;
  if (n.includes("atr")) return GLOSSARY.atr;
  if (n.includes("fibonacci")) return GLOSSARY.fibonacci;
  if (n.includes("volume profile") || n.includes("vpvr")) return GLOSSARY.volumeProfile;
  if (n.includes("adx")) return GLOSSARY.adx;
  if (n.includes("supertrend")) return GLOSSARY.supertrend;
  if (n.includes("ichimoku")) return GLOSSARY.ichimoku;
  if (n.includes("obv")) return GLOSSARY.obv;
  if (n.includes("cmf")) return GLOSSARY.cmf;
  if (n.includes("pivot")) return GLOSSARY.pivot;
  if (n.includes("relative volume") || n === "rvol" || n.includes("volume trend")) return GLOSSARY.relVolume;
  if (n.includes("volume spike")) return GLOSSARY.volSpike;
  if (n.includes("iv rank") || n.includes("iv percentile")) return GLOSSARY.ivRank;
  if (n.includes("implied vol") || n.startsWith("iv ") || n.includes("iv (") || n === "iv") return GLOSSARY.iv;
  if (n.includes("gamma exposure") || n.includes("gex")) return GLOSSARY.gex;
  if (n.includes("max pain")) return GLOSSARY.maxPain;
  if (n.includes("put/call")) return GLOSSARY.putCall;
  if (n.includes("wall")) return GLOSSARY.wall;
  if (n.includes("peg")) return GLOSSARY.peg;
  if (n.includes("ev/ebitda")) return GLOSSARY.evEbitda;
  if (n.includes("price/sales")) return GLOSSARY.priceSales;
  if (n.includes("p/e")) return GLOSSARY.pe;
  if (n.includes("roic") || n.includes("roi ")) return GLOSSARY.roic;
  if (n.includes("roe")) return GLOSSARY.roe;
  if (n.includes("current ratio")) return GLOSSARY.currentRatio;
  if (n.includes("debt")) return GLOSSARY.debtEquity;
  if (n.includes("margin stability")) return GLOSSARY.marginStability;
  if (n.includes("margin")) return GLOSSARY.margin;
  if (n.includes("eps growth") || n.includes("eps (qoq")) return GLOSSARY.epsGrowth;
  if (n.includes("revenue")) return GLOSSARY.revGrowth;
  if (n.includes("free cash flow") || n.includes("operating cash flow")) return GLOSSARY.fcf;
  if (n.includes("insider")) return GLOSSARY.insider;
  if (n.includes("analyst") || n.includes("recommendation")) return GLOSSARY.analyst;
  if (n.includes("market structure")) return GLOSSARY.structure;
  if (n.includes("support") || n.includes("resistance") && !n.includes("wall")) return GLOSSARY.supportResistance;
  if (n.includes("breakout") || n.includes("breakdown")) return GLOSSARY.breakout;
  if (n.includes("gap")) return GLOSSARY.gap;
  if (n.includes("weekly price range")) return GLOSSARY.weeklyRange;
  if (n.includes("target")) return GLOSSARY.dailyTarget;
  if (n.includes("trend")) return GLOSSARY.trend;
  if (n.includes("pressure")) return GLOSSARY.pressure;
  if (n.includes("accumulation") || n.includes("distribution")) return GLOSSARY.accDist;
  if (n.includes("guidance")) return GLOSSARY.guidance;
  if (n.includes("execution")) return GLOSSARY.execution;
  if (n.includes("capital allocation")) return GLOSSARY.capitalAllocation;
  if (n.includes("peer")) return GLOSSARY.peer;
  if (n.includes("relative strength")) return GLOSSARY.relStrength;
  if (n.includes("expected move")) return GLOSSARY.expectedMove;
  return null;
}
