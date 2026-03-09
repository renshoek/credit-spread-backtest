// ─────────────────────────────────────────────────────────────────────────────
// data.js — Market data for Put Credit Spread Backtest Engine
//
// THREE DATA SOURCES:
//
// 1. SIMULATED (hardcoded, always available):
//      SPY[]      — Monthly adjusted closes (rounded approximations)
//      VIX_SIM[]  — CBOE VIX monthly closes (rounded approximations)
//      RFR[]      — Effective Fed Funds Rate monthly averages, FRED (DFF)
//
// 2. REAL VIX/SKEW/SPY (loaded from CSVs at runtime via loadRealData()):
//      VIX_History.csv  → VIX_REAL, VIX_MONTHLY_HIGH
//      SKEW_History.csv → SKEW_REAL
//      SPY.csv          → SPY_REAL, SPY_SETTLE, SPY_MONTHLY_LOW
//
// 3. REAL OPTIONS CHAIN (loaded from JSON via loadOptionsChain()):
//      options_chain.json → OPTIONS_CHAIN
//      Built by build_options_chain.py from OptionsDX SPY EOD files.
//      Provides real bid/ask mid prices for 2010-01 → 2023-12.
//      Replaces Black-Scholes pricing for covered months.
//      For any month not in the chain, engine falls back to Black-Scholes.
// ─────────────────────────────────────────────────────────────────────────────

const DATA_START_YEAR = 2000;
const DATA_END_YEAR   = 2024;

// ══════════════════════════════════════════════════════════════
// SIMULATED DATA (hardcoded, always available)
// ══════════════════════════════════════════════════════════════

// SPY monthly adjusted closing prices (USD)
const SPY = [
  148,140,142,136,133,129,126,131,120,115,110,110,
  108,116,112,115,118,115,115,107, 90, 95,104,103,
  104,109,107,103, 95, 92, 83, 78, 88, 84, 88, 88,
   84, 80, 82, 89, 92, 96, 98,101, 99,103,106,111,
  113,113,111,109,110,112,108,109,113,111,119,120,
  119,122,120,116,119,120,122,123,122,119,124,126,
  128,129,132,133,127,126,130,134,136,137,138,142,
  147,148,146,150,151,150,155,148,153,154,146,148,
  138,132,126,134,140,127,119,127,114, 92, 85, 89,
   83, 73, 68, 82, 91, 93,102,104,108,106,110,112,
  107,113,118,120,108,106,116,110,116,118,121,127,
  131,135,132,135,135,130,132,122,117,124,124,127,
  133,138,141,141,131,137,140,143,147,142,141,146,
  150,152,156,158,166,163,169,166,170,175,181,184,
  182,185,188,185,189,195,196,196,197,191,207,205,
  205,212,206,211,212,209,211,196,191,203,209,202,
  192,191,205,208,209,209,218,219,216,213,220,226,
  228,236,235,237,241,243,247,248,250,253,258,268,
  281,271,263,261,271,275,280,285,291,272,265,249,
  267,280,280,291,286,297,294,292,299,304,312,323,
  337,295,258,290,299,309,328,351,340,330,363,373,
  380,388,396,419,420,428,441,450,451,461,456,476,
  453,438,452,418,412,381,412,404,361,377,394,383,
  403,411,400,415,419,446,456,441,428,418,455,476,
  489,501,521,505,529,546,554,564,572,579,596,591
];

// VIX monthly closing values (rounded approximations)
const VIX_SIM = [
   24,25,26,22,22,23,23,21,25,22,25,23,
   23,22,24,20,19,22,21,33,34,36,30,22,
   21,22,22,22,24,27,31,38,37,34,28,28,
   25,24,30,21,19,18,17,17,18,16,17,16,
   15,16,16,15,15,15,14,14,13,14,13,13,
   13,12,12,13,12,12,12,12,14,15,12,11,
   12,11,11,13,13,17,14,13,11,11,10,11,
   10,11,14,13,13,17,24,30,19,18,25,23,
   22,24,25,20,17,22,22,22,30,55,50,40,
   44,44,44,36,31,26,24,25,25,27,22,21,
   19,19,17,23,32,26,22,25,21,20,21,18,
   18,18,17,15,15,16,18,32,33,29,27,23,
   19,18,14,17,21,18,16,16,16,16,16,14,
   13,15,13,13,13,17,12,14,15,13,12,13,
   14,14,14,14,12,11,12,12,15,16,13,14,
   18,14,15,12,12,14,12,25,24,16,16,18,
   22,20,14,13,14,15,12,11,14,17,13,12,
   11,12,11,10,10,11,10,10,10,10,11,11,
   14,19,20,16,13,16,12,12,12,24,23,28,
   17,14,13,13,15,15,13,16,15,14,12,14,
   18,40,53,31,27,30,23,23,26,29,24,22,
   21,28,21,18,17,16,19,16,20,16,17,17,
   24,27,22,28,25,27,22,24,31,28,21,20,
   19,18,19,15,15,14,14,16,17,18,13,13,
   13,14,12,15,12,12,15,15,16,23,13,16
];

// Fed Funds Rate monthly averages (%), FRED DFF series
const RFR = [
  5.45,5.73,5.85,6.02,6.27,6.53,6.54,6.50,6.52,6.51,6.51,6.40,
  5.98,5.49,5.31,4.80,4.21,3.97,3.77,3.65,3.07,2.49,2.09,1.82,
  1.73,1.74,1.73,1.75,1.75,1.75,1.73,1.74,1.75,1.75,1.28,1.24,
  1.24,1.26,1.25,1.26,1.24,1.22,1.01,1.03,1.01,1.01,1.00,0.98,
  1.00,1.01,1.00,1.00,1.00,1.03,1.26,1.43,1.61,1.76,1.93,2.16,
  2.28,2.50,2.63,2.79,3.00,3.04,3.26,3.50,3.62,3.78,4.00,4.16,
  4.29,4.49,4.59,4.79,4.94,4.99,5.24,5.25,5.25,5.25,5.25,5.24,
  5.25,5.26,5.26,5.25,5.25,5.25,5.26,5.02,4.94,4.76,4.49,4.24,
  3.94,2.98,2.61,2.28,1.98,2.00,2.01,2.00,1.81,0.97,0.39,0.16,
  0.15,0.22,0.18,0.15,0.18,0.21,0.16,0.16,0.15,0.12,0.12,0.12,
  0.11,0.13,0.16,0.20,0.20,0.18,0.18,0.19,0.19,0.19,0.19,0.16,
  0.17,0.16,0.14,0.10,0.09,0.09,0.07,0.10,0.08,0.07,0.08,0.07,
  0.11,0.10,0.13,0.14,0.16,0.16,0.14,0.13,0.14,0.16,0.16,0.16,
  0.14,0.15,0.14,0.15,0.11,0.09,0.09,0.08,0.08,0.09,0.08,0.09,
  0.07,0.07,0.08,0.09,0.09,0.10,0.09,0.09,0.09,0.09,0.09,0.12,
  0.11,0.11,0.11,0.12,0.12,0.13,0.13,0.14,0.14,0.12,0.12,0.24,
  0.34,0.38,0.36,0.37,0.37,0.38,0.39,0.40,0.40,0.40,0.41,0.54,
  0.65,0.66,0.79,0.90,0.91,1.04,1.15,1.16,1.15,1.15,1.16,1.30,
  1.42,1.42,1.51,1.69,1.70,1.82,1.91,1.91,1.95,2.19,2.20,2.40,
  2.40,2.40,2.41,2.42,2.39,2.38,2.40,2.13,2.04,1.83,1.55,1.55,
  1.55,1.58,0.65,0.05,0.05,0.08,0.09,0.10,0.09,0.09,0.09,0.09,
  0.09,0.08,0.07,0.07,0.06,0.08,0.10,0.09,0.08,0.08,0.08,0.08,
  0.08,0.08,0.20,0.33,0.77,1.21,1.68,2.33,2.56,3.08,3.78,4.10,
  4.33,4.57,4.65,4.83,5.06,5.08,5.12,5.33,5.33,5.33,5.33,5.33,
  5.33,5.33,5.33,5.33,5.33,5.33,5.33,5.33,5.33,4.83,4.58,4.33
];

// Legacy alias kept for backward compat
const VIX = VIX_SIM;

// ══════════════════════════════════════════════════════════════
// REAL DATA — populated asynchronously by loadRealData()
// null until loaded; backtest engine checks REAL_DATA_LOADED
// ══════════════════════════════════════════════════════════════

let VIX_REAL          = null;
let VIX_MONTHLY_HIGH  = null;
let SKEW_REAL         = null;
let SPY_REAL          = null;
let SPY_SETTLE        = null;   // adjusted close on 3rd Friday  (BS mode)
let SPY_SETTLE_ACTUAL = null;   // raw (unadjusted) close on 3rd Friday (chain mode — actual option settlement price)
let SPY_MONTHLY_LOW   = null;
let REAL_DATA_LOADED  = false;
let REAL_DATA_ERROR   = null;

// ── REAL OPTIONS CHAIN (from options_chain.json) ──
// Populated by loadOptionsChain(). When available, the backtest engine
// uses real bid/ask mid prices instead of Black-Scholes for any month
// covered. Falls back to Black-Scholes for months outside coverage.
let OPTIONS_CHAIN = null;

// Load and store the options chain JSON.
async function loadOptionsChain(path = 'options_chain.json') {
  try {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    OPTIONS_CHAIN = await resp.json();
    const n = OPTIONS_CHAIN.meta?.months ?? Object.keys(OPTIONS_CHAIN.chain).length;
    console.log(`Options chain loaded: ${n} months (${path})`);
    return { ok: true, months: n };
  } catch (err) {
    console.warn('Options chain not loaded (will use Black-Scholes):', err.message);
    return { ok: false, error: err.message };
  }
}

// Linear interpolation on the put chain for a given month and OTM%.
// Returns { mid, bid, ask, iv } or null if chain not available for that month.
//
// The puts array is sorted by strike descending (= OTM% ascending).
// We find the two real strikes that bracket the target OTM% and
// linearly interpolate between them.
function chainLookup(monthKey, otmPct) {
  if (!OPTIONS_CHAIN) return null;
  const entry = OPTIONS_CHAIN.chain[monthKey];
  if (!entry || !entry.puts || entry.puts.length === 0) return null;

  const puts = entry.puts;  // otm_pct ascending

  let lo = null, hi = null;
  for (const p of puts) {
    if (p.otm_pct <= otmPct + 0.001) lo = p;
    else { hi = p; break; }
  }

  if (!lo && !hi) return null;
  if (!hi) return { ...lo };  // target deeper than available data — use deepest
  if (!lo) return { ...hi };  // target shallower than available (edge case)

  // Exact or close match
  const range = hi.otm_pct - lo.otm_pct;
  if (range < 0.001) return { ...lo };

  const t = (otmPct - lo.otm_pct) / range;
  return {
    mid: lo.mid + t * (hi.mid - lo.mid),
    bid: lo.bid + t * (hi.bid - lo.bid),
    ask: lo.ask + t * (hi.ask - lo.ask),
    iv:  (lo.iv != null && hi.iv != null) ? lo.iv + t * (hi.iv - lo.iv) : (lo.iv ?? hi.iv ?? null),
  };
}

// ── SKEW → IV multiplier (convex / quadratic) ──
//
// Replaces the old linear formula (1 + (SKEW-100)×otm/500).
// The real vol surface is convex: deeper OTM puts cost
// disproportionately MORE than a linear skew implies.
//
// Model:  mult = 1 + ex·x + ½·ex²·x²
//   where ex = (SKEW - 100) / 100   (normalised skew steepness)
//         x  = otmPct / 5           (normalised strike distance)
//
// Calibration vs linear at SKEW=130:
//   5% OTM : 1.345  (linear: 1.30)   +3.5%
//   8% OTM : 1.595  (linear: 1.48)  +7.8%
//
// At SKEW=145 (elevated risk regime):
//   5% OTM : 1.551  (linear: 1.45)   +7%
//   8% OTM : 1.979  (linear: 1.72)  +15%
//
// Effect: the long put (protection leg) becomes meaningfully more
// expensive in high-SKEW environments, reducing net credit and
// improving accuracy vs real options market prices.
function skewToMult(otmPct, skewVal) {
  const ex = (skewVal - 100) / 100;   // normalised skew steepness
  const x  = otmPct / 5;              // normalised strike distance
  return 1 + ex * x + 0.5 * ex * ex * x * x;
}

// ══════════════════════════════════════════════════════════════
// CSV LOADER
// ══════════════════════════════════════════════════════════════

// "MM/DD/YYYY" → "YYYY-MM"  (VIX/SKEW format)
function _monthKey(dateStr) {
  const p = dateStr.trim().split('/');
  return p.length === 3 ? `${p[2]}-${p[0].padStart(2, '0')}` : null;
}

// "YYYY-MM-DD" → "YYYY-MM"  (SPY format)
function _isoMonthKey(dateStr) {
  return dateStr.trim().slice(0, 7);
}

// 3rd Friday of a given year/month as "YYYY-MM-DD"
function _thirdFriday(year, month) {
  // Find first day of month, walk to first Friday, add 2 weeks
  const d = new Date(year, month - 1, 1);
  const daysToFri = (5 - d.getDay() + 7) % 7; // getDay: Sun=0 ... Fri=5
  const first = new Date(year, month - 1, 1 + daysToFri);
  const third = new Date(first);
  third.setDate(first.getDate() + 14);
  return third.toISOString().slice(0, 10);
}

// Minimal CSV parser — returns array of {header: value} objects
function _parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      return obj;
    });
}

// Ordered list of all YYYY-MM from DATA_START_YEAR-01 to DATA_END_YEAR-12
function _buildMonthList() {
  const months = [];
  let y = DATA_START_YEAR, m = 1;
  while (y < DATA_END_YEAR || (y === DATA_END_YEAR && m <= 12)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

// ── loadRealData(vixPath, skewPath, spyPath) → Promise ──
// Fetches and parses all three CSVs.
// Populates VIX_REAL, VIX_MONTHLY_HIGH, SKEW_REAL,
//           SPY_REAL, SPY_SETTLE, SPY_MONTHLY_LOW.
// Paths default to same directory as the HTML files.
// Returns { ok: true } or { ok: false, error: string }.
async function loadRealData(
  vixPath  = 'VIX_History.csv',
  skewPath = 'SKEW_History.csv',
  spyPath  = 'SPY.csv'
) {
  try {
    const [vixResp, skewResp, spyResp] = await Promise.all([
      fetch(vixPath),
      fetch(skewPath),
      fetch(spyPath)
    ]);

    if (!vixResp.ok)  throw new Error(`${vixPath}: HTTP ${vixResp.status}`);
    if (!skewResp.ok) throw new Error(`${skewPath}: HTTP ${skewResp.status}`);
    if (!spyResp.ok)  throw new Error(`${spyPath}: HTTP ${spyResp.status}`);

    const [vixText, skewText, spyText] = await Promise.all([
      vixResp.text(),
      skewResp.text(),
      spyResp.text()
    ]);

    // ── Parse VIX ──
    const vixMonthClose = {};
    const vixMonthHigh  = {};
    for (const row of _parseCSV(vixText)) {
      const mk = _monthKey(row.DATE);
      if (!mk) continue;
      const close = parseFloat(row.CLOSE);
      const high  = parseFloat(row.HIGH);
      if (!isNaN(close)) vixMonthClose[mk] = close;
      if (!isNaN(high))  vixMonthHigh[mk]  = Math.max(vixMonthHigh[mk] || 0, high);
    }

    // ── Parse SKEW ──
    const skewMonthClose = {};
    for (const row of _parseCSV(skewText)) {
      const mk = _monthKey(row.DATE);
      if (!mk) continue;
      const val = parseFloat(row.SKEW);
      if (!isNaN(val)) skewMonthClose[mk] = val;
    }

    // ── Parse SPY ──
    // Per month: last-day adjusted close, 3rd Friday adjusted close,
    // and minimum adjusted low (= low × adj_close / close).
    // Also store raw (unadjusted) close for options settlement — options
    // expire against actual traded prices, not dividend-adjusted prices.
    const spyRows = _parseCSV(spyText);

    // Build lookup: date → row
    const spyByDate = {};
    for (const row of spyRows) {
      const close = parseFloat(row.close);
      const adj   = parseFloat(row.adjusted_close);
      const low   = parseFloat(row.low);
      if (!isNaN(close) && close > 0 && !isNaN(adj) && !isNaN(low)) {
        spyByDate[row.date.trim()] = {
          adjClose:  adj,
          rawClose:  close,                     // ← actual price, used for options settlement
          adjLow:    low * (adj / close)        // adjust the low by the same ratio
        };
      }
    }
    const spyTradingDates = new Set(Object.keys(spyByDate));

    // Group by month: last adjClose, min adjLow
    const spyMonthClose = {};   // last trading day adjClose
    const spyMonthLow   = {};   // minimum adjLow across all days
    for (const [dateStr, vals] of Object.entries(spyByDate)) {
      const mk = _isoMonthKey(dateStr);
      // Last trading day: overwrite (dates are processed in order from _parseCSV)
      spyMonthClose[mk] = vals.adjClose;
      if (spyMonthLow[mk] == null || vals.adjLow < spyMonthLow[mk]) {
        spyMonthLow[mk] = vals.adjLow;
      }
    }

    // 3rd Friday settlement — two variants:
    //   settleClose()      → adjusted close (for BS mode, internally consistent)
    //   settleCloseRaw()   → actual close   (for chain mode — options settle vs actual price)
    function settleClose(year, month) {
      const target = _thirdFriday(year, month);
      for (let delta = 0; delta <= 3; delta++) {
        const d = new Date(target);
        d.setDate(d.getDate() - delta);
        const ds = d.toISOString().slice(0, 10);
        if (spyTradingDates.has(ds)) return spyByDate[ds].adjClose;
      }
      return null;
    }
    function settleCloseRaw(year, month) {
      const target = _thirdFriday(year, month);
      for (let delta = 0; delta <= 3; delta++) {
        const d = new Date(target);
        d.setDate(d.getDate() - delta);
        const ds = d.toISOString().slice(0, 10);
        if (spyTradingDates.has(ds)) return spyByDate[ds].rawClose;
      }
      return null;
    }

    // ── Build ordered arrays ──
    const months = _buildMonthList();
    const missing = [];

    VIX_REAL          = [];
    VIX_MONTHLY_HIGH  = [];
    SKEW_REAL         = [];
    SPY_REAL          = [];
    SPY_SETTLE        = [];
    SPY_SETTLE_ACTUAL = [];
    SPY_MONTHLY_LOW   = [];

    months.forEach((mk, idx) => {
      const [y, m]     = mk.split('-').map(Number);
      const hasVix     = vixMonthClose[mk] != null;
      const hasSkew    = skewMonthClose[mk] != null;
      const hasSpy     = spyMonthClose[mk] != null;
      const settle     = settleClose(y, m);
      const settleRaw  = settleCloseRaw(y, m);

      if (!hasVix || !hasSkew) missing.push(mk + '(vix/skew)');
      if (!hasSpy || !settle)  missing.push(mk + '(spy)');

      VIX_REAL.push(hasVix  ? Math.round(vixMonthClose[mk] * 100) / 100 : (VIX_SIM[idx] || 20));
      VIX_MONTHLY_HIGH.push(hasVix ? Math.round(vixMonthHigh[mk]  * 100) / 100 : (VIX_SIM[idx] || 20));
      SKEW_REAL.push(hasSkew ? Math.round(skewMonthClose[mk] * 10) / 10 : 120);
      SPY_REAL.push(hasSpy   ? Math.round(spyMonthClose[mk] * 100) / 100 : SPY[idx]);
      SPY_SETTLE.push(settle != null           ? Math.round(settle    * 100) / 100 : SPY[idx]);
      SPY_SETTLE_ACTUAL.push(settleRaw != null ? Math.round(settleRaw * 100) / 100 : (settle != null ? Math.round(settle * 100) / 100 : SPY[idx]));
      SPY_MONTHLY_LOW.push(hasSpy ? Math.round(spyMonthLow[mk] * 100) / 100 : null);
    });

    const uniqueMissing = [...new Set(missing)];
    if (uniqueMissing.length > 0) {
      console.warn(`loadRealData: gaps filled with fallback for:`, uniqueMissing);
    }

    REAL_DATA_LOADED = true;
    REAL_DATA_ERROR  = null;
    console.log(
      `loadRealData OK — ${months.length} months` +
      ` | VIX ${Math.min(...VIX_REAL).toFixed(1)}–${Math.max(...VIX_REAL).toFixed(1)}` +
      ` | SKEW ${Math.min(...SKEW_REAL).toFixed(1)}–${Math.max(...SKEW_REAL).toFixed(1)}` +
      ` | SPY settle actual ${Math.min(...SPY_SETTLE_ACTUAL).toFixed(1)}–${Math.max(...SPY_SETTLE_ACTUAL).toFixed(1)}`
    );
    return { ok: true, missing: uniqueMissing };

  } catch (err) {
    REAL_DATA_ERROR  = err.message;
    REAL_DATA_LOADED = false;
    VIX_REAL = VIX_MONTHLY_HIGH = SKEW_REAL = null;
    SPY_REAL = SPY_SETTLE = SPY_SETTLE_ACTUAL = SPY_MONTHLY_LOW = null;
    console.error('loadRealData failed:', err.message);
    return { ok: false, error: err.message };
  }
}
