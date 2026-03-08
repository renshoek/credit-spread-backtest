// ── DATA: SPY monthly closes 2000–2024 ──
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

// ── DATA: VIX monthly closes 2000–2024 ──
const VIX = [
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

const START_YEAR = 2000;

function getLabel(i) {
  const tot = START_YEAR * 12 + i;
  return `${Math.floor(tot/12)}-${String((tot%12)+1).padStart(2,'0')}`;
}

function fmt(v, d=1)  { return (v>=0?'+':'')+v.toFixed(d)+'%'; }
function fmtE(v)      { const abs=Math.abs(v); return (v<0?'-€':'€')+(abs>=10000?(abs/1000).toFixed(1)+'k':abs.toFixed(0)); }
function fmtERaw(v)   { return (v<0?'-€':'€')+Math.abs(v).toFixed(0); }

// Normal CDF (Abramowitz & Stegun)
function normCDF(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const s=x<0?-1:1, ax=Math.abs(x)/Math.sqrt(2);
  const t=1/(1+p*ax);
  return 0.5*(1+s*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax))));
}

// Black-Scholes put price
function bsPut(S,K,r,T,sigma) {
  if(sigma<0.01||T<0.001||S<=0||K<=0) return Math.max(K-S,0);
  const d1=(Math.log(S/K)+(r+sigma*sigma/2)*T)/(sigma*Math.sqrt(T));
  const d2=d1-sigma*Math.sqrt(T);
  return K*Math.exp(-r*T)*normCDF(-d2)-S*normCDF(-d1);
}

// ─────────────────────────────────────────────────
// BACKTEST ENGINE — CONTRACT-BASED SIZING
//
// One contract = 100 shares of SPY.
// Margin per contract = (spreadWidth − netPremium) × 100
//   This equals the maximum possible loss per contract.
//   The long put at longOTM% hard-caps that loss — there is
//   no scenario where you lose more per contract than this.
//
// Contracts traded = floor(available_capital / marginPerContract)
//   Minimum 1 contract always — account can recover from losses.
//   If capital goes negative the account trades 1 contract on
//   margin (simulating a funded recovery scenario).
//
// Capital has NO floor — it can go and stay negative.
// ─────────────────────────────────────────────────
function runBacktest(shortOTMp, longOTMp, startCap, rfrPct) {
  const longOTMf = Math.max(longOTMp, shortOTMp+0.5);
  const T=30/365, r=rfrPct/100;
  let cap=startCap, peak=startCap;
  const monthly=[], spyBase=SPY[0], n=Math.min(SPY.length,VIX.length);

  for(let i=1;i<n;i++){
    const S0=SPY[i-1], S1=SPY[i];
    const sigma=Math.max(VIX[i-1]/100,0.05);
    const date=getLabel(i), year=date.substring(0,4);

    // Strikes
    const K1=S0*(1-shortOTMp/100);   // short put — 5% below
    const K2=S0*(1-longOTMf/100);    // long put  — 8% below (locks max loss)

    // Per-share option prices
    const sp=bsPut(S0,K1,r,T,sigma);
    const lp=bsPut(S0,K2,r,T,sigma);

    // Per-share economics
    const netPrem   = Math.max(sp-lp,0);      // credit collected per share
    const swPerShare= K1-K2;                   // spread width per share
    const margPerSh = Math.max(swPerShare-netPrem,0.01); // margin = max loss per share

    // Per contract (100 shares)
    const margPerCon= margPerSh*100;
    const premPerCon= netPrem*100;

    // Sizing: how many contracts fit in available capital?
    const avail    = Math.max(cap,0);
    const contracts= Math.max(1, Math.floor(avail/margPerCon));

    // P&L per share — 3 outcomes:
    // 1. S1 above short strike → keep full premium
    // 2. S1 below long strike  → hit max loss (long put absorbed the rest)
    // 3. S1 between strikes    → partial loss
    let pnlSh;
    if     (S1>=K1) pnlSh= netPrem;
    else if(S1<=K2) pnlSh=-margPerSh;
    else            pnlSh= netPrem-(K1-S1);

    const dollarPnl=pnlSh*100*contracts;
    cap+=dollarPnl;                           // NO floor — capital can go negative
    if(cap>peak) peak=cap;
    const dd=peak>0?((cap-peak)/peak)*100:0;
    const spyBnH=startCap*(S1/spyBase);
    const totalMarg=margPerCon*contracts;
    const retPct=(dollarPnl/totalMarg)*100;

    monthly.push({
      date,year,S0,S1,
      K1:+K1.toFixed(2),K2:+K2.toFixed(2),
      contracts,
      premPerCon:+premPerCon.toFixed(2),
      margPerCon:+margPerCon.toFixed(2),
      retPct:+retPct.toFixed(2),
      dollarPnl:+dollarPnl.toFixed(2),
      cap:+cap.toFixed(2),
      spyBnH:+spyBnH.toFixed(2),
      dd:+dd.toFixed(2),
      win:dollarPnl>=0
    });
  }

  // Annual aggregation
  const annMap={};
  monthly.forEach(m=>{
    if(!annMap[m.year]) annMap[m.year]={months:[],wins:0};
    annMap[m.year].months.push(m);
    if(m.win) annMap[m.year].wins++;
  });

  const annual=Object.entries(annMap).map(([yr,{months,wins}])=>{
    const cs=months[0].cap-months[0].dollarPnl;
    const ce=months[months.length-1].cap;
    const pnl=ce-cs;
    const retPct=cs!==0?+(pnl/Math.abs(cs)*100).toFixed(1):0;
    return{year:yr,retPct,wins,losses:months.length-wins,
      winRate:+(wins/months.length*100).toFixed(0),pnl:+pnl.toFixed(0)};
  });

  const wins=monthly.filter(m=>m.win);
  const losses=monthly.filter(m=>!m.win);
  const yrs=monthly.length/12;
  const spyFinal=startCap*(SPY[n-1]/spyBase);
  const cagr=cap>0&&startCap>0?+((Math.pow(cap/startCap,1/yrs)-1)*100).toFixed(1):null;

  return{monthly,annual,stats:{
    n:monthly.length,
    wins:wins.length,losses:losses.length,
    winRate:+(wins.length/monthly.length*100).toFixed(1),
    cagr,spyCagr:+((Math.pow(spyFinal/startCap,1/yrs)-1)*100).toFixed(1),
    totalReturn:+(((cap-startCap)/startCap)*100).toFixed(1),
    maxDD:+(Math.min(...monthly.map(m=>m.dd))).toFixed(1),
    avgWin:wins.length?+(wins.reduce((s,m)=>s+m.retPct,0)/wins.length).toFixed(1):0,
    avgLoss:losses.length?+(losses.reduce((s,m)=>s+m.retPct,0)/losses.length).toFixed(1):0,
    bestMonth:+(Math.max(...monthly.map(m=>m.retPct))).toFixed(1),
    worstMonth:+(Math.min(...monthly.map(m=>m.retPct))).toFixed(1),
    finalCap:+cap.toFixed(0),startCap,spyFinal:+spyFinal.toFixed(0)
  }};
}

// ── CHART.JS DEFAULTS ──
Chart.defaults.color='#3d4160';
Chart.defaults.font.family="'IBM Plex Mono',monospace";
Chart.defaults.font.size=9;

let charts={};
function destroyAll(){Object.values(charts).forEach(c=>c&&c.destroy());charts={};}
function gridOpts(){return{color:'rgba(28,31,53,0.8)',drawBorder:false};}
function tickOpts(){return{maxRotation:0,color:'#3d4160'};}

function renderStats(s){
  const grid=document.getElementById('statsGrid');
  const cagrVal=s.cagr!==null?fmt(s.cagr):'N/A';
  const cagrCls=s.cagr!==null&&s.cagr>s.spyCagr?'green':'accent';
  const cards=[
    {label:'Strategy CAGR', value:cagrVal,            sub:`SPY B&H: ${fmt(s.spyCagr)}`,              cls:cagrCls},
    {label:'Win Rate',       value:`${s.winRate}%`,    sub:`${s.wins}W · ${s.losses}L`,               cls:'accent'},
    {label:'Max Drawdown',   value:`${s.maxDD}%`,      sub:'from equity peak',                         cls:'red'},
    {label:'Total Return',   value:fmt(s.totalReturn,0),sub:`${fmtE(s.startCap)} → ${fmtE(s.finalCap)}`, cls:s.totalReturn>0?'green':'red'},
    {label:'Avg Win Month',  value:`+${s.avgWin}%`,   sub:'on margin deployed',                        cls:'green'},
    {label:'Avg Loss Month', value:`${s.avgLoss}%`,   sub:'on margin deployed',                        cls:'red'},
    {label:'Best Month',     value:`+${s.bestMonth}%`,sub:'single month',                              cls:'green'},
    {label:'Worst Month',    value:`${s.worstMonth}%`,sub:'single month',                              cls:'red'},
  ];
  grid.innerHTML=cards.map(c=>`
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
    </div>`).join('');
}

function renderEquity(monthly){
  const ctx=document.getElementById('chartEquity').getContext('2d');
  const showSPY=document.getElementById('spyToggle').checked;
  const ds=[{
    label:'Strategy',
    data:monthly.map(m=>m.cap),
    borderColor:'#f0a500',
    backgroundColor:'rgba(240,165,0,0.06)',
    borderWidth:2,pointRadius:0,fill:true,tension:0.3
  }];
  if(showSPY) ds.push({
    label:'SPY B&H',
    data:monthly.map(m=>m.spyBnH),
    borderColor:'#4fa3e8',borderWidth:1.5,borderDash:[6,3],
    pointRadius:0,fill:false,tension:0.3
  });
  charts.equity=new Chart(ctx,{type:'line',data:{labels:monthly.map(m=>m.date),datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:600},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:true,labels:{color:'#5a5f7a',boxWidth:14,font:{size:9}}},
        tooltip:{backgroundColor:'#111325',borderColor:'#1c1f35',borderWidth:1,
          titleColor:'#3d4160',bodyColor:'#b8bdd4',padding:10,
          callbacks:{label:c=>`  ${c.dataset.label}: ${fmtERaw(c.parsed.y)}`}}
      },
      scales:{
        x:{grid:gridOpts(),ticks:{...tickOpts(),maxTicksLimit:10}},
        y:{grid:gridOpts(),ticks:{...tickOpts(),callback:v=>(v<0?'-€':'€')+Math.abs(Math.round(v/1000))+'k'}}
      }
    }
  });
}

function renderMonthly(monthly){
  const ctx=document.getElementById('chartMonthly').getContext('2d');
  charts.monthly=new Chart(ctx,{type:'bar',
    data:{labels:monthly.map(m=>m.date),datasets:[{
      label:'Monthly Return % (on margin)',
      data:monthly.map(m=>m.retPct),
      backgroundColor:monthly.map(m=>m.win?'rgba(29,218,122,0.75)':'rgba(255,69,96,0.75)'),
      borderWidth:0,borderRadius:1
    }]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{backgroundColor:'#111325',borderColor:'#1c1f35',borderWidth:1,
          titleColor:'#3d4160',bodyColor:'#b8bdd4',padding:10,
          callbacks:{label:(c)=>{
            const m=monthly[c.dataIndex];
            return[`  Return: ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(2)}%`,
              `  P&L: ${fmtERaw(m.dollarPnl)}`,
              `  Contracts: ${m.contracts}  ·  Margin/c: ${fmtERaw(m.margPerCon)}`];
          }}}
      },
      scales:{
        x:{grid:gridOpts(),ticks:{...tickOpts(),maxTicksLimit:12}},
        y:{grid:gridOpts(),ticks:{...tickOpts(),callback:v=>v+'%'},
          afterDataLimits:a=>{a.max=Math.max(a.max,10);a.min=Math.min(a.min,-110);}}
      }
    }
  });
}

function renderAnnual(annual){
  const ctx=document.getElementById('chartAnnual').getContext('2d');
  charts.annual=new Chart(ctx,{type:'bar',
    data:{labels:annual.map(a=>a.year),datasets:[{
      label:'Annual Return %',
      data:annual.map(a=>a.retPct),
      backgroundColor:annual.map(a=>a.retPct>=0?'rgba(29,218,122,0.8)':'rgba(255,69,96,0.8)'),
      borderRadius:3,borderSkipped:false
    }]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{backgroundColor:'#111325',borderColor:'#1c1f35',borderWidth:1,
          titleColor:'#3d4160',bodyColor:'#b8bdd4',padding:10,
          callbacks:{label:c=>[
            `  Return: ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(1)}%`,
            `  P&L: ${fmtERaw(annual[c.dataIndex].pnl)}`,
            `  Win rate: ${annual[c.dataIndex].winRate}% (${annual[c.dataIndex].wins}W·${annual[c.dataIndex].losses}L)`
          ]}}
      },
      scales:{
        x:{grid:gridOpts(),ticks:tickOpts()},
        y:{grid:gridOpts(),ticks:{...tickOpts(),callback:v=>v+'%'}}
      }
    }
  });
}

function renderAnnualGrid(annual){
  document.getElementById('annualGrid').innerHTML=annual.map(a=>`
    <div class="annual-cell">
      <div class="annual-year">${a.year}</div>
      <div class="annual-ret" style="color:${a.retPct>=0?'var(--green)':'var(--red)'}">
        ${a.retPct>=0?'+':''}${a.retPct}%
      </div>
      <div class="annual-wr">${a.winRate}% W</div>
    </div>`).join('');
}

function renderDrawdown(monthly){
  const ctx=document.getElementById('chartDrawdown').getContext('2d');
  charts.drawdown=new Chart(ctx,{type:'line',
    data:{labels:monthly.map(m=>m.date),datasets:[{
      label:'Drawdown from peak %',
      data:monthly.map(m=>m.dd),
      borderColor:'rgba(255,69,96,0.9)',backgroundColor:'rgba(255,69,96,0.07)',
      borderWidth:1.5,pointRadius:0,fill:true,tension:0.2
    }]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{backgroundColor:'#111325',borderColor:'#1c1f35',borderWidth:1,
          titleColor:'#3d4160',bodyColor:'#b8bdd4',padding:10,
          callbacks:{label:c=>`  Drawdown: ${c.parsed.y.toFixed(2)}%`}}
      },
      scales:{
        x:{grid:gridOpts(),ticks:{...tickOpts(),maxTicksLimit:10}},
        y:{grid:gridOpts(),ticks:{...tickOpts(),callback:v=>v+'%'}}
      }
    }
  });
}

function run(){
  const shortOTM=parseFloat(document.getElementById('shortOTM').value)||5;
  const longOTM=parseFloat(document.getElementById('longOTM').value)||8;
  const capital=parseFloat(document.getElementById('capital').value)||10000;
  const rfr=parseFloat(document.getElementById('rfr').value)||4;
  const{monthly,annual,stats}=runBacktest(shortOTM,longOTM,capital,rfr);
  renderStats(stats);
  destroyAll();
  renderEquity(monthly);
  renderMonthly(monthly);
  renderAnnual(annual);
  renderAnnualGrid(annual);
  renderDrawdown(monthly);
}

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const tab=btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-'+tab).classList.add('active');
    document.getElementById('spyToggleWrap').style.display=tab==='equity'?'flex':'none';
    setTimeout(()=>Object.values(charts).forEach(c=>c&&c.resize()),10);
  });
});

document.getElementById('spyToggle').addEventListener('change',()=>{
  if(charts.equity) charts.equity.destroy();
  const shortOTM=parseFloat(document.getElementById('shortOTM').value)||5;
  const longOTM=parseFloat(document.getElementById('longOTM').value)||8;
  const capital=parseFloat(document.getElementById('capital').value)||10000;
  const rfr=parseFloat(document.getElementById('rfr').value)||4;
  const{monthly}=runBacktest(shortOTM,longOTM,capital,rfr);
  renderEquity(monthly);
});

run();
