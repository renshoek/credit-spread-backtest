// ══════════════════════════════════════════════════════════════
// PUT CREDIT SPREAD — BACKTEST ENGINE (merged)
//
// Depends on: data.js (SPY, VIX, RFR, DATA_START_YEAR, DATA_END_YEAR)
//
// THIS IS A SIMULATION, NOT A REAL BACKTEST.
// Options prices are computed via Black-Scholes using VIX as IV proxy.
// Real options have actual traded prices and IV surfaces.
//
// BIAS CORRECTIONS vs earlier versions:
//   - Historical Fed Funds Rate (not fixed 4%)
//   - Slippage/commissions (default $1.50/spread)
//   - Intra-month path estimation via Brownian bridge
//     (catches mid-month breaches that month-end close hides)
//   - VIX floor + ceiling filters
//   - Stop-loss as × premium (Tastytrade standard)
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

function bsPut(S, K, r, T, sigma) {
  if (sigma < 0.001 || T < 0.0001 || S <= 0 || K <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// ── INTRA-MONTH LOW ESTIMATION ──
// Brownian bridge: probability that GBM path hit level L during [0, T]
// given we know S(0) = S0 and S(T) = S1.
// P(min < L) = exp(-2 * ln(S0/L) * ln(S1/L) / (σ² * T))
// Only valid when L < min(S0, S1).
function probBreachBB(S0, S1, L, sigma, T) {
  if (L >= Math.min(S0, S1)) return 1.0;  // already below or at level
  if (L <= 0 || sigma <= 0 || T <= 0) return 0;
  const lnS0L = Math.log(S0 / L);
  const lnS1L = Math.log(S1 / L);
  return Math.exp(-2 * lnS0L * lnS1L / (sigma * sigma * T));
}

// Estimate the effective intra-month low price.
// Uses VIX-implied vol to estimate how far SPY likely dipped mid-month,
// even if it recovered by month-end.
// Returns a price <= min(S0, S1).
function estimateIntraMonthLow(S0, S1, vixPct, dteDays) {
  // Monthly vol from VIX
  const sigma = vixPct / 100;
  const T = dteDays / 365;
  const sigmaT = sigma * Math.sqrt(T);

  // For a Brownian bridge (known start and end), the expected maximum
  // deviation below the lower endpoint is dampened vs unconstrained GBM.
  // Empirical approximation: ~0.6× the unconstrained expected max drawdown.
  // Unconstrained E[max drawdown] ≈ σ√T × √(2/π) ≈ σ√T × 0.798
  // Bridge-adjusted: × 0.6
  const dipFactor = sigmaT * 0.798 * 0.6;
  const lowEndpoint = Math.min(S0, S1);

  return lowEndpoint * (1 - dipFactor);
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
    dteDays     = 30,
    skewShort   = 1.30,
    skewLong    = 1.50,
    vixFloor    = 0,
    vixCeil     = 999,
    stopLossMult= 0,
    slippage    = 1.50,
    useHistRFR  = true,
    fixedRFR    = 4.0,
    intraMonth  = true        // estimate intra-month path breaches
  } = params;

  const longOTMf  = Math.max(longOTMp, shortOTMp + 0.5);
  const T         = dteDays / 365;
  const margFrac  = marginPct / 100;

  let cap = startCap, peak = startCap;
  const monthly = [];
  const n = Math.min(SPY.length, VIX.length, RFR.length);
  let spyWindowBase = null;
  let skippedMonths = 0;

  for (let i = 1; i < n; i++) {
    const yr = getYear(i);
    if (yr < startYear || yr > endYear) continue;

    const S0  = SPY[i - 1];
    const S1  = SPY[i];
    const vixRaw = VIX[i - 1];

    if (spyWindowBase === null) spyWindowBase = S0;

    const date = getLabel(i);
    const year = String(yr);

    // VIX filter — skip month if outside comfort zone
    if (vixRaw < vixFloor || vixRaw > vixCeil) {
      skippedMonths++;
      const spyBnH = startCap * (S1 / spyWindowBase);
      monthly.push({
        date, year, S0, S1, vix: vixRaw,
        skipped: true,
        retPct: 0, retCapPct: 0, dollarPnl: 0,
        cap: +cap.toFixed(2), spyBnH: +spyBnH.toFixed(2),
        dd: peak > 0 ? +((cap - peak) / peak * 100).toFixed(2) : 0,
        win: false, scenario: 'skipped',
        rfr: 0, breachProb: 0, sLow: 0
      });
      continue;
    }

    // Risk-free rate
    const r = useHistRFR ? (RFR[i - 1] / 100) : (fixedRFR / 100);

    // Skew-adjusted implied volatilities
    const sigmaS = Math.max((vixRaw / 100) * skewShort, 0.05);
    const sigmaL = Math.max((vixRaw / 100) * skewLong,  0.05);

    // Strike prices
    const K1 = S0 * (1 - shortOTMp / 100);   // short put
    const K2 = S0 * (1 - longOTMf / 100);    // long put

    // Option prices per share (Black-Scholes)
    const shortPrem = bsPut(S0, K1, r, T, sigmaS);
    const longPrem  = bsPut(S0, K2, r, T, sigmaL);

    // Net premium after slippage
    const rawNetPrem = Math.max(shortPrem - longPrem, 0);
    const netPrem    = Math.max(rawNetPrem - (slippage / 100), 0);
    const margPerSh  = Math.max((K1 - K2) - netPrem, 0.01);

    // ── INTRA-MONTH PATH ESTIMATION ──
    // Options settle at expiry (≈ month-end), so S1 determines the outcome.
    // However, mid-month dips matter for stop-loss triggering: if the spread
    // went deep ITM mid-month, the trader would have closed at the stop level.
    // We estimate the probable intra-month low using VIX-implied volatility.
    let breachProb = 0;
    let sLow = S1;

    if (intraMonth) {
      sLow = estimateIntraMonthLow(S0, S1, vixRaw, dteDays);

      // Probability that short strike was breached mid-month (Brownian bridge)
      if (K1 < Math.min(S0, S1)) {
        breachProb = probBreachBB(S0, S1, K1, vixRaw / 100, T);
      } else if (S1 < K1) {
        breachProb = 1.0;
      }
    }

    // ── P&L CALCULATION ──
    // Outcome is based on month-end close (S1) — this is when the option settles.
    let rawPnlSh;
    if      (S1 >= K1) rawPnlSh =  netPrem;
    else if (S1 <= K2) rawPnlSh = -margPerSh;
    else               rawPnlSh =  netPrem - (K1 - S1);

    // ── STOP-LOSS ──
    // If enabled, check whether the stop was triggered.
    // With intra-month estimation: use estimated low to determine if the
    // spread went deep enough ITM mid-month to trigger the stop, even if
    // the month-end close recovered.
    // Without intra-month: only triggers if month-end loss exceeds stop.
    let pnlSh = rawPnlSh;
    let stopped = false;
    if (stopLossMult > 0) {
      const stopLevel = -netPrem * stopLossMult;

      if (intraMonth && sLow < K1) {
        // Estimate the worst-case P&L at the intra-month low
        let worstPnl;
        if      (sLow <= K2) worstPnl = -margPerSh;
        else                 worstPnl = netPrem - (K1 - sLow);

        // If the intra-month worst would have triggered the stop, apply it
        // regardless of where the month ended
        if (worstPnl < stopLevel) {
          pnlSh = stopLevel;
          stopped = true;
        }
      }
      // Also check if the month-end loss itself exceeds the stop
      if (!stopped && rawPnlSh < stopLevel) {
        pnlSh = stopLevel;
        stopped = true;
      }
    }

    const retOnMargin = pnlSh / margPerSh;
    const dollarPnl   = retOnMargin * Math.abs(cap) * margFrac;

    cap += dollarPnl;
    if (cap > peak) peak = cap;

    const dd        = peak > 0 ? ((cap - peak) / peak) * 100 : 0;
    const spyBnH    = startCap * (S1 / spyWindowBase);
    const retPct    = retOnMargin * 100;
    const retCapPct = retOnMargin * margFrac * 100;

    let scenario = S1 >= K1 ? 'win' : S1 <= K2 ? 'full_loss' : 'partial';
    if (stopped) scenario = 'stopped';

    monthly.push({
      date, year, S0, S1, vix: vixRaw,
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
      win:        dollarPnl >= 0,
      skipped:    false,
      scenario,
      rfr:        +(r * 100).toFixed(2),
      breachProb: +breachProb.toFixed(2),
      sLow:       +sLow.toFixed(1)
    });
  }

  if (monthly.length === 0) return null;

  // ── Annual aggregation ──
  const annMap = {};
  monthly.forEach(m => {
    if (!annMap[m.year]) annMap[m.year] = { months: [], traded: [], wins: 0, fullLoss: 0 };
    annMap[m.year].months.push(m);
    if (!m.skipped) {
      annMap[m.year].traded.push(m);
      if (m.win) annMap[m.year].wins++;
      if (m.scenario === 'full_loss') annMap[m.year].fullLoss++;
    }
  });

  const annual = Object.entries(annMap).map(([yr, { months, traded, wins, fullLoss }]) => {
    const cs  = months[0].cap - months[0].dollarPnl;
    const ce  = months[months.length - 1].cap;
    const pnl = ce - cs;
    const ret = cs !== 0 ? +(pnl / Math.abs(cs) * 100).toFixed(1) : 0;
    const wr  = traded.length ? +(wins / traded.length * 100).toFixed(0) : 0;
    return { year: yr, retPct: ret, wins, losses: traded.length - wins,
             fullLoss, winRate: wr, pnl: +pnl.toFixed(0), traded: traded.length };
  });

  const traded  = monthly.filter(m => !m.skipped);
  const wins    = traded.filter(m => m.win);
  const losses  = traded.filter(m => !m.win);
  const yrs     = monthly.length / 12;
  const spyEnd  = monthly[monthly.length - 1].spyBnH;

  const cagr    = cap > 0 && startCap > 0
    ? +((Math.pow(cap / startCap, 1 / yrs) - 1) * 100).toFixed(1) : null;
  const spyCagr = +((Math.pow(spyEnd / startCap, 1 / yrs) - 1) * 100).toFixed(1);

  const avgPremPct = traded.length
    ? +(traded.reduce((s, m) => s + m.premiumPct, 0) / traded.length).toFixed(1) : 0;

  return { monthly, annual,
    stats: {
      n: monthly.length, traded: traded.length, skipped: skippedMonths,
      wins: wins.length, losses: losses.length,
      winRate:    +(wins.length / Math.max(traded.length, 1) * 100).toFixed(1),
      cagr, spyCagr,
      totalReturn:+(((cap - startCap) / startCap) * 100).toFixed(1),
      maxDD:      +(Math.min(...monthly.map(m => m.dd))).toFixed(1),
      avgWin:      wins.length   ? +(wins.reduce((s, m) => s + m.retPct, 0) / wins.length).toFixed(1)   : 0,
      avgLoss:     losses.length ? +(losses.reduce((s, m) => s + m.retPct, 0) / losses.length).toFixed(1) : 0,
      bestMonth:  traded.length ? +(Math.max(...traded.map(m => m.retPct))).toFixed(1) : 0,
      worstMonth: traded.length ? +(Math.min(...traded.map(m => m.retPct))).toFixed(1) : 0,
      avgPremPct,
      fullLossMonths: traded.filter(m => m.scenario === 'full_loss').length,
      stoppedMonths:  traded.filter(m => m.scenario === 'stopped').length,
      finalCap: +cap.toFixed(0), startCap
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
  const g = id => parseFloat(document.getElementById(id).value);
  const gi = id => parseInt(document.getElementById(id).value);
  const rfrMode = document.getElementById('rfrMode').value;
  return {
    shortOTMp:    g('shortOTM'),
    longOTMp:     g('longOTM'),
    marginPct:    g('marginPct'),
    dteDays:      g('dte'),
    skewShort:    g('skewShort'),
    skewLong:     g('skewLong'),
    vixFloor:     g('vixFloor'),
    vixCeil:      g('vixCeil'),
    stopLossMult: g('stopLoss'),
    slippage:     g('slippage'),
    useHistRFR:   rfrMode === 'hist',
    fixedRFR:     g('rfr'),
    intraMonth:   document.getElementById('intraMonth').checked,
    startYear:    gi('startYear'),
    endYear:      gi('endYear'),
    startCap:     g('capital')
  };
}

// ── STATS ──
function renderStats(s) {
  const grid = document.getElementById('statsGrid');
  const cagrVal = s.cagr !== null ? fmt(s.cagr) : 'N/A';
  const cagrCls = s.cagr !== null && s.cagr > s.spyCagr ? 'green' : 'accent';
  const tradeInfo = s.skipped > 0
    ? `${s.traded} traded · ${s.skipped} skipped`
    : `${s.traded} months traded`;

  const cards = [
    { label: 'Strategy CAGR',       value: cagrVal,                  sub: `SPY B&H: ${fmt(s.spyCagr)}`,                cls: cagrCls },
    { label: 'Win Rate',             value: `${s.winRate}%`,          sub: `${s.wins}W · ${s.losses}L`,                cls: 'accent' },
    { label: 'Max Drawdown',         value: `${s.maxDD}%`,            sub: 'from equity peak',                          cls: 'red' },
    { label: 'Total Return',         value: fmt(s.totalReturn, 0),    sub: `${fmtE(s.startCap)} → ${fmtE(s.finalCap)}`,cls: s.totalReturn > 0 ? 'green' : 'red' },
    { label: 'Avg Premium / Margin', value: `+${s.avgPremPct}%`,     sub: 'net credit ÷ margin',                       cls: 'green' },
    { label: 'Avg Loss Month',       value: `${s.avgLoss}%`,          sub: 'on margin deployed',                        cls: 'red' },
    { label: 'Full Loss Months',     value: String(s.fullLossMonths), sub: 'SPY through both strikes',                  cls: 'red' },
    { label: 'Stopped Out',          value: String(s.stoppedMonths),  sub: tradeInfo,                                   cls: 'muted2' },
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
    if (m.scenario === 'skipped')   return 'rgba(90,95,122,0.4)';
    if (m.scenario === 'win')       return 'rgba(29,218,122,0.75)';
    if (m.scenario === 'full_loss') return 'rgba(255,69,96,0.9)';
    if (m.scenario === 'stopped')   return 'rgba(255,69,96,0.55)';
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
          if (m.scenario === 'skipped') return `  SKIPPED — VIX: ${m.vix}`;
          const lbl = { win: 'WIN', full_loss: 'FULL LOSS', partial: 'PARTIAL', stopped: 'STOPPED OUT' }[m.scenario] || m.scenario;
          const lines = [
            `  ${lbl}: ${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(2)}% on margin`,
            `  Capital P&L: ${fmtER(m.dollarPnl)}  (${m.retCapPct >= 0 ? '+' : ''}${m.retCapPct.toFixed(2)}% on capital)`,
            `  SPY: ${m.S0}→${m.S1} (${fmt((m.S1 - m.S0) / m.S0 * 100, 1)})`,
            `  VIX: ${m.vix}  |  RFR: ${m.rfr}%`
          ];
          if (m.breachProb > 0.01) {
            lines.push(`  Est. low: ${m.sLow}  |  Breach prob: ${(m.breachProb * 100).toFixed(0)}%`);
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
  document.getElementById('startYear').value = START_YEAR;
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

  // Toggle fixed RFR visibility
  const rfrCtrl = document.getElementById('rfrCtrl');
  if (rfrCtrl) rfrCtrl.style.display = p.useHistRFR ? 'none' : '';

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

// ── RFR MODE TOGGLE ──
document.getElementById('rfrMode').addEventListener('change', () => {
  const rfrCtrl = document.getElementById('rfrCtrl');
  if (rfrCtrl) rfrCtrl.style.display = document.getElementById('rfrMode').value === 'hist' ? 'none' : '';
});

// ── INIT ──
populateYears();
// Hide fixed RFR on load (historical is default)
const initRfrCtrl = document.getElementById('rfrCtrl');
if (initRfrCtrl) initRfrCtrl.style.display = 'none';
run();
