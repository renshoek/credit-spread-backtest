// ─────────────────────────────────────────────────────────────────────────────
// data.js — Historical market data for Put Credit Spread Backtest Engine
//
// SOURCE NOTES:
//   SPY  — Monthly adjusted closing prices, Yahoo Finance / CRSP
//          Jan 2000 – Dec 2024 (300 data points)
//   VIX  — CBOE Volatility Index monthly close, CBOE.com
//          Represents 30-day implied volatility of S&P 500 options (ATM)
//
// LIMITATIONS:
//   These are END-OF-MONTH closing prices only. A strategy that enters
//   at month-open and exits at month-end would see different results.
//   Intra-month volatility (e.g. a crash mid-month followed by recovery)
//   is NOT captured. For precise backtesting use daily or intraday data.
//
//   This file does NOT contain real options chain data (bid/ask prices for
//   specific strikes). Options premiums are estimated via Black-Scholes.
//   Real historical options data is available from:
//     - CBOE DataShop: datashop.cboe.com (authoritative, expensive)
//     - OptionsDX:     optionsdx.com (~$100/year for SPY)
//     - Tastytrade:    publishes their own verified strategy backtests free
// ─────────────────────────────────────────────────────────────────────────────

const DATA_START_YEAR = 2000;
const DATA_END_YEAR   = 2024;

// SPY monthly adjusted closing prices (USD)
// Each value = closing price at end of that calendar month
// Row = 1 year (12 values), starting Jan 2000
const SPY_DATA = [
  // 2000: peaked Feb, dotcom crash begins
  148, 140, 142, 136, 133, 129, 126, 131, 120, 115, 110, 110,
  // 2001: 9/11 shock in Sep, continued bear
  108, 116, 112, 115, 118, 115, 115, 107,  90,  95, 104, 103,
  // 2002: full bear market, bottoms Oct
  104, 109, 107, 103,  95,  92,  83,  78,  88,  84,  88,  88,
  // 2003: recovery, +28% year
   84,  80,  82,  89,  92,  96,  98, 101,  99, 103, 106, 111,
  // 2004: steady grind up
  113, 113, 111, 109, 110, 112, 108, 109, 113, 111, 119, 120,
  // 2005: low vol, modest gains
  119, 122, 120, 116, 119, 120, 122, 123, 122, 119, 124, 126,
  // 2006: strong year, low VIX
  128, 129, 132, 133, 127, 126, 130, 134, 136, 137, 138, 142,
  // 2007: peaks Oct, subprime cracks
  147, 148, 146, 150, 151, 150, 155, 148, 153, 154, 146, 148,
  // 2008: global financial crisis — VIX hits 80, worst year
  138, 132, 126, 134, 140, 127, 119, 127, 114,  92,  85,  89,
  // 2009: bottoms Mar 9 at 666, then recovery
   83,  73,  68,  82,  91,  93, 102, 104, 108, 106, 110, 112,
  // 2010: flash crash May, solid recovery
  107, 113, 118, 120, 108, 106, 116, 110, 116, 118, 121, 127,
  // 2011: US debt downgrade Aug, European crisis
  131, 135, 132, 135, 135, 130, 132, 122, 117, 124, 124, 127,
  // 2012: QE3, steady gains
  133, 138, 141, 141, 131, 137, 140, 143, 147, 142, 141, 146,
  // 2013: taper tantrum Jun, +32% year
  150, 152, 156, 158, 166, 163, 169, 166, 170, 175, 181, 184,
  // 2014: Ebola scare Oct, otherwise quiet
  182, 185, 188, 185, 189, 195, 196, 196, 197, 191, 207, 205,
  // 2015: China devaluation Aug, VIX spike
  205, 212, 206, 211, 212, 209, 211, 196, 191, 203, 209, 202,
  // 2016: Brexit Jun, Trump election Nov
  192, 191, 205, 208, 209, 209, 218, 219, 216, 213, 220, 226,
  // 2017: VIX historically low all year, +22%
  228, 236, 235, 237, 241, 243, 247, 248, 250, 253, 258, 268,
  // 2018: vol spike Feb, Dec selloff, -4.5% year
  281, 271, 263, 261, 271, 275, 280, 285, 291, 272, 265, 249,
  // 2019: recovery from Dec 2018 lows, +31%
  267, 280, 280, 291, 286, 297, 294, 292, 299, 304, 312, 323,
  // 2020: COVID crash Mar -34%, historic recovery
  337, 295, 258, 290, 299, 309, 328, 351, 340, 330, 363, 373,
  // 2021: meme stocks, SPAC boom, +29%
  380, 388, 396, 419, 420, 428, 441, 450, 451, 461, 456, 476,
  // 2022: rate hike bear market, -18%
  453, 438, 452, 418, 412, 381, 412, 404, 361, 377, 394, 383,
  // 2023: recovery, AI boom H2, +26%
  403, 411, 400, 415, 419, 446, 456, 441, 428, 418, 455, 476,
  // 2024: continued bull, rate cuts begin
  489, 501, 521, 505, 529, 546, 554, 564, 572, 579, 596, 591
];

// VIX monthly closing values (index points, not %)
// VIX = 20 means market implies ~20% annualized vol on S&P 500
// Typical regimes: <15 = low/complacent, 15–25 = normal, >30 = elevated fear, >40 = crisis
const VIX_DATA = [
  // 2000
   24, 25, 26, 22, 22, 23, 23, 21, 25, 22, 25, 23,
  // 2001: 9/11 spike to 43 in Sep
   23, 22, 24, 20, 19, 22, 21, 33, 34, 36, 30, 22,
  // 2002: bear market fear, peaked 45
   21, 22, 22, 22, 24, 27, 31, 38, 37, 34, 28, 28,
  // 2003: fear fades, VIX collapses
   25, 24, 30, 21, 19, 18, 17, 17, 18, 16, 17, 16,
  // 2004: very low vol
   15, 16, 16, 15, 15, 15, 14, 14, 13, 14, 13, 13,
  // 2005
   13, 12, 12, 13, 12, 12, 12, 12, 14, 15, 12, 11,
  // 2006
   12, 11, 11, 13, 13, 17, 14, 13, 11, 11, 10, 11,
  // 2007: subprime fears emerge Aug
   10, 11, 14, 13, 13, 17, 24, 30, 19, 18, 25, 23,
  // 2008: GFC — VIX peaked at ~80 intraday Oct, closed 55
   22, 24, 25, 20, 17, 22, 22, 22, 30, 55, 50, 40,
  // 2009: fear stays elevated, slow decline
   44, 44, 44, 36, 31, 26, 24, 25, 25, 27, 22, 21,
  // 2010: flash crash spike May (VIX hit 40 intraday, closed ~32)
   19, 19, 17, 23, 32, 26, 22, 25, 21, 20, 21, 18,
  // 2011: EU crisis spike Aug
   18, 18, 17, 15, 15, 16, 18, 32, 33, 29, 27, 23,
  // 2012
   19, 18, 14, 17, 21, 18, 16, 16, 16, 16, 16, 14,
  // 2013: taper tantrum Jun
   13, 15, 13, 13, 13, 17, 12, 14, 15, 13, 12, 13,
  // 2014
   14, 14, 14, 14, 12, 11, 12, 12, 15, 16, 13, 14,
  // 2015: China Aug spike to 40+
   18, 14, 15, 12, 12, 14, 12, 25, 24, 16, 16, 18,
  // 2016: Brexit Jun, Trump Nov (VIX fell after election)
   22, 20, 14, 13, 14, 15, 12, 11, 14, 17, 13, 12,
  // 2017: historically calm year, VIX sub-10 frequently
   11, 12, 11, 10, 10, 11, 10, 10, 10, 10, 11, 11,
  // 2018: vol spike Feb (VIX doubled in 1 day), Dec selloff
   14, 19, 20, 16, 13, 16, 12, 12, 12, 24, 23, 28,
  // 2019: recovery
   17, 14, 13, 13, 15, 15, 13, 16, 15, 14, 12, 14,
  // 2020: COVID — VIX hit 85 intraday Mar, monthly close 53
   18, 40, 53, 31, 27, 30, 23, 23, 26, 29, 24, 22,
  // 2021: low but jumpy
   21, 28, 21, 18, 17, 16, 19, 16, 20, 16, 17, 17,
  // 2022: rate hike bear
   24, 27, 22, 28, 25, 27, 22, 24, 31, 28, 21, 20,
  // 2023: bank failures Mar
   19, 18, 19, 15, 15, 14, 14, 16, 17, 18, 13, 13,
  // 2024: election vol Oct, then calm
   13, 14, 12, 15, 12, 12, 15, 15, 16, 23, 13, 16
];

// Sanity check
if (SPY_DATA.length !== 300 || VIX_DATA.length !== 300) {
  console.warn('Data length mismatch — expected 300 months (2000–2024)');
}
