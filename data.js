// ─────────────────────────────────────────────────────────────────────────────
// data.js — Market data for Put Credit Spread Backtest Engine
//
// TWO DATA SOURCES:
//
// SIMULATED (hardcoded, always available):
//   SPY  — Monthly adjusted closes, Yahoo Finance / CRSP (approximated)
//   VIX_SIM — CBOE VIX monthly closes (rounded approximations)
//   RFR  — Effective Federal Funds Rate monthly averages, FRED (DFF)
//
// REAL (loaded from CSV files at runtime via loadRealData()):
//   VIX_History.csv  → VIX_REAL (monthly close) + VIX_MONTHLY_HIGH (monthly max HIGH)
//   SKEW_History.csv → SKEW_REAL (monthly close)
//
//   Expected CSV formats (CBOE standard downloads):
//     VIX_History.csv:  DATE,OPEN,HIGH,LOW,CLOSE  (daily rows, DATE = MM/DD/YYYY)
//     SKEW_History.csv: DATE,SKEW                 (daily rows, DATE = MM/DD/YYYY)
//
//   Call loadRealData() once on page load. It returns a Promise and populates
//   VIX_REAL, VIX_MONTHLY_HIGH, SKEW_REAL once resolved.
//
// SKEW → Dynamic skew multiplier:
//   skewToMult(otmPct, skewVal) = 1 + (skewVal - 100) × otmPct / 500
//   SKEW=130, 5% OTM → ×1.30 | SKEW=130, 8% OTM → ×1.48
//
// REMAINING LIMITATIONS (both sources):
//   Monthly SPY closes only — no daily OHLC for SPY.
//   Premiums via Black-Scholes — not real options chain data.
//   Real options data: OptionsDX.com (~$100/yr for SPY).
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

let VIX_REAL         = null;  // monthly VIX close (last trading day of each month)
let VIX_MONTHLY_HIGH = null;  // highest daily VIX HIGH reached within each month
let SKEW_REAL        = null;  // monthly SKEW index close
let REAL_DATA_LOADED = false;
let REAL_DATA_ERROR  = null;

// ── SKEW → IV multiplier ──
function skewToMult(otmPct, skewVal) {
  return 1 + (skewVal - 100) * otmPct / 500;
}

// ══════════════════════════════════════════════════════════════
// CSV LOADER
// ══════════════════════════════════════════════════════════════

// "MM/DD/YYYY" → "YYYY-MM"
function _monthKey(dateStr) {
  const p = dateStr.trim().split('/');
  return p.length === 3 ? `${p[2]}-${p[0].padStart(2, '0')}` : null;
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

// ── loadRealData(vixPath, skewPath) → Promise ──
// Fetches and parses both CSVs, populates VIX_REAL / VIX_MONTHLY_HIGH / SKEW_REAL.
// Paths default to same directory as the HTML files.
// Returns { ok: true } or { ok: false, error: string }.
async function loadRealData(
  vixPath  = 'VIX_History.csv',
  skewPath = 'SKEW_History.csv'
) {
  try {
    const [vixResp, skewResp] = await Promise.all([
      fetch(vixPath),
      fetch(skewPath)
    ]);

    if (!vixResp.ok)  throw new Error(`${vixPath}: HTTP ${vixResp.status}`);
    if (!skewResp.ok) throw new Error(`${skewPath}: HTTP ${skewResp.status}`);

    const [vixText, skewText] = await Promise.all([
      vixResp.text(),
      skewResp.text()
    ]);

    // ── Parse VIX ──
    // Iterate all daily rows; last row seen per month = month-end close.
    // Track running max of daily HIGHs per month.
    const vixMonthClose = {};
    const vixMonthHigh  = {};

    for (const row of _parseCSV(vixText)) {
      const mk = _monthKey(row.DATE);
      if (!mk) continue;
      const close = parseFloat(row.CLOSE);
      const high  = parseFloat(row.HIGH);
      if (!isNaN(close)) vixMonthClose[mk] = close;             // last day wins
      if (!isNaN(high))  vixMonthHigh[mk]  = Math.max(vixMonthHigh[mk] || 0, high);
    }

    // ── Parse SKEW ──
    const skewMonthClose = {};

    for (const row of _parseCSV(skewText)) {
      const mk = _monthKey(row.DATE);
      if (!mk) continue;
      const val = parseFloat(row.SKEW);
      if (!isNaN(val)) skewMonthClose[mk] = val;                // last day wins
    }

    // ── Build ordered arrays ──
    const months = _buildMonthList();
    const missing = [];

    VIX_REAL         = [];
    VIX_MONTHLY_HIGH = [];
    SKEW_REAL        = [];

    months.forEach((mk, idx) => {
      const hasVix  = vixMonthClose[mk] != null;
      const hasSkew = skewMonthClose[mk] != null;

      if (!hasVix || !hasSkew) {
        missing.push(mk);
        // Fallback to simulated so engine never crashes
        VIX_REAL.push(VIX_SIM[idx] || 20);
        VIX_MONTHLY_HIGH.push(VIX_SIM[idx] || 20);
        SKEW_REAL.push(120);
      } else {
        VIX_REAL.push(Math.round(vixMonthClose[mk] * 100) / 100);
        VIX_MONTHLY_HIGH.push(Math.round(vixMonthHigh[mk] * 100) / 100);
        SKEW_REAL.push(Math.round(skewMonthClose[mk] * 10) / 10);
      }
    });

    if (missing.length > 0) {
      console.warn(`loadRealData: ${missing.length} month(s) missing — fell back to simulated:`, missing);
    }

    REAL_DATA_LOADED = true;
    REAL_DATA_ERROR  = null;
    console.log(
      `loadRealData OK — ${months.length} months` +
      ` | VIX ${Math.min(...VIX_REAL).toFixed(1)}–${Math.max(...VIX_REAL).toFixed(1)}` +
      ` | SKEW ${Math.min(...SKEW_REAL).toFixed(1)}–${Math.max(...SKEW_REAL).toFixed(1)}`
    );
    return { ok: true, missing };

  } catch (err) {
    REAL_DATA_ERROR  = err.message;
    REAL_DATA_LOADED = false;
    VIX_REAL = VIX_MONTHLY_HIGH = SKEW_REAL = null;
    console.error('loadRealData failed:', err.message);
    return { ok: false, error: err.message };
  }
}
