/**
 * BTC 5M Virtual Trading Bot
 * - Работает 24/7 на сервере
 * - Авто-расписание: 09:00–00:00 МСК
 * - Читает botOn, strategy, skipMode из Firebase
 */

const admin  = require('firebase-admin');
const fetch  = require('node-fetch');
const WebSocket = require('ws');

// ── FIREBASE ──────────────────────────────────────────────────────────
const app = admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db        = admin.database();
const STATE_REF = db.ref('btc5m/main');
const LOG_REF   = db.ref('btc5m/log');

// ── CONSTANTS ─────────────────────────────────────────────────────────
const WIN_MULT  = 0.92;
const ROUND_MS  = 5 * 60 * 1000;
// Расписание МСК (UTC+3): работаем 09:00–00:00
const WORK_START_UTC = 6;  // 09:00 МСК = 06:00 UTC
const WORK_END_UTC   = 21; // 00:00 МСК = 21:00 UTC

// ── STATE ─────────────────────────────────────────────────────────────
let state = null;
let currentPrice = 72000;
let priceChange  = 0;
let priceBuffer  = [];
let wsConnected  = false;
let roundPlaced  = null;

// Settings (синхронизируются из Firebase)
let _strategy = 'fixed';
let _skipMode = true;
let _userBotOn = true; // желание пользователя (botOn из Firebase)

function defaultState() {
  return {
    wallet:  { balance: 100, pnl: 0, wins: 0, losses: 0, totalBet: 0 },
    stats:   { bestStreak: 0, curStreak: 0, totalWin: 0, totalLoss: 0 },
    history: [],
    botOn:   false,
    strategy: 'fixed',
    skipMode: true,
    lastRoundId: null,
    pendingBet:  null,
    savedAt: Date.now(),
  };
}

// ── SCHEDULE CHECK ────────────────────────────────────────────────────
function isWorkingHours() {
  const hourUTC = new Date().getUTCHours();
  // 06:00–21:00 UTC = 09:00–00:00 МСК
  return hourUTC >= WORK_START_UTC && hourUTC < WORK_END_UTC;
}

function shouldBotRun() {
  // Бот работает ТОЛЬКО если:
  // 1. Пользователь нажал Старт (botOn = true)
  // 2. Сейчас рабочие часы по МСК
  return _userBotOn && isWorkingHours();
}

// ── FIREBASE ──────────────────────────────────────────────────────────
async function loadState() {
  try {
    const snap = await STATE_REF.once('value');
    if (snap.exists()) {
      const data = snap.val();
      data.history = (data.history || []).slice(0, 200);
      _userBotOn = data.botOn === true;
      _strategy  = data.strategy  || 'fixed';
      _skipMode  = data.skipMode  !== false;
      console.log(`[STATE] Balance: $${data.wallet?.balance} | botOn: ${_userBotOn} | strategy: ${_strategy} | skip: ${_skipMode}`);
      return data;
    }
  } catch(e) { console.error('[STATE] Load error:', e.message); }
  return defaultState();
}

async function saveState() {
  try {
    state.savedAt  = Date.now();
    state.botOn    = _userBotOn;
    state.strategy = _strategy;
    state.skipMode = _skipMode;
    await STATE_REF.set(state);
  } catch(e) { console.error('[STATE] Save error:', e.message); }
}

async function log(msg) {
  const time = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Europe/Moscow' });
  console.log(`[${time} МСК] ${msg}`);
  try { await LOG_REF.push({ time, msg, ts: Date.now() }); } catch(e) {}
}

// ── ROUND HELPERS ─────────────────────────────────────────────────────
const roundId     = (t) => Math.floor((t || Date.now()) / ROUND_MS) * ROUND_MS;
const roundRemain = ()  => roundId() + ROUND_MS - Date.now();
const fmtWindow   = (rid) => {
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

// ── PRICE FEED ────────────────────────────────────────────────────────
function connectPolymarketWS() {
  try {
    const ws = new WebSocket('wss://ws-live-data.polymarket.com');
    ws.on('open', () => {
      wsConnected = true;
      ws.send(JSON.stringify({ action:'subscribe', subscriptions:[{ topic:'crypto_prices_chainlink', type:'*', filters:JSON.stringify({ symbol:'btc/usd' }) }] }));
      console.log('[WS] Connected to Polymarket Chainlink');
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol === 'btc/usd') {
          const p = parseFloat(msg.payload.value);
          if (p > 0) { currentPrice = p; priceBuffer.push(p); if (priceBuffer.length > 300) priceBuffer.shift(); }
        }
      } catch(e) {}
    });
    ws.on('close', () => { wsConnected = false; setTimeout(connectPolymarketWS, 5000); });
    ws.on('error', (e) => { wsConnected = false; console.error('[WS]', e.message); });
  } catch(e) { setTimeout(connectPolymarketWS, 10000); }
}

async function fetchPriceFallback() {
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', { timeout:5000 });
    const d = await r.json();
    const t = d.result?.list?.[0];
    if (t) { currentPrice = parseFloat(t.lastPrice); priceBuffer.push(currentPrice); if (priceBuffer.length > 300) priceBuffer.shift(); }
  } catch(e) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout:5000 });
      const d = await r.json();
      if (d.bitcoin?.usd) { currentPrice = d.bitcoin.usd; priceBuffer.push(currentPrice); }
    } catch(e2) {}
  }
}

async function fetchKlines() {
  if (priceBuffer.length >= 30) {
    const buf = priceBuffer.slice(-60);
    const chunkSize = Math.max(1, Math.floor(buf.length / 10));
    const candles = [];
    for (let i = 0; i < 10; i++) {
      const chunk = buf.slice(i * chunkSize, (i+1) * chunkSize);
      if (!chunk.length) continue;
      candles.push({ o:chunk[0], h:Math.max(...chunk), l:Math.min(...chunk), c:chunk[chunk.length-1], v:chunk.length });
    }
    if (candles.length >= 5) return candles;
  }
  try {
    const r = await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=10', { timeout:5000 });
    const d = await r.json();
    return (d.result?.list||[]).reverse().map(k=>({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
  } catch(e) { return []; }
}

// ── POLYMARKET SENTIMENT ──────────────────────────────────────────────
let pmUpProb = 0.5, pmDownProb = 0.5, pmLastFetch = 0;

async function fetchPolymarketSentiment() {
  if (Date.now() - pmLastFetch < 60000) return;
  try {
    const nowSec = Math.floor(Date.now()/1000);
    const slug   = `btc-updown-5m-${nowSec - (nowSec % 300)}`;
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout:4000 });
    if (!r.ok) throw 0;
    const data   = await r.json();
    const market = data?.[0]?.markets?.[0];
    if (!market) throw 0;
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    pmUpProb = parseFloat(prices[0]) || 0.5;
    pmDownProb = parseFloat(prices[1]) || 0.5;
    pmLastFetch = Date.now();
    console.log(`[PM] UP ${(pmUpProb*100).toFixed(0)}% / DOWN ${(pmDownProb*100).toFixed(0)}%`);
  } catch(e) {}
}

// ── AI SIGNAL ─────────────────────────────────────────────────────────
function calcBetSize(conf, balance) {
  if (_strategy === 'pct') {
    let pct = conf<60?0.03:conf<67?0.05:conf<75?0.07:conf<82?0.09:0.10;
    return Math.max(2, parseFloat((balance * pct).toFixed(2)));
  } else {
    return conf<60?3:conf<67?5:conf<75?7:conf<82?10:12;
  }
}

function aiSignal(klines) {
  if (klines.length < 3) return { direction:'UP', confidence:52, reason:'Нет данных', score:0, skip:true, betSize:0 };

  const n=klines.length, c=klines.map(k=>k.c), o=klines.map(k=>k.o),
        h=klines.map(k=>k.h), l=klines.map(k=>k.l), v=klines.map(k=>k.v);
  let score=0; const signals=[];

  // 1. Тренд
  const rA=(c[n-1]+c[n-2]+c[n-3])/3, eA=(c[0]+c[1]+c[2])/3;
  if(rA>eA*1.001){score+=2.5;signals.push('Тренд▲');}
  else if(rA<eA*0.999){score-=2.5;signals.push('Тренд▼');}
  else signals.push('Флет');

  // 2. Тело свечи
  const lb=c[n-1]-o[n-1], lr=h[n-1]-l[n-1], br=lr>0?Math.abs(lb)/lr:0;
  if(lb>0&&br>0.6){score+=2;signals.push('BullCandle');}
  else if(lb<0&&br>0.6){score-=2;signals.push('BearCandle');}

  // 3. Моментум
  let bR=0,beR=0;
  for(let i=n-3;i<n;i++){if(c[i]>o[i])bR++;else beR++;}
  if(bR===3){score+=2.5;signals.push('3×Bull');}
  if(beR===3){score-=2.5;signals.push('3×Bear');}

  // 4. Объём
  const avgV=v.slice(0,-1).reduce((a,b)=>a+b,0)/(n-1);
  if(v[n-1]>avgV*1.5){const s=lb>0?1.5:-1.5;score+=s;signals.push('VolSpike');}

  // 5. Разворот
  const avgR=h.map((x,i)=>x-l[i]).reduce((a,b)=>a+b,0)/n;
  if(lr>avgR*2.5){score*=0.3;signals.push('Reversal');}

  // 6. RSI
  const gains=[],losses=[];
  for(let i=1;i<n;i++){const d=c[i]-c[i-1];if(d>0)gains.push(d);else losses.push(Math.abs(d));}
  const aG=gains.length?gains.reduce((a,b)=>a+b,0)/gains.length:0;
  const aL=losses.length?losses.reduce((a,b)=>a+b,0)/losses.length:.001;
  const rsi=100-100/(1+aG/aL);
  if(rsi>72){score-=2;signals.push(`RSI${rsi.toFixed(0)}OB`);}
  else if(rsi<28){score+=2;signals.push(`RSI${rsi.toFixed(0)}OS`);}

  // 7. Polymarket Sentiment
  if(pmUpProb!==0.5){
    if(pmUpProb>=0.65){score+=4;signals.push(`PM▲${(pmUpProb*100).toFixed(0)}%`);}
    else if(pmUpProb<=0.35){score-=4;signals.push(`PM▼${(pmDownProb*100).toFixed(0)}%`);}
    else if(pmUpProb>=0.57){score+=2;signals.push(`PM▲${(pmUpProb*100).toFixed(0)}%`);}
    else if(pmUpProb<=0.43){score-=2;signals.push(`PM▼${(pmDownProb*100).toFixed(0)}%`);}
  }

  // 8. Консенсус
  const bullC=signals.filter(s=>s.includes('▲')||s.includes('Bull')||s.includes('OS')).length;
  const bearC=signals.filter(s=>s.includes('▼')||s.includes('Bear')||s.includes('OB')).length;
  if(bullC>=4&&bearC===0){score+=2;signals.push('Консенсус▲');}
  if(bearC>=4&&bullC===0){score-=2;signals.push('Консенсус▼');}

  const absScore=Math.abs(score);
  const skip = _skipMode && absScore < 3.5;
  const dir  = score>=0?'UP':'DOWN';
  const conf = Math.min(87, Math.max(52, 52+absScore*4));
  const betSize = skip ? 0 : calcBetSize(conf, state.wallet.balance);

  const pmStr = pmUpProb!==0.5?` | PM:▲${(pmUpProb*100).toFixed(0)}%`:'';
  const reason = `Скор:${score.toFixed(1)} RSI:${rsi.toFixed(0)}${pmStr} | ${signals.join(',')} | ${dir} ${conf.toFixed(0)}%${skip?' | ⚠ПРОПУСК':''}`;

  return { direction:dir, confidence:conf, signals, reason, score, skip, betSize };
}

// ── BOT LOGIC ─────────────────────────────────────────────────────────
async function placeBet(rid) {
  if (roundPlaced === rid) return;
  if (!shouldBotRun()) return;
  if (state.wallet.balance < 2) {
    await log('❌ Баланс недостаточен');
    _userBotOn = false;
    await saveState();
    return;
  }

  roundPlaced = rid;
  if (!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();
  const klines = await fetchKlines();
  const sig = aiSignal(klines);

  if (sig.skip) {
    await log(`⏭ ПРОПУСК ${fmtWindow(rid)} | скор:${sig.score.toFixed(1)}`);
    state.history.unshift({
      id:rid, direction:sig.direction, confidence:sig.confidence, reason:sig.reason,
      betAmount:0, startPrice:currentPrice, endPrice:null, window:fmtWindow(rid),
      result:'skip', pnl:0, balanceAfter:state.wallet.balance,
      ts:new Date().toISOString(), sim:false,
    });
    if (state.history.length > 200) state.history = state.history.slice(0,200);
    state.lastRoundId = rid;
    await saveState();
    return;
  }

  const betAmount = sig.betSize;
  state.wallet.balance  = parseFloat((state.wallet.balance - betAmount).toFixed(2));
  state.wallet.totalBet += betAmount;
  state.lastRoundId = rid;

  state.pendingBet = {
    id:rid, direction:sig.direction, confidence:sig.confidence, reason:sig.reason,
    betAmount, startPrice:currentPrice, endPrice:null,
    window:fmtWindow(rid), result:'pending', pnl:0,
    ts:new Date().toISOString(), sim:false,
  };

  await saveState();
  await log(`🎯 ${sig.direction} $${betAmount} @ $${Math.round(currentPrice)} | ${fmtWindow(rid)} | ${sig.confidence.toFixed(0)}% | стратегия:${_strategy} | пропуск:${_skipMode}`);
}

async function resolveBet() {
  const bet = state.pendingBet;
  if (!bet || bet.result !== 'pending') return;
  if (!wsConnected) await fetchPriceFallback();
  bet.endPrice = currentPrice;
  const up  = bet.endPrice >= bet.startPrice;
  const won = (bet.direction==='UP'&&up) || (bet.direction==='DOWN'&&!up);
  if (won) {
    const p = parseFloat((bet.betAmount*WIN_MULT).toFixed(2));
    state.wallet.balance = parseFloat((state.wallet.balance+bet.betAmount+p).toFixed(2));
    state.wallet.pnl     = parseFloat((state.wallet.pnl+p).toFixed(2));
    state.wallet.wins++;
    state.stats.curStreak++;
    state.stats.totalWin += p;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result='win'; bet.pnl=p;
    await log(`✅ WIN +$${p.toFixed(2)} | Баланс: $${state.wallet.balance.toFixed(2)}`);
  } else {
    state.wallet.pnl     = parseFloat((state.wallet.pnl-bet.betAmount).toFixed(2));
    state.wallet.losses++;
    state.stats.curStreak = 0;
    state.stats.totalLoss += bet.betAmount;
    bet.result='loss'; bet.pnl=-bet.betAmount;
    await log(`❌ LOSS -$${bet.betAmount} | Баланс: $${state.wallet.balance.toFixed(2)}`);
  }
  bet.balanceAfter = state.wallet.balance;
  state.history.unshift({...bet});
  if (state.history.length > 200) state.history = state.history.slice(0,200);
  state.pendingBet = null;
  await saveState();
  if (state.wallet.balance < 2) { _userBotOn=false; await saveState(); }
}

// ── SCHEDULE CHECK LOOP ───────────────────────────────────────────────
let _wasWorkingHours = null;

async function checkSchedule() {
  const working = isWorkingHours();
  if (working === _wasWorkingHours) return; // no change
  _wasWorkingHours = working;

  const hourMSK = (new Date().getUTCHours() + 3) % 24;
  if (working) {
    if (_userBotOn) {
      await log(`⏰ Рабочие часы начались (${hourMSK}:00 МСК) — бот активируется`);
      // Update Firebase so UI shows correct status
      await STATE_REF.child('scheduleActive').set(true);
    }
  } else {
    await log(`🌙 Ночное время (${hourMSK}:00 МСК) — бот приостановлен до 09:00 МСК`);
    await STATE_REF.child('scheduleActive').set(false);
    // Resolve any pending bet before stopping
    if (state.pendingBet?.result === 'pending') await resolveBet();
  }
}

// ── MAIN TICK ─────────────────────────────────────────────────────────
async function tick() {
  if (!state) return;
  await checkSchedule();

  const rid = roundId();
  const rem = roundRemain();

  // Resolve at end of round
  if (rem < 8000 && state.pendingBet?.result==='pending' && state.pendingBet?.id===rid) {
    await resolveBet();
  }

  // Place bet at start of round (only if should run)
  if (rem > ROUND_MS - 20000 && shouldBotRun()) {
    await placeBet(rid);
  }

  if (!wsConnected && Date.now() % 30000 < 5000) await fetchPriceFallback();
}

// ── FIREBASE LISTENERS ────────────────────────────────────────────────
function listenForCommands() {
  // botOn — желание пользователя
  STATE_REF.child('botOn').on('value', async (snap) => {
    const val = snap.val();
    if (typeof val === 'boolean' && val !== _userBotOn) {
      _userBotOn = val;
      await log(_userBotOn ? '▶ Пользователь запустил бота' : '■ Пользователь остановил бота');
      if (!_userBotOn && state.pendingBet?.result==='pending') await resolveBet();
    }
  });

  // strategy
  STATE_REF.child('strategy').on('value', (snap) => {
    const val = snap.val();
    if (val && val !== _strategy) { _strategy = val; console.log('[CONFIG] Strategy:', _strategy); }
  });

  // skipMode
  STATE_REF.child('skipMode').on('value', (snap) => {
    const val = snap.val();
    if (val !== null && val !== _skipMode) { _skipMode = val; console.log('[CONFIG] SkipMode:', _skipMode); }
  });

  // reset command
  db.ref('btc5m/command').on('value', async (snap) => {
    const cmd = snap.val();
    if (cmd === 'reset') {
      state = defaultState();
      roundPlaced = null;
      await saveState();
      await db.ref('btc5m/command').remove();
      await log('↺ Сброс — баланс $100');
    }
  });
}

// ── START ─────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 5M Bot starting...');
  state = await loadState();
  if (!state) { console.error('Firebase load failed'); process.exit(1); }
  connectPolymarketWS();
  listenForCommands();
  // Main loop
  setInterval(tick, 5000);
  // Heartbeat
  setInterval(async () => {
    try {
      await db.ref('btc5m/heartbeat').set({
        ts: Date.now(),
        working: isWorkingHours(),
        hourMSK: (new Date().getUTCHours() + 3) % 24,
        userBotOn: _userBotOn,
        shouldRun: shouldBotRun(),
      });
    } catch(e) {}
  }, 30000);

  const hourMSK = (new Date().getUTCHours() + 3) % 24;
  await log(`🚀 Бот запущен | Баланс: $${state.wallet.balance} | ${hourMSK}:XX МСК | Расписание: 09:00–00:00 МСК`);
  await tick();
}

start().catch(e => { console.error('Fatal:', e); process.exit(1); });
