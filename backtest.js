// backtest.js — uses SPY_DATA / VIX_DATA / DATA_START_YEAR from data.js

// ── HELPERS ──
function getLabel(i) {
  const tot = DATA_START_YEAR * 12 + i;
  return `${Math.floor(tot/12)}-${String((tot%12)+1).padStart(2,'0')}`;
}
function getYear(i) { return Math.floor((DATA_START_YEAR * 12 + i) / 12); }

function fmt(v, d=1)  { return (v>=0?'+':'')+v.toFixed(d)+'%'; }
function fmtE(v)      { const a=Math.abs(v); return (v<0?'-':'')+'€'+(a>=10000?(a/1000).toFixed(1)+'k':a.toFixed(0)); }
function fmtER(v)     { return (v<0?'-':'')+'€'+Math.abs(v).toFixed(0); }

// ── MATH ──
function normCDF(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const s=x<0?-1:1, ax=Math.abs(x)/Math.sqrt(2);
  const t=1/(1+p*ax);
  return 0.5*(1+s*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax))));
}

function bsPut(S, K, r, T, sigma) {
  if (sigma<0.001||T<0.0001||S<=0||K<=0) return Math.max(K-S, 0);
  const d1 = (Math.log(S/K)+(r+sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return K*Math.exp(-r*T)*normCDF(-d2) - S*normCDF(-d1);
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST ENGINE
//
// PARAMETER GUIDE:
//
//   shortOTMp   — how far below current SPY price you sell the put, in %.
//                 5% = sell at 0.95 × S0. Lower = more premium but higher
//                 probability of being tested.
//
//   longOTMp    — where you buy the protective put, in %.
//                 Must be > shortOTMp. Defines your max loss per spread.
//                 Spread width = (longOTM - shortOTM)% of S0.
//
//   rfrPct      — Risk-Free Rate. The annualised return on a zero-risk
//                 investment (e.g. US T-bill). Currently ~4-5%. Used in
//                 Black-Scholes to discount the strike price to present value.
//                 A higher RFR slightly increases put value (bad for seller).
//                 In practice it matters very little for 30-day spreads.
//
//   marginPct   — What fraction of your capital you deploy as margin
//                 each month. The margin required = spread width – premium.
//                 At 25%: a full-loss month costs you at most -25% of capital.
//                 At 50%: a full-loss month costs -50%. Never go above ~30%
//                 without a clear understanding of ruin probability.
//
//   dteDays     — Days to expiration. Real traders prefer 30-45 DTE (45 DTE
//                 is the Tastytrade standard). Longer DTE = more premium but
//                 more time for things to go wrong. This model approximates
//                 DTE by stretching the Black-Scholes time window.
//
//   skewShort   — Implied volatility multiplier for the short put.
//                 OTM puts trade at higher IV than ATM (the "skew").
//                 5% OTM typically: 1.20–1.40× VIX. Default 1.30.
//
//   skewLong    — IV multiplier for the long (protective) put.
//                 8% OTM typically: 1.40–1.65× VIX. Default 1.50.
//
//   vixFloor    — Minimum VIX to enter a trade. If VIX is below this,
//                 skip the month (premium too small to be worth the risk).
//                 Real traders often use 15 as their floor.
//                 Set to 0 to always trade.
//
//   vixCeil     — Maximum VIX to enter. If VIX is above this, skip
//                 (market too fearful, better to wait). Set to 999 to
//                 always trade regardless of vol.
//                 Note: skipping high-VIX months also skips the most
//                 profitable premiums — it is a risk-management tool,
//                 not a return-maximiser.
//
//   stopLossMult — Stop-loss multiplier. If the trade reaches this
//                 multiple of the premium collected as a loss, close it
//                 early. E.g. 2.0 = close when loss = 2× premium.
//                 Tastytrade standard is 2× (200% of premium collected).
//                 Set to 0 to never stop out (hold to expiry).
//
// SIZING MODEL:
//   Percentage-based — completely capital-independent.
//   retOnMargin = P&L per unit of margin deployed (pure ratio).
//   dollarPnl = retOnMargin × capital × (marginPct/100)
//   This means a €500 and a €50,000 account see identical CAGR.
// ─────────────────────────────────────────────────────────────────────────────
function runBacktest(p) {
  const {
    shortOTMp, longOTMp, rfrPct, marginPct,
    dteDays, skewShort, skewLong,
    vixFloor, vixCeil, stopLossMult,
    startYear, endYear, startCap
  } = p;

  const longOTMf  = Math.max(longOTMp, shortOTMp + 0.5);
  const T         = dteDays / 365;
  const r         = rfrPct / 100;
  const margFrac  = marginPct / 100;

  let cap = startCap, peak = startCap;
  const monthly = [];
  const n = Math.min(SPY_DATA.length, VIX_DATA.length);
  let spyWindowBase = null;
  let skippedMonths = 0;

  for (let i = 1; i < n; i++) {
    const yr = getYear(i);
    if (yr < startYear || yr > endYear) continue;

    const S0  = SPY_DATA[i-1];
    const S1  = SPY_DATA[i];
    const vix = VIX_DATA[i-1];

    if (spyWindowBase === null) spyWindowBase = S0;

    const date = getLabel(i);
    const year = String(yr);

    // VIX filter — skip month if outside comfort zone
    if (vix < vixFloor || vix > vixCeil) {
      skippedMonths++;
      // Capital sits in cash — no change this month
      const spyBnH = startCap * (S1 / spyWindowBase);
      monthly.push({
        date, year, S0, S1, vix,
        skipped: true,
        retPct: 0, retCapPct: 0, dollarPnl: 0,
        cap: +cap.toFixed(2), spyBnH: +spyBnH.toFixed(2),
        dd: peak>0 ? +((cap-peak)/peak*100).toFixed(2) : 0,
        win: false, scenario: 'skipped'
      });
      continue;
    }

    // Skew-adjusted sigmas
    const sigmaS = Math.max((vix/100) * skewShort, 0.05);
    const sigmaL = Math.max((vix/100) * skewLong,  0.05);

    // Strikes
    const K1 = S0 * (1 - shortOTMp / 100);
    const K2 = S0 * (1 - longOTMf  / 100);

    // Option prices per share
    const shortPrem = bsPut(S0, K1, r, T, sigmaS);
    const longPrem  = bsPut(S0, K2, r, T, sigmaL);
    const netPrem   = Math.max(shortPrem - longPrem, 0);
    const margPerSh = Math.max((K1 - K2) - netPrem, 0.01);

    // P&L ratio
    let rawPnlSh;
    if      (S1 >= K1) rawPnlSh =  netPrem;
    else if (S1 <= K2) rawPnlSh = -margPerSh;
    else               rawPnlSh =  netPrem - (K1 - S1);

    // Stop-loss: if loss exceeds stopLossMult × premium, close early
    // In this monthly model we approximate: if we would have lost more
    // than stopLossMult × netPrem, cap the loss there.
    let pnlSh = rawPnlSh;
    let stopped = false;
    if (stopLossMult > 0 && rawPnlSh < 0) {
      const stopLevel = -netPrem * stopLossMult;
      if (rawPnlSh < stopLevel) {
        pnlSh = stopLevel;
        stopped = true;
      }
    }

    const retOnMargin = pnlSh / margPerSh;
    const dollarPnl   = retOnMargin * Math.abs(cap) * margFrac;

    cap += dollarPnl;
    if (cap > peak) peak = cap;

    const dd        = peak > 0 ? ((cap-peak)/peak)*100 : 0;
    const spyBnH    = startCap * (S1 / spyWindowBase);
    const retPct    = retOnMargin * 100;
    const retCapPct = retOnMargin * margFrac * 100;

    let scenario = S1 >= K1 ? 'win' : S1 <= K2 ? 'full_loss' : 'partial';
    if (stopped) scenario = 'stopped';

    monthly.push({
      date, year, S0, S1, vix,
      K1: +K1.toFixed(2), K2: +K2.toFixed(2),
      netPrem:    +netPrem.toFixed(3),
      margPerSh:  +margPerSh.toFixed(3),
      premiumPct: +(netPrem/margPerSh*100).toFixed(1),
      retPct:     +retPct.toFixed(2),
      retCapPct:  +retCapPct.toFixed(3),
      dollarPnl:  +dollarPnl.toFixed(2),
      cap:        +cap.toFixed(2),
      spyBnH:     +spyBnH.toFixed(2),
      dd:         +dd.toFixed(2),
      win:        dollarPnl >= 0,
      skipped:    false,
      scenario
    });
  }

  if (monthly.length === 0) return null;

  // Annual aggregation (exclude skipped months from win-rate calc)
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
    const ce  = months[months.length-1].cap;
    const pnl = ce - cs;
    const ret = cs !== 0 ? +(pnl/Math.abs(cs)*100).toFixed(1) : 0;
    const wr  = traded.length ? +(wins/traded.length*100).toFixed(0) : 0;
    return { year: yr, retPct: ret, wins, losses: traded.length-wins,
             fullLoss, winRate: wr, pnl: +pnl.toFixed(0), traded: traded.length };
  });

  const traded  = monthly.filter(m => !m.skipped);
  const wins    = traded.filter(m => m.win);
  const losses  = traded.filter(m => !m.win);
  const yrs     = monthly.length / 12;
  const spyEnd  = monthly[monthly.length-1].spyBnH;

  const cagr    = cap > 0 && startCap > 0
    ? +((Math.pow(cap/startCap, 1/yrs)-1)*100).toFixed(1) : null;
  const spyCagr = +((Math.pow(spyEnd/startCap, 1/yrs)-1)*100).toFixed(1);

  // Average premium % (net premium / margin) — key metric for strategy health
  const avgPremPct = traded.length
    ? +(traded.reduce((s,m)=>s+m.premiumPct,0)/traded.length).toFixed(1) : 0;

  return { monthly, annual,
    stats: {
      n: monthly.length, traded: traded.length, skipped: skippedMonths,
      wins: wins.length, losses: losses.length,
      winRate:    +(wins.length/Math.max(traded.length,1)*100).toFixed(1),
      cagr, spyCagr,
      totalReturn:+(((cap-startCap)/startCap)*100).toFixed(1),
      maxDD:      +(Math.min(...monthly.map(m=>m.dd))).toFixed(1),
      avgWin:      wins.length   ? +(wins.reduce((s,m)=>s+m.retPct,0)/wins.length).toFixed(1)   : 0,
      avgLoss:     losses.length ? +(losses.reduce((s,m)=>s+m.retPct,0)/losses.length).toFixed(1) : 0,
      bestMonth:  traded.length ? +(Math.max(...traded.map(m=>m.retPct))).toFixed(1) : 0,
      worstMonth: traded.length ? +(Math.min(...traded.map(m=>m.retPct))).toFixed(1) : 0,
      avgPremPct, fullLossMonths: traded.filter(m=>m.scenario==='full_loss').length,
      stoppedMonths: traded.filter(m=>m.scenario==='stopped').length,
      finalCap: +cap.toFixed(0), startCap
    }
  };
}

// Walk-forward
function runWalkForward(p, wfYears) {
  const windows = [];
  const sy = p.startYear, ey = p.endYear;
  for (let y = sy; y + wfYears - 1 <= ey; y += wfYears) {
    const wEnd = Math.min(y + wfYears - 1, ey);
    const r = runBacktest({ ...p, startYear: y, endYear: wEnd });
    if (r) windows.push({ from: y, to: wEnd, ...r.stats });
  }
  return windows;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART / UI
// ─────────────────────────────────────────────────────────────────────────────
Chart.defaults.color = '#3d4160';
Chart.defaults.font.family = "'IBM Plex Mono', monospace";
Chart.defaults.font.size = 9;

let charts = {}, lastResult = null;

function destroyAll() { Object.values(charts).forEach(c => c&&c.destroy()); charts = {}; }
function gridOpts()   { return { color: 'rgba(28,31,53,0.8)', drawBorder: false }; }
function tickOpts()   { return { maxRotation: 0, color: '#3d4160' }; }
const ttBase = { backgroundColor:'#111325', borderColor:'#1c1f35', borderWidth:1, titleColor:'#3d4160', bodyColor:'#b8bdd4', padding:10 };

// ── COLLECT PARAMS ──
function getParams() {
  const g = id => parseFloat(document.getElementById(id).value);
  const gi = id => parseInt(document.getElementById(id).value);
  return {
    shortOTMp:    g('shortOTM'),
    longOTMp:     g('longOTM'),
    rfrPct:       g('rfr'),
    marginPct:    g('marginPct'),
    dteDays:      g('dte'),
    skewShort:    g('skewShort'),
    skewLong:     g('skewLong'),
    vixFloor:     g('vixFloor'),
    vixCeil:      g('vixCeil'),
    stopLossMult: g('stopLoss'),
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
    ? `${s.traded} traded · ${s.skipped} skipped (VIX filter)`
    : `${s.traded} months traded`;

  const cards = [
    { label:'Strategy CAGR',      value:cagrVal,                  sub:`SPY B&H: ${fmt(s.spyCagr)}`,       cls:cagrCls },
    { label:'Win Rate',            value:`${s.winRate}%`,          sub:`${s.wins}W · ${s.losses}L`,        cls:'accent' },
    { label:'Max Drawdown',        value:`${s.maxDD}%`,            sub:'from equity peak',                  cls:'red' },
    { label:'Total Return',        value:fmt(s.totalReturn,0),     sub:`${fmtE(s.startCap)} → ${fmtE(s.finalCap)}`, cls:s.totalReturn>0?'green':'red' },
    { label:'Avg Premium / Margin',value:`+${s.avgPremPct}%`,     sub:'net credit ÷ margin required',      cls:'green' },
    { label:'Avg Loss Month',      value:`${s.avgLoss}%`,          sub:'on margin deployed',                cls:'red' },
    { label:'Full Loss Months',    value:String(s.fullLossMonths), sub:'SPY dropped through both strikes',  cls:'red' },
    { label:'Stopped Out',         value:String(s.stoppedMonths),  sub:tradeInfo,                           cls:'muted2' },
  ];
  grid.innerHTML = cards.map((c,i) => `
    <div class="stat-card" style="animation-delay:${i*0.025}s">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
    </div>`).join('');
}

function renderEquity(monthly) {
  const ctx = document.getElementById('chartEquity').getContext('2d');
  const showSPY = document.getElementById('spyToggle').checked;
  const ds = [{
    label:'Strategy', data:monthly.map(m=>m.cap),
    borderColor:'#f0a500', backgroundColor:'rgba(240,165,0,0.06)',
    borderWidth:2, pointRadius:0, fill:true, tension:0.3
  }];
  if (showSPY) ds.push({
    label:'SPY B&H', data:monthly.map(m=>m.spyBnH),
    borderColor:'#4fa3e8', borderWidth:1.5, borderDash:[6,3],
    pointRadius:0, fill:false, tension:0.3
  });
  charts.equity = new Chart(ctx, {
    type:'line', data:{labels:monthly.map(m=>m.date), datasets:ds},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:600},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:true, labels:{color:'#5a5f7a',boxWidth:14,font:{size:9}}},
        tooltip:{...ttBase, callbacks:{label:c=>`  ${c.dataset.label}: ${fmtER(c.parsed.y)}`}}
      },
      scales:{
        x:{grid:gridOpts(), ticks:{...tickOpts(),maxTicksLimit:10}},
        y:{grid:gridOpts(), ticks:{...tickOpts(), callback:v=>(v<0?'-':'')+'€'+Math.abs(Math.round(v/1000))+'k'}}
      }
    }
  });
}

function renderMonthly(monthly) {
  const ctx = document.getElementById('chartMonthly').getContext('2d');
  const colorOf = m => {
    if (m.scenario==='skipped')    return 'rgba(90,95,122,0.4)';
    if (m.scenario==='win')        return 'rgba(29,218,122,0.75)';
    if (m.scenario==='full_loss')  return 'rgba(255,69,96,0.9)';
    if (m.scenario==='stopped')    return 'rgba(255,69,96,0.55)';
    return 'rgba(255,150,50,0.8)';
  };
  charts.monthly = new Chart(ctx, {
    type:'bar',
    data:{
      labels:monthly.map(m=>m.date),
      datasets:[{ label:'Return %', data:monthly.map(m=>m.retPct),
        backgroundColor:monthly.map(colorOf), borderWidth:0, borderRadius:1 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{...ttBase, callbacks:{label:(c)=>{
          const m = monthly[c.dataIndex];
          if (m.scenario==='skipped') return `  SKIPPED — VIX: ${m.vix}`;
          const lbl = {win:'WIN',full_loss:'FULL LOSS',partial:'PARTIAL',stopped:'STOPPED OUT'}[m.scenario]||m.scenario;
          return[
            `  ${lbl}: ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(2)}% on margin`,
            `  Capital P&L: ${fmtER(m.dollarPnl)}`,
            `  VIX: ${m.vix}  ·  SPY: ${m.S0}→${m.S1} (${fmt((m.S1-m.S0)/m.S0*100,1)})`
          ];
        }}}
      },
      scales:{
        x:{grid:gridOpts(), ticks:{...tickOpts(),maxTicksLimit:12}},
        y:{grid:gridOpts(), ticks:{...tickOpts(), callback:v=>v+'%'},
          afterDataLimits:a=>{a.max=Math.max(a.max,10);a.min=Math.min(a.min,-110);}}
      }
    }
  });
}

function renderAnnual(annual) {
  const ctx = document.getElementById('chartAnnual').getContext('2d');
  charts.annual = new Chart(ctx, {
    type:'bar',
    data:{
      labels:annual.map(a=>a.year),
      datasets:[{ label:'Annual Return %', data:annual.map(a=>a.retPct),
        backgroundColor:annual.map(a=>a.retPct>=0?'rgba(29,218,122,0.8)':'rgba(255,69,96,0.8)'),
        borderRadius:3, borderSkipped:false }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{...ttBase, callbacks:{label:c=>[
          `  Return: ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(1)}%`,
          `  P&L: ${fmtER(annual[c.dataIndex].pnl)}  ·  ${annual[c.dataIndex].traded} months traded`,
          `  Win rate: ${annual[c.dataIndex].winRate}% (${annual[c.dataIndex].wins}W·${annual[c.dataIndex].losses}L)`
        ]}}
      },
      scales:{
        x:{grid:gridOpts(), ticks:tickOpts()},
        y:{grid:gridOpts(), ticks:{...tickOpts(), callback:v=>v+'%'}}
      }
    }
  });
}

function renderAnnualGrid(annual) {
  document.getElementById('annualGrid').innerHTML = annual.map(a=>`
    <div class="annual-cell">
      <div class="annual-year">${a.year}</div>
      <div class="annual-ret" style="color:${a.retPct>=0?'var(--green)':'var(--red)'}">
        ${a.retPct>=0?'+':''}${a.retPct}%
      </div>
      <div class="annual-wr">${a.winRate}% W</div>
    </div>`).join('');
}

function renderDrawdown(monthly) {
  const ctx = document.getElementById('chartDrawdown').getContext('2d');
  charts.drawdown = new Chart(ctx, {
    type:'line',
    data:{
      labels:monthly.map(m=>m.date),
      datasets:[{ label:'Drawdown from peak', data:monthly.map(m=>m.dd),
        borderColor:'rgba(255,69,96,0.9)', backgroundColor:'rgba(255,69,96,0.07)',
        borderWidth:1.5, pointRadius:0, fill:true, tension:0.2 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{...ttBase, callbacks:{label:c=>`  Drawdown: ${c.parsed.y.toFixed(2)}%`}}
      },
      scales:{
        x:{grid:gridOpts(), ticks:{...tickOpts(),maxTicksLimit:10}},
        y:{grid:gridOpts(), ticks:{...tickOpts(), callback:v=>v+'%'}}
      }
    }
  });
}

function renderWalkForward(windows) {
  const tbody = document.getElementById('wfBody');
  if (!windows||!windows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No data</td></tr>';
    return;
  }
  tbody.innerHTML = windows.map(w => {
    const rc = w.cagr!==null&&w.cagr>=0?'green':'red';
    const tc = w.totalReturn>=0?'green':'red';
    return `<tr>
      <td>${w.from}–${w.to}</td>
      <td class="${rc}">${w.cagr!==null?fmt(w.cagr):'N/A'}</td>
      <td class="${tc}">${fmt(w.totalReturn,0)}</td>
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
  ['startYear','endYear'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    for (let y = DATA_START_YEAR; y <= DATA_END_YEAR; y++)
      el.innerHTML += `<option value="${y}">${y}</option>`;
  });
  document.getElementById('startYear').value = DATA_START_YEAR;
  document.getElementById('endYear').value   = DATA_END_YEAR;
}

// ── TOOLTIPS for parameter labels ──
function initTooltips() {
  document.querySelectorAll('[data-tip]').forEach(el => {
    el.style.cursor = 'help';
    el.title = el.dataset.tip;
  });
}

// ── MAIN RUN ──
function run() {
  const p = getParams();
  if (p.startYear >= p.endYear) {
    document.getElementById('statsGrid').innerHTML =
      '<div style="color:var(--red);font-family:var(--font-mono);font-size:11px;padding:12px">Start year must be before end year.</div>';
    return;
  }

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
    document.getElementById('panel-'+tab).classList.add('active');
    document.getElementById('spyToggleWrap').style.display = tab==='equity'?'flex':'none';
    setTimeout(() => Object.values(charts).forEach(c=>c&&c.resize()), 10);
  });
});

document.getElementById('spyToggle').addEventListener('change', () => {
  if (!lastResult) return;
  if (charts.equity) charts.equity.destroy();
  renderEquity(lastResult.monthly);
});

// ── INIT ──
populateYears();
initTooltips();
run();
