// ══════════════════════════════════════════════════════════════
// PUT CREDIT SPREAD — BACKTEST ENGINE v2
//
// Depends on: data.js (SPY, VIX, RFR, DATA_START_YEAR, DATA_END_YEAR)
//
// WHAT THIS IS:
//   A Black-Scholes simulation using VIX as IV proxy + skew adjustments.
//   NOT a backtest against real traded options prices.
//
// WHAT WOULD MAKE IT REAL:
//   Historical options chain data (CBOE OptionMetrics, ~$10k+/yr).
//   Real bid-ask spreads, actual IV surface, settlement prices.
//
// IMPROVEMENTS OVER V1:
//   - Historical Fed Funds Rate instead of fixed risk-free rate
//   - Tuneable skew multipliers
//   - DTE parameter
//   - VIX minimum threshold (skip low-vol months)
//   - Stop-loss on margin
//   - Slippage/commission estimate
//   - Data in separate file
// ══════════════════════════════════════════════════════════════

const START_YEAR = DATA_START_YEAR;
const END_YEAR   = DATA_END_YEAR;

function getLabel(i) {
  const tot = START_YEAR * 12 + i;
  return `${Math.floor(tot / 12)}-${String((tot % 12) + 1).padStart(2, '0')}`;
}
function getYear(i) { return Math.floor((START_YEAR * 12 + i) / 12); }

function fmt(v, d = 1)  { return (v >= 0 ? '+' : '') + v.toFixed(d) + '%'; }
function fmtE(v)        { const a = Math.abs(v); return (v < 0 ? '-' : '') + '€' + (a >= 10000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(0)); }
function fmtER(v)       { return (v < 0 ? '-' : '') + '€' + Math.abs(v).toFixed(0); }

// Normal CDF approximation (Abramowitz & Stegun)
function normCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1, ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax))));
}

// Black-Scholes put price
function bsPut(S, K, r, T, sigma) {
  if (sigma < 0.001 || T < 0.0001 || S <= 0 || K <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// ─────────────────────────────────────────────────────────────
// BACKTEST ENGINE
// ─────────────────────────────────────────────────────────────
function runBacktest(params) {
  const {
    shortOTMp,                    // Short put OTM %
    longOTMp,                     // Long put OTM %
    startCap,                     // Starting capital €
    marginPct,                    // % of capital used as margin each month
    startYear,
    endYear,
    dte         = 30,             // Days to expiration
    skewShort   = 1.30,           // IV skew multiplier for short put
    skewLong    = 1.50,           // IV skew multiplier for long put
    vixMin      = 0,              // Only trade when VIX >= this
    stopLossPct = 0,              // Close early if loss > X% of max loss (0 = disabled)
    slippage    = 0,              // Per-spread slippage in $ (deducted from premium)
    useHistRFR  = true,           // Use historical Fed Funds vs fixed
    fixedRFR    = 4.0             // Fixed RFR if not using historical
  } = params;

  const longOTMf  = Math.max(longOTMp, shortOTMp + 0.5);
  const T         = dte / 365;
  const margFrac  = marginPct / 100;

  let cap = startCap, peak = startCap;
  const monthly = [];
  const n = Math.min(SPY.length, VIX.length, RFR.length);

  let spyWindowBase = null;

  for (let i = 1; i < n; i++) {
    const yr = getYear(i);
    if (yr < startYear || yr > endYear) continue;

    const S0 = SPY[i - 1], S1 = SPY[i];
    if (spyWindowBase === null) spyWindowBase = S0;

    const vixRaw = VIX[i - 1];

    // ── VIX THRESHOLD: skip month if VIX too low ──
    if (vixRaw < vixMin) {
      // No trade this month — still track equity and SPY B&H
      if (cap > peak) peak = cap;
      const dd = peak > 0 ? ((cap - peak) / peak) * 100 : 0;
      const spyBnH = startCap * (S1 / spyWindowBase);
      monthly.push({
        date: getLabel(i), year: String(yr), S0, S1,
        K1: 0, K2: 0, contracts: 0,
        premPerSh: 0, margPerSh: 0, margDeployed: 0,
        retPct: 0, retCapPct: 0, dollarPnl: 0,
        cap: +cap.toFixed(2), spyBnH: +spyBnH.toFixed(2),
        dd: +dd.toFixed(2), win: true,
        scenario: 'skip', vix: vixRaw, rfr: 0
      });
      continue;
    }

    // ── Risk-free rate ──
    const r = useHistRFR ? (RFR[i - 1] / 100) : (fixedRFR / 100);

    // ── Skew-adjusted implied volatilities ──
    const vix    = vixRaw / 100;
    const sigmaS = Math.max(vix * skewShort, 0.05);
    const sigmaL = Math.max(vix * skewLong, 0.05);

    const date = getLabel(i);
    const year = String(yr);

    // Strike prices
    const K1 = S0 * (1 - shortOTMp / 100);   // short put strike
    const K2 = S0 * (1 - longOTMf / 100);    // long put strike

    // Option prices per share (Black-Scholes)
    const shortPrem = bsPut(S0, K1, r, T, sigmaS);
    const longPrem  = bsPut(S0, K2, r, T, sigmaL);

    // Net premium per share after slippage
    const rawNetPrem = Math.max(shortPrem - longPrem, 0);
    // Slippage: deduct from premium per share (slippage is in $ per contract = 100 shares)
    const netPrem = Math.max(rawNetPrem - (slippage / 100), 0);

    const spreadWidth = K1 - K2;
    const margPerSh   = Math.max(spreadWidth - netPrem, 0.01);

    // ── RETURN ON MARGIN CALCULATION ──
    let retOnMargin;
    if (S1 >= K1) {
      // Win: SPY stayed above short strike
      retOnMargin = netPrem / margPerSh;
    } else if (S1 <= K2) {
      // Full loss: SPY dropped through both strikes
      retOnMargin = -1.0;
    } else {
      // Partial loss: between strikes
      const intrinsicLoss = K1 - S1;
      retOnMargin = (netPrem - intrinsicLoss) / margPerSh;
    }

    // ── STOP-LOSS: if enabled, cap the loss ──
    // In reality you'd close early intra-month. Here we simulate:
    // if the loss exceeds stopLossPct% of max possible loss, we close at that level.
    if (stopLossPct > 0 && retOnMargin < 0) {
      const stopLevel = -(stopLossPct / 100); // e.g. -0.50 for 50% stop
      if (retOnMargin < stopLevel) {
        retOnMargin = stopLevel;
      }
    }

    // Dollar P&L
    const margDeployed = Math.abs(cap) * margFrac;
    const dollarPnl    = retOnMargin * margDeployed;

    cap += dollarPnl;
    if (cap > peak) peak = cap;

    const dd        = peak > 0 ? ((cap - peak) / peak) * 100 : 0;
    const spyBnH    = startCap * (S1 / spyWindowBase);
    const retPct    = retOnMargin * 100;
    const retCapPct = retOnMargin * margFrac * 100;

    const approxContracts = margPerSh > 0
      ? Math.max(1, Math.round((Math.abs(cap) * margFrac) / (margPerSh * 100)))
      : 1;

    let scenario;
    if (S1 >= K1) scenario = 'win';
    else if (S1 <= K2) scenario = 'full_loss';
    else scenario = 'partial';

    // Override scenario if stop-loss triggered
    if (stopLossPct > 0 && retOnMargin === -(stopLossPct / 100) && scenario !== 'win') {
      scenario = 'stopped';
    }

    monthly.push({
      date, year, S0, S1,
      K1: +K1.toFixed(2), K2: +K2.toFixed(2),
      contracts: approxContracts,
      premPerSh:   +netPrem.toFixed(3),
      margPerSh:   +margPerSh.toFixed(3),
      margDeployed: +margDeployed.toFixed(2),
      retPct:      +retPct.toFixed(2),
      retCapPct:   +retCapPct.toFixed(3),
      dollarPnl:   +dollarPnl.toFixed(2),
      cap:         +cap.toFixed(2),
      spyBnH:      +spyBnH.toFixed(2),
      dd:          +dd.toFixed(2),
      win:         dollarPnl >= 0,
      scenario,
      vix:         vixRaw,
      rfr:         +(r * 100).toFixed(2)
    });
  }

  if (monthly.length === 0) return null;

  // ── Annual aggregation ──
  const annMap = {};
  monthly.forEach(m => {
    if (!annMap[m.year]) annMap[m.year] = { months: [], wins: 0, fullLoss: 0, skipped: 0 };
    annMap[m.year].months.push(m);
    if (m.win) annMap[m.year].wins++;
    if (m.scenario === 'full_loss') annMap[m.year].fullLoss++;
    if (m.scenario === 'skip') annMap[m.year].skipped++;
  });

  const annual = Object.entries(annMap).map(([yr, { months, wins, fullLoss, skipped }]) => {
    const cs  = months[0].cap - months[0].dollarPnl;
    const ce  = months[months.length - 1].cap;
    const pnl = ce - cs;
    const ret = cs !== 0 ? +(pnl / Math.abs(cs) * 100).toFixed(1) : 0;
    return {
      year: yr, retPct: ret, wins,
      losses:   months.length - wins,
      fullLoss, skipped,
      winRate: +(wins / months.length * 100).toFixed(0),
      pnl: +pnl.toFixed(0)
    };
  });

  const tradedMonths = monthly.filter(m => m.scenario !== 'skip');
  const wins   = tradedMonths.filter(m => m.win);
  const losses = tradedMonths.filter(m => !m.win);
  const yrs    = monthly.length / 12;

  const cagr = cap > 0 && startCap > 0
    ? +((Math.pow(cap / startCap, 1 / yrs) - 1) * 100).toFixed(1) : null;

  const spyEnd  = monthly[monthly.length - 1].spyBnH;
  const spyCagr = +((Math.pow(spyEnd / startCap, 1 / yrs) - 1) * 100).toFixed(1);

  return {
    monthly, annual,
    stats: {
      n:              monthly.length,
      traded:         tradedMonths.length,
      skipped:        monthly.length - tradedMonths.length,
      wins:           wins.length,
      losses:         losses.length,
      winRate:        tradedMonths.length > 0
                        ? +(wins.length / tradedMonths.length * 100).toFixed(1)
                        : 0,
      cagr, spyCagr,
      totalReturn:    +(((cap - startCap) / startCap) * 100).toFixed(1),
      maxDD:          +(Math.min(...monthly.map(m => m.dd))).toFixed(1),
      avgWin:         wins.length
                        ? +(wins.reduce((s, m) => s + m.retPct, 0) / wins.length).toFixed(1)
                        : 0,
      avgLoss:        losses.length
                        ? +(losses.reduce((s, m) => s + m.retPct, 0) / losses.length).toFixed(1)
                        : 0,
      bestMonth:      tradedMonths.length
                        ? +(Math.max(...tradedMonths.map(m => m.retPct))).toFixed(1)
                        : 0,
      worstMonth:     tradedMonths.length
                        ? +(Math.min(...tradedMonths.map(m => m.retPct))).toFixed(1)
                        : 0,
      finalCap:       +cap.toFixed(0),
      startCap,
      fullLossMonths: monthly.filter(m => m.scenario === 'full_loss').length,
      stoppedMonths:  monthly.filter(m => m.scenario === 'stopped').length
    }
  };
}

// ── WALK-FORWARD ENGINE ──
function runWalkForward(params, wfYears) {
  const windows = [];
  for (let y = params.startYear; y + wfYears - 1 <= params.endYear; y += wfYears) {
    const wEnd = Math.min(y + wfYears - 1, params.endYear);
    const r = runBacktest({ ...params, startYear: y, endYear: wEnd });
    if (r) windows.push({ from: y, to: wEnd, ...r.stats });
  }
  return windows;
}

// ─────────────────────────────────────────────────
// CHART / UI CODE
// ─────────────────────────────────────────────────
Chart.defaults.color = '#3d4160';
Chart.defaults.font.family = "'IBM Plex Mono', monospace";
Chart.defaults.font.size = 9;

let charts = {}, lastResult = null;

function destroyAll() { Object.values(charts).forEach(c => c && c.destroy()); charts = {}; }
function gridOpts()   { return { color: 'rgba(28,31,53,0.8)', drawBorder: false }; }
function tickOpts()   { return { maxRotation: 0, color: '#3d4160' }; }

const ttBase = {
  backgroundColor: '#111325', borderColor: '#1c1f35', borderWidth: 1,
  titleColor: '#3d4160', bodyColor: '#b8bdd4', padding: 10
};

function renderStats(s) {
  const grid = document.getElementById('statsGrid');
  const cagrVal = s.cagr !== null ? fmt(s.cagr) : 'N/A';
  const cagrCls = s.cagr !== null && s.cagr > s.spyCagr ? 'green' : 'accent';
  const cards = [
    { label: 'Strategy CAGR',    value: cagrVal,                sub: `SPY B&H: ${fmt(s.spyCagr)}`,                 cls: cagrCls },
    { label: 'Win Rate',          value: `${s.winRate}%`,       sub: `${s.wins}W · ${s.losses}L / ${s.traded} traded${s.skipped ? ' · ' + s.skipped + ' skipped' : ''}`, cls: 'accent' },
    { label: 'Max Drawdown',      value: `${s.maxDD}%`,         sub: 'from equity peak',                           cls: 'red' },
    { label: 'Total Return',      value: fmt(s.totalReturn, 0), sub: `${fmtE(s.startCap)} → ${fmtE(s.finalCap)}`, cls: s.totalReturn > 0 ? 'green' : 'red' },
    { label: 'Avg Win Month',     value: `+${s.avgWin}%`,       sub: 'on margin deployed',                         cls: 'green' },
    { label: 'Avg Loss Month',    value: `${s.avgLoss}%`,       sub: 'on margin deployed',                         cls: 'red' },
    { label: 'Best Month',        value: `+${s.bestMonth}%`,    sub: 'single month',                               cls: 'green' },
    { label: 'Full Loss Months',  value: String(s.fullLossMonths), sub: s.stoppedMonths ? `${s.stoppedMonths} stopped early` : 'SPY through both strikes', cls: 'red' },
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
        tooltip: { ...ttBase, callbacks: {
          label: c => `  ${c.dataset.label}: ${fmtER(c.parsed.y)}`
        }}
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
  charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: monthly.map(m => m.date),
      datasets: [{
        label: 'Monthly Return % (on margin)',
        data: monthly.map(m => m.retPct),
        backgroundColor: monthly.map(m => {
          if (m.scenario === 'win')       return 'rgba(29,218,122,0.75)';
          if (m.scenario === 'full_loss') return 'rgba(255,69,96,0.9)';
          if (m.scenario === 'stopped')   return 'rgba(255,180,50,0.9)';
          if (m.scenario === 'skip')      return 'rgba(61,65,96,0.3)';
          return 'rgba(255,150,50,0.8)';
        }),
        borderWidth: 0, borderRadius: 1
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...ttBase, callbacks: {
          label: (c) => {
            const m = monthly[c.dataIndex];
            if (m.scenario === 'skip') return ['  SKIPPED: VIX below threshold'];
            const labels = { win: 'WIN', full_loss: 'FULL LOSS', partial: 'PARTIAL', stopped: 'STOPPED' };
            return [
              `  ${labels[m.scenario] || m.scenario}: ${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(2)}% on margin`,
              `  P&L: ${fmtER(m.dollarPnl)}  (${(m.retCapPct >= 0 ? '+' : '')}${m.retCapPct.toFixed(2)}% on capital)`,
              `  SPY: ${m.S0}→${m.S1}  (${fmt((m.S1 - m.S0) / m.S0 * 100, 1)})`,
              `  VIX: ${m.vix}  |  RFR: ${m.rfr}%`
            ];
          }
        }}
      },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 12 } },
        y: { grid: gridOpts(), ticks: { ...tickOpts(), callback: v => v + '%' },
          afterDataLimits: a => { a.max = Math.max(a.max, 10); a.min = Math.min(a.min, -110); }
        }
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
      datasets: [{
        label: 'Annual Return %',
        data: annual.map(a => a.retPct),
        backgroundColor: annual.map(a => a.retPct >= 0 ? 'rgba(29,218,122,0.8)' : 'rgba(255,69,96,0.8)'),
        borderRadius: 3, borderSkipped: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...ttBase, callbacks: {
          label: c => [
            `  Return: ${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(1)}%`,
            `  P&L: ${fmtER(annual[c.dataIndex].pnl)}`,
            `  Win: ${annual[c.dataIndex].winRate}% (${annual[c.dataIndex].wins}W·${annual[c.dataIndex].losses}L)`,
            annual[c.dataIndex].skipped ? `  Skipped: ${annual[c.dataIndex].skipped} months` : ''
          ].filter(Boolean)
        }}
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
      <div class="annual-wr">${a.winRate}% W${a.skipped ? ' · ' + a.skipped + 's' : ''}</div>
    </div>`).join('');
}

function renderDrawdown(monthly) {
  const ctx = document.getElementById('chartDrawdown').getContext('2d');
  charts.drawdown = new Chart(ctx, {
    type: 'line',
    data: {
      labels: monthly.map(m => m.date),
      datasets: [{
        label: 'Drawdown from peak',
        data: monthly.map(m => m.dd),
        borderColor: 'rgba(255,69,96,0.9)', backgroundColor: 'rgba(255,69,96,0.07)',
        borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...ttBase, callbacks: { label: c => `  Drawdown: ${c.parsed.y.toFixed(2)}%` } }
      },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 10 } },
        y: { grid: gridOpts(), ticks: { ...tickOpts(), callback: v => v + '%' } }
      }
    }
  });
}

// ── WALK-FORWARD TABLE ──
function renderWalkForward(windows) {
  const tbody = document.getElementById('wfBody');
  if (!windows || windows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No data for selected range</td></tr>';
    return;
  }
  tbody.innerHTML = windows.map(w => {
    const retCls   = w.cagr !== null && w.cagr >= 0 ? 'green' : 'red';
    const totalCls = w.totalReturn >= 0 ? 'green' : 'red';
    const cagrStr  = w.cagr !== null ? fmt(w.cagr) : 'N/A';
    return `<tr>
      <td>${w.from}–${w.to}</td>
      <td class="${retCls}">${cagrStr}</td>
      <td class="${totalCls}">${fmt(w.totalReturn, 0)}</td>
      <td>${w.winRate}%</td>
      <td>${w.fullLossMonths}</td>
      <td class="red">${w.maxDD}%</td>
      <td class="muted">${fmt(w.spyCagr)}</td>
    </tr>`;
  }).join('');
}

// ── POPULATE YEAR DROPDOWNS ──
function populateYears() {
  ['startYear', 'endYear'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    for (let y = START_YEAR; y <= END_YEAR; y++) {
      el.innerHTML += `<option value="${y}">${y}</option>`;
    }
  });
  document.getElementById('startYear').value = START_YEAR;
  document.getElementById('endYear').value   = END_YEAR;
}

// ── GATHER PARAMS FROM UI ──
function gatherParams() {
  return {
    shortOTMp:  parseFloat(document.getElementById('shortOTM').value)   || 5,
    longOTMp:   parseFloat(document.getElementById('longOTM').value)    || 8,
    startCap:   parseFloat(document.getElementById('capital').value)    || 10000,
    marginPct:  parseFloat(document.getElementById('marginPct').value)  || 25,
    startYear:  parseInt(document.getElementById('startYear').value)    || START_YEAR,
    endYear:    parseInt(document.getElementById('endYear').value)      || END_YEAR,
    dte:        parseFloat(document.getElementById('dte').value)        || 30,
    skewShort:  parseFloat(document.getElementById('skewShort').value)  || 1.30,
    skewLong:   parseFloat(document.getElementById('skewLong').value)   || 1.50,
    vixMin:     parseFloat(document.getElementById('vixMin').value)     || 0,
    stopLossPct:parseFloat(document.getElementById('stopLoss').value)   || 0,
    slippage:   parseFloat(document.getElementById('slippage').value)   || 0,
    useHistRFR: document.getElementById('rfrMode').value === 'hist',
    fixedRFR:   parseFloat(document.getElementById('rfr').value)        || 4
  };
}

// ── MAIN RUN ──
function run() {
  const params  = gatherParams();
  const wfYears = parseInt(document.getElementById('wfYears').value) || 3;

  if (params.startYear >= params.endYear) {
    document.getElementById('statsGrid').innerHTML =
      '<div style="color:var(--red);font-family:var(--font-mono);font-size:11px;padding:12px">Start year must be before end year.</div>';
    return;
  }

  // Toggle fixed RFR visibility
  const rfrCtrl = document.getElementById('rfrCtrl');
  if (rfrCtrl) rfrCtrl.style.display = params.useHistRFR ? 'none' : '';

  const result = runBacktest(params);
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

  const wf = runWalkForward(params, wfYears);
  renderWalkForward(wf);
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
// Hide fixed RFR input on load (historical is default)
const rfrCtrl = document.getElementById('rfrCtrl');
if (rfrCtrl) rfrCtrl.style.display = 'none';
run();
