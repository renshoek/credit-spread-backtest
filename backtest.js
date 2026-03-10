// ══════════════════════════════════════════════════════════════
// PUT CREDIT SPREAD — BACKTEST ENGINE
//
// Depends on: data.js (SPY, VIX_SIM, VIX_REAL, VIX_MONTHLY_HIGH,
//                      SKEW_REAL, RFR, skewToMult)
//
// DATA SOURCES:
//   'real' — Real CBOE VIX + SKEW index data. Skew multipliers
//             are derived dynamically per month from SKEW index.
//             Intra-month estimation uses actual monthly VIX highs.
//
//   'sim'  — Simulated/approximated VIX. User sets static skew
//             multiplier inputs. Classic mode.
//
// REMAINING LIMITATIONS (both modes):
//   - SPY uses monthly closes (no daily OHLC)
//   - Premiums via Black-Scholes (not real options chain data)
//   - Real premiums available at OptionsDX.com (~$100/yr)
// ══════════════════════════════════════════════════════════════

const START_YEAR = DATA_START_YEAR;
const END_YEAR   = DATA_END_YEAR;

// ── HELPERS ──
function getLabel(i) {
  const tot = START_YEAR * 12 + i;
  return `${Math.floor(tot / 12)}-${String((tot % 12) + 1).padStart(2, '0')}`;
}
function getYear(i) { return Math.floor((START_YEAR * 12 + i) / 12); }

function fmt(v, d = 1)  { return (v >= 0 ? '+' : '') + v.toFixed(d) + '%'; }
function fmtE(v)        { const a = Math.abs(v); return (v < 0 ? '-' : '') + '€' + (a >= 10000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(0)); }
function fmtER(v)       { return (v < 0 ? '-' : '') + '€' + Math.abs(v).toFixed(0); }

// ── MATH ──
function normCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1, ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax))));
}

// Standard Black-Scholes put price (log-normal)
function bsPutBS(S, K, r, T, sigma) {
  if (sigma < 0.001 || T < 0.0001 || S <= 0 || K <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// ── FAT-TAIL PUT PRICING (jump-diffusion mixture) ──
//
// Real equity returns have fatter tails than log-normal. Black-Scholes
// alone UNDERPRICES deep OTM puts — particularly the long (protection) leg.
// This overstates the net credit in calm markets and understates the cost
// of the protection during stress periods.
//
// Model: mixture of two log-normal components
//   P = (1 - ε) · BS(σ)  +  ε · BS(σ · κ)
//
//   ε = 0.04  — 4% weight on the "jump" regime (≈1 in 25 months)
//   κ = 4.0   — jump vol = 4× base vol (represents a 2008/2020-style month)
//
// Effect:
//   • Short put (5% OTM): price rises ~6–10% — slightly more premium collected
//   • Long put  (8% OTM): price rises ~15–30% — more expensive protection
//   • Net credit: reduced, with the long put leg bearing more of the cost
//   • Most impactful in low-to-mid VIX (12–22) where jump risk is most mispriced
//
// Calibration: ε=0.04 ≈ 12 "crash months" across 25 years (2000–2024), which
// roughly matches SPY's historical frequency of 4%+ single-month drawdowns.
function bsPut(S, K, r, T, sigma,
               jumpEps = 0.04,   // weight on jump component
               jumpMult = 4.0) { // jump vol = jumpMult × base vol
  const base = bsPutBS(S, K, r, T, sigma);
  const jump = bsPutBS(S, K, r, T, sigma * jumpMult);
  return (1 - jumpEps) * base + jumpEps * jump;
}

// ── INTRA-MONTH LOW ESTIMATION ──
// Brownian bridge: probability that GBM path hit level L during [0, T]
function probBreachBB(S0, S1, L, sigma, T) {
  if (L >= Math.min(S0, S1)) return 1.0;
  if (L <= 0 || sigma <= 0 || T <= 0) return 0;
  const lnS0L = Math.log(S0 / L);
  const lnS1L = Math.log(S1 / L);
  return Math.exp(-2 * lnS0L * lnS1L / (sigma * sigma * T));
}

// Estimate intra-month low. Uses vixForPath which is:
//   Real mode:  actual max VIX daily high during the month (better than month-end)
//   Sim mode:   month-end VIX (approximation)
function estimateIntraMonthLow(S0, S1, vixForPath, dteDays) {
  const sigma = vixForPath / 100;
  const T = dteDays / 365;
  const sigmaT = sigma * Math.sqrt(T);
  const dipFactor = sigmaT * 0.798 * 0.6;
  return Math.min(S0, S1) * (1 - dipFactor);
}

// ─────────────────────────────────────────────────────────────
// BACKTEST ENGINE
// ─────────────────────────────────────────────────────────────
function runBacktest(params) {
  const {
    shortOTMp,
    longOTMp,
    startCap,
    marginPct,
    startYear,
    endYear,
    dteDays      = 30,
    skewShort    = 1.30,   // used only in sim mode
    skewLong     = 1.50,   // used only in sim mode
    vixFloor     = 0,
    vixCeil      = 999,
    stopLossType   = 'none',
    stopLossVal    = 0,
    exitStrategy   = 'expiry',  // 'expiry' | 'dte21' | 'dte21_or_50pct'
    smaFilter      = false,
    smaDays        = 200,
    slippage       = 1.50,
    useHistRFR     = true,
    fixedRFR       = 4.0,
    intraMonth     = true,
    dataSource     = 'real'  // 'real' | 'sim'
  } = params;

  const useReal    = dataSource === 'real';
  const longOTMf   = Math.max(longOTMp, shortOTMp + 0.5);
  const T          = dteDays / 365;
  const margFrac   = marginPct / 100;

  let cap = startCap, peak = startCap;
  const monthly = [];
  const n = Math.min(SPY.length, VIX_SIM.length, VIX_REAL.length, RFR.length);
  let spyWindowBase = null;
  let skippedMonths = 0;

  // Whether real SPY daily data is available
  const useRealSPY = useReal && SPY_REAL && SPY_SETTLE && SPY_MONTHLY_LOW;

  // S0 (display/path reference) still uses adjusted prices throughout for B&H consistency
  // S1 for P&L uses actual prices when chain is active (see inner loop)

  for (let i = 1; i < n; i++) {
    const yr = getYear(i);
    if (yr < startYear || yr > endYear) continue;

    // ── SPY prices ──
    // S0 = prior month-end adjusted close.
    // Used for: B&H benchmark tracking, intra-month path estimation (Brownian bridge), display.
    // NOT used for strike placement when chain is active (S0chain is used instead).
    const S0 = useRealSPY ? SPY_REAL[i - 1] : SPY[i - 1];
    // S1 for B&H: always adjusted, declared after chain/BS determination below.

    // ── VIX for pricing (month-end close at entry) ──
    const vixRaw = useReal ? VIX_REAL[i - 1] : VIX_SIM[i - 1];

    // ── VIX for intra-month path estimation ──
    // Real mode: use actual peak VIX during the trade month
    // Sim mode: use same month-end VIX
    const vixForPath = (useReal && intraMonth) ? VIX_MONTHLY_HIGH[i] : vixRaw;

    if (spyWindowBase === null) spyWindowBase = S0;

    const date = getLabel(i);
    const year = String(yr);

    // S0_adj used for B&H benchmark (adjusted close, consistent full-period comparison)
    const S0_adj = S0;
    const S1_adj = useRealSPY ? SPY_SETTLE[i] : SPY[i];

    // ── Chain key (needed for SMA entry date lookup) ──
    const chainKey   = getLabel(i - 1);
    const chainEntry = (useReal && OPTIONS_CHAIN) ? chainLookup(chainKey, shortOTMp) : null;
    const useChain   = chainEntry !== null;

    // ── SMA filter ──
    // Skip month if SPY entry price is below its N-day moving average.
    // Entry date: chain mode uses actual first trading day; otherwise use prior month-end.
    let smaVal = null;
    if (smaFilter && smaDays > 0 && SPY_DAILY_SORTED) {
      const entryDate = (useChain && OPTIONS_CHAIN?.chain[chainKey]?.entry_date)
        ? OPTIONS_CHAIN.chain[chainKey].entry_date
        : (SPY_ENTRY_DATE ? SPY_ENTRY_DATE[i - 1] : null);
      if (entryDate) smaVal = computeSMA(entryDate, smaDays);
    }
    const entryPrice = useChain
      ? (OPTIONS_CHAIN?.chain[chainKey]?.underlying ?? S0)
      : S0;
    const smaBlocked = smaFilter && smaVal !== null && entryPrice < smaVal;

    // VIX filter
    if (vixRaw < vixFloor || vixRaw > vixCeil || smaBlocked) {
      skippedMonths++;
      const spyBnH = startCap * (S1_adj / spyWindowBase);
      monthly.push({
        date, year, S0, S1: S1_adj, vix: +vixRaw.toFixed(2),
        skipped: true,
        retPct: 0, retCapPct: 0, dollarPnl: 0,
        cap: +cap.toFixed(2), spyBnH: +spyBnH.toFixed(2),
        dd: peak > 0 ? +((cap - peak) / peak * 100).toFixed(2) : 0,
        win: false, scenario: 'skipped',
        rfr: 0, breachProb: 0, sLow: 0,
        skewVal: useReal ? +(SKEW_REAL[i - 1]).toFixed(1) : null,
        skewMultShort: null, skewMultLong: null,
        smaVal: smaVal !== null ? +smaVal.toFixed(2) : null,
        smaBlocked
      });
      continue;
    }

    // Risk-free rate
    const r = useHistRFR ? (RFR[i - 1] / 100) : (fixedRFR / 100);

    // [chainKey/useChain moved up — see before SMA block]

    // ── S1: settlement price ──
    // Chain mode: use actual (unadjusted) close — options settle vs actual market price.
    //   The chain underlying is also actual price, so strikes and settlement are consistent.
    // BS/sim mode: adjusted close — S0 is also adjusted, so relative move is correct.
    const S1 = useChain
      ? (SPY_SETTLE_ACTUAL ? SPY_SETTLE_ACTUAL[i] : (useRealSPY ? SPY_SETTLE[i] : SPY[i]))
      : (useRealSPY ? SPY_SETTLE[i] : SPY[i]);

    // ── S0: underlying price at entry ──
    // Chain mode:   actual SPY price on first trading day of entry month (from chain file)
    // Real mode:    last adjusted close of prior month (SPY_REAL)
    // Sim mode:     prior month close from hardcoded array
    const chainUnderlying = useChain ? OPTIONS_CHAIN.chain[chainKey].underlying : null;
    const S0chain = chainUnderlying ?? (useRealSPY ? SPY_REAL[i - 1] : SPY[i - 1]);

    // Strike prices — always derived from entry underlying
    const K1 = S0chain * (1 - shortOTMp / 100);
    const K2 = S0chain * (1 - longOTMf  / 100);

    // ── Option pricing ──
    // Chain mode:   real bid/ask mid interpolated from OptionsDX data. No BS needed.
    // Fallback:     Black-Scholes with CBOE VIX + SKEW-derived IV (real mode)
    //               or static skew multipliers (sim mode).
    let sigmaS, sigmaL, skewMultShortVal, skewMultLongVal, skewVal;
    let shortPrem, longPrem, pricingMode;

    if (useChain) {
      // ── REAL OPTIONS CHAIN PRICING — entry snapshot ──
      const shortLookup = chainLookup(chainKey, shortOTMp, 'entry');
      const longLookup  = chainLookup(chainKey, longOTMf,  'entry');

      shortPrem      = shortLookup ? shortLookup.mid : 0;
      longPrem       = longLookup  ? longLookup.mid  : 0;
      pricingMode    = 'chain';

      sigmaS         = shortLookup?.iv ?? null;
      sigmaL         = longLookup?.iv  ?? null;
      skewVal        = useReal ? +(SKEW_REAL[i - 1]).toFixed(1) : null;
      skewMultShortVal = sigmaS && vixRaw > 0 ? sigmaS / (vixRaw / 100) : null;
      skewMultLongVal  = sigmaL && vixRaw > 0 ? sigmaL / (vixRaw / 100) : null;

    } else {
      // ── BLACK-SCHOLES FALLBACK ──
      if (useReal) {
        skewVal          = SKEW_REAL[i - 1];
        skewMultShortVal = Math.max(skewToMult(shortOTMp, skewVal), 1.0);
        skewMultLongVal  = Math.max(skewToMult(longOTMf,  skewVal), 1.0);
        sigmaS           = Math.max((vixRaw / 100) * skewMultShortVal, 0.05);
        sigmaL           = Math.max((vixRaw / 100) * skewMultLongVal,  0.05);
      } else {
        skewVal          = null;
        skewMultShortVal = skewShort;
        skewMultLongVal  = skewLong;
        sigmaS           = Math.max((vixRaw / 100) * skewShort, 0.05);
        sigmaL           = Math.max((vixRaw / 100) * skewLong,  0.05);
      }
      shortPrem   = bsPut(S0chain, K1, r, dteDays / 365, sigmaS);
      longPrem    = bsPut(S0chain, K2, r, dteDays / 365, sigmaL);
      pricingMode = 'bs';
    }

    const rawNetPrem = Math.max(shortPrem - longPrem, 0);
    const netPrem    = Math.max(rawNetPrem - (slippage / 100), 0);
    const margPerSh  = Math.max((K1 - K2) - netPrem, 0.01);

    // ── Intra-month path ──
    // Real SPY mode: use actual minimum daily low observed during the month.
    //   breachProb is binary — the low either went below K1 or it didn't.
    // Intra-month path estimation uses S0 (adjusted, ≈ entry frame) and S1 (settlement)
    let breachProb = 0;
    let sLow = S1;
    let actualPath = false;

    if (useRealSPY && SPY_MONTHLY_LOW[i] != null) {
      // Actual observed low over full trade window:
      //   entry month (i-1): covers from ~entry date through month end
      //   settlement month (i): covers from start through ~3rd Friday
      // Taking min of both captures crashes that happened in either half.
      const lowSettle = SPY_MONTHLY_LOW[i];
      const lowEntry  = (SPY_MONTHLY_LOW[i - 1] != null) ? SPY_MONTHLY_LOW[i - 1] : lowSettle;
      sLow       = Math.min(lowEntry, lowSettle);
      actualPath = true;
      breachProb = sLow < K1 ? 1.0 : 0.0;
    } else if (intraMonth) {
      // Estimated via Brownian bridge
      sLow = estimateIntraMonthLow(S0, S1, vixForPath, dteDays);
      if (K1 < Math.min(S0, S1)) {
        breachProb = probBreachBB(S0, S1, K1, vixForPath / 100, T);
      } else if (S1 < K1) {
        breachProb = 1.0;
      }
    }

    // ── P&L — uses S1 (actual price when chain, adjusted otherwise) ──
    let rawPnlSh;
    if      (S1 >= K1) rawPnlSh =  netPrem;
    else if (S1 <= K2) rawPnlSh = -margPerSh;
    else               rawPnlSh =  netPrem - (K1 - S1);

    // ── Stop-loss ──
    // Three modes:
    //   credit_mult : close when loss ≥ N× net premium collected  (e.g. 2× = tastytrade)
    //   margin_pct  : close when loss ≥ N% of margin per share     (e.g. 50%)
    //   dollar      : close when loss ≥ $N per contract (÷100 → per share)
    // Triggered by: actual intra-month low (real SPY) or Brownian bridge estimate (sim).
    let pnlSh = rawPnlSh;
    let stopped = false;
    const hasStop = stopLossType !== 'none' && stopLossVal > 0;
    if (hasStop) {
      let stopLevel;
      if      (stopLossType === 'credit_mult') stopLevel = -netPrem   * stopLossVal;
      else if (stopLossType === 'margin_pct')  stopLevel = -margPerSh * (stopLossVal / 100);
      else if (stopLossType === 'dollar')      stopLevel = -(stopLossVal / 100);
      else stopLevel = -Infinity;
      const checkPath = actualPath || intraMonth;

      if (checkPath && sLow < K1) {
        let worstPnl;
        if (sLow <= K2) worstPnl = -margPerSh;
        else            worstPnl = netPrem - (K1 - sLow);

        if (worstPnl < stopLevel) {
          pnlSh = stopLevel;
          stopped = true;
        }
      }
      if (!stopped && rawPnlSh < stopLevel) {
        pnlSh = stopLevel;
        stopped = true;
      }
    }

    // ── Early exit (21 DTE or 50% profit) ──
    // Uses real mid prices from chain mid snapshot (~21–24 DTE remaining).
    // Falls back to hold-to-expiry if mid data unavailable.
    let profitTaken = false;
    let exitedAt21  = false;

    if (!stopped && useChain && exitStrategy !== 'expiry') {
      const chainMonth  = OPTIONS_CHAIN?.chain[chainKey];
      const hasMid      = chainMonth?.mid_date != null;

      if (hasMid) {
        // Mid prices: what the spread is worth at ~21 DTE
        const midShort = chainLookup(chainKey, shortOTMp, 'mid');
        const midLong  = chainLookup(chainKey, longOTMf,  'mid');

        if (midShort && midLong) {
          // Current spread cost to close at mid date (we pay this to close)
          const midCostToClose = Math.max(midShort.mid - midLong.mid, 0);
          // P&L if we close at mid: premium collected minus cost to close, minus extra slippage
          const midPnl = netPrem - midCostToClose - (slippage / 100);

          const hit50pct = midCostToClose <= netPrem * 0.50;

          if (exitStrategy === 'dte21') {
            // Always close at 21 DTE — use real mid price
            pnlSh       = midPnl;
            exitedAt21  = true;
            profitTaken = midPnl > 0;
          } else if (exitStrategy === 'dte21_or_50pct') {
            // Close at 50% profit if hit, otherwise close at 21 DTE
            if (hit50pct) {
              pnlSh       = netPrem * 0.50 - (slippage / 100);
              profitTaken = true;
            } else {
              pnlSh       = midPnl;
              exitedAt21  = true;
              profitTaken = midPnl > 0;
            }
          }
        }
      }
      // If no mid data: fall through to hold-to-expiry (pnlSh unchanged)
    }

    const retOnMargin = pnlSh / margPerSh;
    const dollarPnl   = retOnMargin * Math.abs(cap) * margFrac;

    cap += dollarPnl;
    if (cap > peak) peak = cap;

    const dd        = peak > 0 ? ((cap - peak) / peak) * 100 : 0;
    const spyBnH    = startCap * (S1_adj / spyWindowBase);   // B&H always on adjusted prices
    const retPct    = retOnMargin * 100;
    const retCapPct = retOnMargin * margFrac * 100;

    let scenario = S1 >= K1 ? 'win' : S1 <= K2 ? 'full_loss' : 'partial';
    if (stopped)                  scenario = 'stopped';
    if (exitedAt21 && !stopped)   scenario = profitTaken ? 'profit_taken' : 'exited_21';
    if (profitTaken && !exitedAt21 && !stopped) scenario = 'profit_taken';

    const win = scenario === 'win' || scenario === 'profit_taken' || scenario === 'exited_21';
    const profitable = dollarPnl >= 0;

    monthly.push({
      date, year, S0, S1, vix: +vixRaw.toFixed(2),
      vixHigh: useReal ? +(vixForPath).toFixed(2) : null,
      K1: +K1.toFixed(2), K2: +K2.toFixed(2),
      netPrem:    +netPrem.toFixed(3),
      margPerSh:  +margPerSh.toFixed(3),
      premiumPct: +(netPrem / margPerSh * 100).toFixed(1),
      retPct:     +retPct.toFixed(2),
      retCapPct:  +retCapPct.toFixed(3),
      dollarPnl:  +dollarPnl.toFixed(2),
      cap:        +cap.toFixed(2),
      spyBnH:     +spyBnH.toFixed(2),
      dd:         +dd.toFixed(2),
      win,
      profitable,
      skipped:    false,
      scenario,
      rfr:        +(r * 100).toFixed(2),
      breachProb: +breachProb.toFixed(2),
      sLow:       +sLow.toFixed(1),
      actualPath,
      skewVal:    skewVal !== null ? +skewVal.toFixed(1) : null,
      skewMultShort: skewMultShortVal != null ? +skewMultShortVal.toFixed(3) : null,
      skewMultLong:  skewMultLongVal  != null ? +skewMultLongVal.toFixed(3)  : null,
      pricingMode,
      chainKey,
      profitTaken,
      exitedAt21,
      smaVal: smaVal !== null ? +smaVal.toFixed(2) : null,
      smaBlocked: false
    });
  }

  if (monthly.length === 0) return null;

  // ── Annual aggregation ──
  const annMap = {};
  monthly.forEach(m => {
    if (!annMap[m.year]) annMap[m.year] = { months: [], traded: [], wins: 0, profitable: 0, fullLoss: 0 };
    annMap[m.year].months.push(m);
    if (!m.skipped) {
      annMap[m.year].traded.push(m);
      if (m.win)        annMap[m.year].wins++;
      if (m.profitable) annMap[m.year].profitable++;
      if (m.scenario === 'full_loss') annMap[m.year].fullLoss++;
    }
  });

  const annual = Object.entries(annMap).map(([yr, { months, traded, wins, profitable, fullLoss }]) => {
    const cs  = months[0].cap - months[0].dollarPnl;
    const ce  = months[months.length - 1].cap;
    const pnl = ce - cs;
    const ret = cs !== 0 ? +(pnl / Math.abs(cs) * 100).toFixed(1) : 0;
    const wr  = traded.length ? +(wins / traded.length * 100).toFixed(0) : 0;
    return { year: yr, retPct: ret, wins, losses: traded.length - wins,
             profitable, fullLoss, winRate: wr, pnl: +pnl.toFixed(0), traded: traded.length };
  });

  const traded         = monthly.filter(m => !m.skipped);
  const wins           = traded.filter(m => m.win);           // expired worthless
  const profitable     = traded.filter(m => m.profitable);    // any positive P&L
  const losses         = traded.filter(m => !m.profitable);   // negative P&L
  const yrs            = monthly.length / 12;
  const spyEnd         = monthly[monthly.length - 1].spyBnH;

  const cagr    = cap > 0 && startCap > 0
    ? +((Math.pow(cap / startCap, 1 / yrs) - 1) * 100).toFixed(1) : null;
  const spyCagr = +((Math.pow(spyEnd / startCap, 1 / yrs) - 1) * 100).toFixed(1);
  const spyTotalReturn = +(((spyEnd - startCap) / startCap) * 100).toFixed(1);

  const avgPremPct = traded.length
    ? +(traded.reduce((s, m) => s + m.premiumPct, 0) / traded.length).toFixed(1) : 0;

  // Average SKEW for the period (real mode only)
  const avgSKEW = (useReal && traded.length)
    ? +(traded.filter(m => m.skewVal).reduce((s, m) => s + m.skewVal, 0) / traded.filter(m => m.skewVal).length).toFixed(1)
    : null;
  const avgSkewMultShort = (useReal && traded.length)
    ? +(traded.reduce((s, m) => s + (m.skewMultShort || 0), 0) / traded.length).toFixed(2)
    : null;

  return { monthly, annual,
    stats: {
      n: monthly.length, traded: traded.length, skipped: skippedMonths,
      wins: wins.length,
      profitableMonths: profitable.length,
      losses: losses.length,
      winRate:          +(wins.length      / Math.max(traded.length, 1) * 100).toFixed(1),
      profitableRate:   +(profitable.length / Math.max(traded.length, 1) * 100).toFixed(1),
      cagr, spyCagr, spyTotalReturn,
      totalReturn:+(((cap - startCap) / startCap) * 100).toFixed(1),
      maxDD:      +(Math.min(...monthly.map(m => m.dd))).toFixed(1),
      avgWin:      wins.length   ? +(wins.reduce((s, m) => s + m.retPct, 0) / wins.length).toFixed(1)   : 0,
      avgLoss:     losses.length ? +(losses.reduce((s, m) => s + m.retPct, 0) / losses.length).toFixed(1) : 0,
      bestMonth:  traded.length ? +(Math.max(...traded.map(m => m.retPct))).toFixed(1) : 0,
      worstMonth: traded.length ? +(Math.min(...traded.map(m => m.retPct))).toFixed(1) : 0,
      avgPremPct,
      fullLossMonths: traded.filter(m => m.scenario === 'full_loss').length,
      stoppedMonths:  traded.filter(m => m.scenario === 'stopped').length,
      chainMonths:    traded.filter(m => m.pricingMode === 'chain').length,
      profitTakenMonths: traded.filter(m => m.profitTaken && !m.exitedAt21).length,
      exited21Months:    traded.filter(m => m.exitedAt21).length,
      smaSkipped:        monthly.filter(m => m.smaBlocked).length,
      finalCap: +cap.toFixed(0), startCap,
      dataSource, avgSKEW, avgSkewMultShort
    }
  };
}

// ── WALK-FORWARD ──
function runWalkForward(p, wfYears) {
  const windows = [];
  for (let y = p.startYear; y + wfYears - 1 <= p.endYear; y += wfYears) {
    const wEnd = Math.min(y + wfYears - 1, p.endYear);
    const r = runBacktest({ ...p, startYear: y, endYear: wEnd });
    if (r) windows.push({ from: y, to: wEnd, ...r.stats });
  }
  return windows;
}

// ─────────────────────────────────────────────────
// CHART / UI
// ─────────────────────────────────────────────────
Chart.defaults.color = '#3d4160';
Chart.defaults.font.family = "'IBM Plex Mono', monospace";
Chart.defaults.font.size = 9;

let charts = {}, lastResult = null;

function destroyAll() { Object.values(charts).forEach(c => c && c.destroy()); charts = {}; }
function gridOpts()   { return { color: 'rgba(28,31,53,0.8)', drawBorder: false }; }
function tickOpts()   { return { maxRotation: 0, color: '#3d4160' }; }
const ttBase = { backgroundColor: '#111325', borderColor: '#1c1f35', borderWidth: 1, titleColor: '#3d4160', bodyColor: '#b8bdd4', padding: 10 };

// ── COLLECT PARAMS ──
function getParams() {
  const g  = id => parseFloat(document.getElementById(id).value);
  const gi = id => parseInt(document.getElementById(id).value);
  const rfrMode    = document.getElementById('rfrMode').value;
  const dataSource = document.getElementById('dataSource').value;
  return {
    shortOTMp:    g('shortOTM'),
    longOTMp:     g('longOTM'),
    marginPct:    g('marginPct'),
    dteDays:      g('dte'),
    skewShort:    g('skewShort'),
    skewLong:     g('skewLong'),
    vixFloor:     g('vixFloor'),
    vixCeil:      g('vixCeil'),
    stopLossType:  document.getElementById('stopLossType').value,
    stopLossVal:   g('stopLossVal') || 0,
    exitStrategy:  document.getElementById('exitStrategy').value,
    smaFilter:     document.getElementById('smaFilter').checked,
    smaDays:       parseInt(document.getElementById('smaDays').value) || 200,
    slippage:     g('slippage'),
    useHistRFR:   rfrMode === 'hist',
    fixedRFR:     g('rfr'),
    intraMonth:   document.getElementById('intraMonth').checked,
    startYear:    gi('startYear'),
    endYear:      gi('endYear'),
    startCap:     g('capital'),
    dataSource
  };
}

// ── UPDATE SKEW CONTROL STATE ──
function updateSkewControls() {
  const isReal = document.getElementById('dataSource').value === 'real';
  // Only the two skew multiplier inputs are replaced in real mode.
  // Slippage, stop-loss, VIX floor/ceiling are independent of data source.
  ['skewShort', 'skewLong'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = isReal;
    el.closest('.ctrl').style.opacity = isReal ? '0.35' : '1';
  });
  const skewNote = document.getElementById('skewNote');
  if (skewNote) skewNote.style.display = isReal ? 'flex' : 'none';
}

// ── STATS ──
function renderStats(s) {
  const grid = document.getElementById('statsGrid');
  const cagrVal = s.cagr !== null ? fmt(s.cagr) : 'N/A';
  const cagrCls = s.cagr !== null && s.cagr > s.spyCagr ? 'green' : 'accent';
  const tradeInfo = s.skipped > 0
    ? `${s.traded} traded · ${s.skipped} skipped`
    : `${s.traded} months traded`;

  const skewInfo = s.dataSource === 'real' && s.avgSKEW
    ? `avg SKEW ${s.avgSKEW} → ×${s.avgSkewMultShort}`
    : `static ×${document.getElementById('skewShort').value}`;

  const cards = [
    { label: 'Strategy CAGR',       value: cagrVal,                  sub: `SPY B&H: ${fmt(s.spyCagr)}`,            cls: cagrCls },
    { label: 'Win Rate', value: `${s.winRate}%`,
      sub: (() => {
        const parts = [`${s.wins} wins`];
        if (s.profitTakenMonths > 0) parts.push(`${s.profitTakenMonths} profit-taken`);
        if (s.exited21Months > 0)    parts.push(`${s.exited21Months} closed@21DTE`);
        parts.push(`${s.profitableRate}% profitable`);
        return parts.join(' · ');
      })(),
      cls: 'accent' },
    { label: 'Max Drawdown',         value: `${s.maxDD}%`,            sub: 'from equity peak',                      cls: 'red' },
    { label: 'Total Return',         value: fmt(s.totalReturn, 0),    sub: `${fmtE(s.startCap)} → ${fmtE(s.finalCap)} · SPY ${fmt(s.spyTotalReturn,0)}`, cls: s.totalReturn > 0 ? 'green' : 'red' },
    { label: 'Avg Premium / Margin', value: `+${s.avgPremPct}%`,      sub: 'net credit ÷ margin',                   cls: 'green' },
    { label: 'Avg Loss Month',       value: `${s.avgLoss}%`,          sub: 'on margin deployed',                    cls: 'red' },
    { label: 'Full Loss Months',     value: String(s.fullLossMonths), sub: 'SPY through both strikes',              cls: 'red' },
    { label: 'Pricing / Exit',
      value: s.chainMonths > 0 ? `${s.chainMonths}mo chain` : (s.dataSource === 'real' ? 'Real BS' : 'Sim BS'),
      sub: [
        s.chainMonths > 0 && (s.traded - s.chainMonths) > 0 ? `${s.traded - s.chainMonths}mo Black-Scholes` : '',
        s.smaSkipped > 0       ? `${s.smaSkipped} SMA-filtered` : '',
        s.profitTakenMonths > 0 ? `${s.profitTakenMonths} profit-taken` : '',
        s.exited21Months > 0    ? `${s.exited21Months} closed@21DTE` : '',
      ].filter(Boolean).join(' · ') || 'chain data · hold to expiry',
      cls: s.chainMonths > 0 ? 'green' : (s.dataSource === 'real' ? 'blue' : 'muted2') },
  ];
  grid.innerHTML = cards.map((c, i) => `
    <div class="stat-card" style="animation-delay:${i * 0.025}s">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
    </div>`).join('');
}

function renderEquity(monthly) {
  const ctx = document.getElementById('chartEquity').getContext('2d');
  const showSPY = document.getElementById('spyToggle').checked;
  const ds = [{
    label: 'Strategy', data: monthly.map(m => m.cap),
    borderColor: '#f0a500', backgroundColor: 'rgba(240,165,0,0.06)',
    borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3
  }];
  if (showSPY) ds.push({
    label: 'SPY B&H', data: monthly.map(m => m.spyBnH),
    borderColor: '#4fa3e8', borderWidth: 1.5, borderDash: [6, 3],
    pointRadius: 0, fill: false, tension: 0.3
  });
  charts.equity = new Chart(ctx, {
    type: 'line',
    data: { labels: monthly.map(m => m.date), datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 600 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#5a5f7a', boxWidth: 14, font: { size: 9 } } },
        tooltip: { ...ttBase, callbacks: { label: c => `  ${c.dataset.label}: ${fmtER(c.parsed.y)}` } }
      },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 10 } },
        y: { grid: gridOpts(), ticks: { ...tickOpts(), callback: v => (v < 0 ? '-' : '') + '€' + Math.abs(Math.round(v / 1000)) + 'k' } }
      }
    }
  });
}

function renderMonthly(monthly) {
  const ctx = document.getElementById('chartMonthly').getContext('2d');
  const colorOf = m => {
    if (m.scenario === 'skipped')      return 'rgba(90,95,122,0.4)';
    if (m.scenario === 'win')          return 'rgba(29,218,122,0.75)';
    if (m.scenario === 'profit_taken') return 'rgba(29,218,122,0.45)';
    if (m.scenario === 'exited_21')    return 'rgba(29,218,122,0.30)';
    if (m.scenario === 'full_loss')    return 'rgba(255,69,96,0.9)';
    if (m.scenario === 'stopped')      return 'rgba(255,69,96,0.55)';
    return 'rgba(255,150,50,0.8)';
  };
  charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: monthly.map(m => m.date),
      datasets: [{ label: 'Return %', data: monthly.map(m => m.retPct),
        backgroundColor: monthly.map(colorOf), borderWidth: 0, borderRadius: 1 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...ttBase, callbacks: { label: (c) => {
          const m = monthly[c.dataIndex];
          if (m.scenario === 'skipped') return m.smaBlocked ? `  SKIPPED — SMA filter (SPY ${m.S0} < SMA${m.smaVal})` : `  SKIPPED — VIX: ${m.vix}`;
          const lbl = { win: 'WIN', profit_taken: 'PROFIT TAKEN', exited_21: 'CLOSED 21 DTE', full_loss: 'FULL LOSS', partial: 'PARTIAL', stopped: 'STOPPED OUT' }[m.scenario] || m.scenario;
          const lines = [
            `  ${lbl}: ${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(2)}% on margin`,
            `  Capital P&L: ${fmtER(m.dollarPnl)}  (${m.retCapPct >= 0 ? '+' : ''}${m.retCapPct.toFixed(2)}% on capital)`,
            `  SPY: ${m.S0}→${m.S1} (${fmt((m.S1 - m.S0) / m.S0 * 100, 1)})`,
            `  VIX: ${m.vix}${m.vixHigh ? '  peak: ' + m.vixHigh : ''}  |  RFR: ${m.rfr}%`
          ];
          if (m.skewVal) lines.push(`  SKEW: ${m.skewVal} → ×${m.skewMultShort} / ×${m.skewMultLong}`);
          if (m.breachProb > 0.01) {
            const lowLabel = m.actualPath ? 'Actual low' : 'Est. low';
            const bpLabel  = m.actualPath ? (m.breachProb === 1.0 ? 'BREACHED' : 'not breached') : `Breach prob: ${(m.breachProb * 100).toFixed(0)}%`;
            lines.push(`  ${lowLabel}: ${m.sLow}  |  ${bpLabel}`);
          }
          return lines;
        }}}
      },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 12 } },
        y: { grid: gridOpts(), ticks: { ...tickOpts(), callback: v => v + '%' },
          afterDataLimits: a => { a.max = Math.max(a.max, 10); a.min = Math.min(a.min, -110); } }
      }
    }
  });
}

function renderAnnual(annual) {
  const ctx = document.getElementById('chartAnnual').getContext('2d');
  charts.annual = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: annual.map(a => a.year),
      datasets: [{ label: 'Annual Return %', data: annual.map(a => a.retPct),
        backgroundColor: annual.map(a => a.retPct >= 0 ? 'rgba(29,218,122,0.8)' : 'rgba(255,69,96,0.8)'),
        borderRadius: 3, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...ttBase, callbacks: { label: c => [
          `  Return: ${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(1)}%`,
          `  P&L: ${fmtER(annual[c.dataIndex].pnl)}  ·  ${annual[c.dataIndex].traded} traded`,
          `  Win rate: ${annual[c.dataIndex].winRate}% (${annual[c.dataIndex].wins}W·${annual[c.dataIndex].losses}L)`
        ]}}
      },
      scales: {
        x: { grid: gridOpts(), ticks: tickOpts() },
        y: { grid: gridOpts(), ticks: { ...tickOpts(), callback: v => v + '%' } }
      }
    }
  });
}

function renderAnnualGrid(annual) {
  document.getElementById('annualGrid').innerHTML = annual.map(a => `
    <div class="annual-cell">
      <div class="annual-year">${a.year}</div>
      <div class="annual-ret" style="color:${a.retPct >= 0 ? 'var(--green)' : 'var(--red)'}">
        ${a.retPct >= 0 ? '+' : ''}${a.retPct}%
      </div>
      <div class="annual-wr">${a.winRate}% W</div>
    </div>`).join('');
}

function renderDrawdown(monthly) {
  const ctx = document.getElementById('chartDrawdown').getContext('2d');
  charts.drawdown = new Chart(ctx, {
    type: 'line',
    data: {
      labels: monthly.map(m => m.date),
      datasets: [{ label: 'Drawdown from peak', data: monthly.map(m => m.dd),
        borderColor: 'rgba(255,69,96,0.9)', backgroundColor: 'rgba(255,69,96,0.07)',
        borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false },
        tooltip: { ...ttBase, callbacks: { label: c => `  Drawdown: ${c.parsed.y.toFixed(2)}%` } }
      },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 10 } },
        y: { grid: gridOpts(), ticks: { ...tickOpts(), callback: v => v + '%' } }
      }
    }
  });
}

function renderWalkForward(windows) {
  const tbody = document.getElementById('wfBody');
  if (!windows || !windows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No data</td></tr>';
    return;
  }
  tbody.innerHTML = windows.map(w => {
    const rc = w.cagr !== null && w.cagr >= 0 ? 'green' : 'red';
    const tc = w.totalReturn >= 0 ? 'green' : 'red';
    return `<tr>
      <td>${w.from}–${w.to}</td>
      <td class="${rc}">${w.cagr !== null ? fmt(w.cagr) : 'N/A'}</td>
      <td class="${tc}">${fmt(w.totalReturn, 0)}</td>
      <td>${w.winRate}%</td>
      <td>${w.avgPremPct}%</td>
      <td>${w.fullLossMonths}</td>
      <td class="red">${w.maxDD}%</td>
      <td class="muted">${fmt(w.spyCagr)}</td>
    </tr>`;
  }).join('');
}

// ── YEAR DROPDOWNS ──
function populateYears() {
  ['startYear', 'endYear'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    for (let y = START_YEAR; y <= END_YEAR; y++)
      el.innerHTML += `<option value="${y}">${y}</option>`;
  });
  document.getElementById('startYear').value = Math.max(START_YEAR, 2010);
  document.getElementById('endYear').value   = END_YEAR;
}

// ── MAIN RUN ──
function run() {
  const p = getParams();
  if (p.startYear >= p.endYear) {
    document.getElementById('statsGrid').innerHTML =
      '<div style="color:var(--red);font-family:var(--font-mono);font-size:11px;padding:12px">Start year must be before end year.</div>';
    return;
  }

  const rfrCtrl = document.getElementById('rfrCtrl');
  if (rfrCtrl) rfrCtrl.style.display = p.useHistRFR ? 'none' : '';

  updateSkewControls();
  updateDataBadge(p.dataSource);

  const result = runBacktest(p);
  if (!result) return;
  lastResult = result;

  const { monthly, annual, stats } = result;
  renderStats(stats);
  destroyAll();
  renderEquity(monthly);
  renderMonthly(monthly);
  renderAnnual(annual);
  renderAnnualGrid(annual);
  renderDrawdown(monthly);

  const wfYears = parseInt(document.getElementById('wfYears').value) || 3;
  renderWalkForward(runWalkForward(p, wfYears));
}

// ── UPDATE DATA SOURCE BADGE ──
function updateDataBadge(source) {
  const badge = document.getElementById('dataBadge');
  if (!badge) return;
  if (source === 'real') {
    badge.textContent = '● Real CBOE Data';
    badge.className = 'data-badge real';
  } else {
    badge.textContent = '○ Simulated Data';
    badge.className = 'data-badge sim';
  }
}

// ── TABS ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + tab).classList.add('active');
    document.getElementById('spyToggleWrap').style.display = tab === 'equity' ? 'flex' : 'none';
    setTimeout(() => Object.values(charts).forEach(c => c && c.resize()), 10);
  });
});

document.getElementById('spyToggle').addEventListener('change', () => {
  if (!lastResult) return;
  if (charts.equity) charts.equity.destroy();
  renderEquity(lastResult.monthly);
});

document.getElementById('rfrMode').addEventListener('change', () => {
  const rfrCtrl = document.getElementById('rfrCtrl');
  if (rfrCtrl) rfrCtrl.style.display = document.getElementById('rfrMode').value === 'hist' ? 'none' : '';
});

document.getElementById('dataSource').addEventListener('change', () => {
  updateSkewControls();
});

// ── OPEN TRADE LOG ──
function openTradeLog() {
  const p = getParams();
  const q = new URLSearchParams({
    shortOTM:   p.shortOTMp,
    longOTM:    p.longOTMp,
    dte:        p.dteDays,
    capital:    p.startCap,
    marginPct:  p.marginPct,
    skewShort:  p.skewShort,
    skewLong:   p.skewLong,
    vixFloor:   p.vixFloor,
    vixCeil:    p.vixCeil,
    stopLossType:  p.stopLossType,
    stopLossVal:   p.stopLossVal,
    exitStrategy:  p.exitStrategy,
    smaFilter:     p.smaFilter ? '1' : '0',
    smaDays:       p.smaDays,
    slippage:   p.slippage,
    rfrMode:    p.useHistRFR ? 'hist' : 'fixed',
    rfr:        p.fixedRFR,
    intraMonth: p.intraMonth ? '1' : '0',
    startYear:  p.startYear,
    endYear:    p.endYear,
    dataSource: p.dataSource,
  });
  window.location.href = 'tradelog.html?' + q.toString();
}

// ── INIT ──
populateYears();
const initRfrCtrl = document.getElementById('rfrCtrl');
if (initRfrCtrl) initRfrCtrl.style.display = 'none';
updateSkewControls();
updateDataBadge('real');
// Don't call run() here — both index.html and tradelog.html call run()
// from their async init blocks after data has actually loaded.
