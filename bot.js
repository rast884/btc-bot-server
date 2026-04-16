/**
 * BTC 5M Virtual Trading Bot
 * Работает 24/7 на сервере, данные пишет в Firebase
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');
const WebSocket = require('ws');

// ── FIREBASE CONFIG ────────────────────────────────────────────────────
const firebaseConfig = {
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

admin.initializeApp(firebaseConfig);
const db = admin.database();
const STATE_REF = db.ref('btc5m/main');
const LOG_REF   = db.ref('btc5m/log');

// ── CONSTANTS ──────────────────────────────────────────────────────────
const BET_DEFAULT = 5;
const WIN_MULT    = 0.92;
const ROUND_MS    = 5 * 60 * 1000;

// ── STATE ──────────────────────────────────────────────────────────────
let state = null;
let currentPrice  = 72000;
let priceChange   = 0;
let priceBuffer   = []; // тики для AI анализа
let wsConnected   = false;
let roundPlaced   = null;

function defaultState() {
  return {
    wallet:  { balance: 100, pnl: 0, wins: 0, losses: 0, totalBet: 0 },
    stats:   { bestStreak: 0, curStreak: 0, totalWin: 0, totalLoss: 0 },
    history: [],
    botOn:   true,
    lastRoundId: null,
    pendingBet:  null,
    savedAt: Date.now(),
  };
}

// ── FIREBASE SAVE/LOAD ─────────────────────────────────────────────────
async function loadState() {
  try {
    const snap = await STATE_REF.once('value');
    if (snap.exists()) {
      const data = snap.val();
      data.history = (data.history || []).slice(0, 200);
      console.log(`[STATE] Loaded from Firebase. Balance: $${data.wallet?.balance}`);
      return data;
    }
  } catch (e) {
    console.error('[STATE] Load error:', e.message);
  }
  console.log('[STATE] No state found, using default');
  return defaultState();
}

async function saveState() {
  try {
    state.savedAt = Date.now();
    await STATE_REF.set(state);
  } catch (e) {
    console.error('[STATE] Save error:', e.message);
  }
}

async function log(msg) {
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${time}] ${msg}`);
  try {
    await LOG_REF.push({ time, msg, ts: Date.now() });
  } catch(e) {}
}

// ── ROUND HELPERS ──────────────────────────────────────────────────────
const roundId    = (t) => Math.floor((t || Date.now()) / ROUND_MS) * ROUND_MS;
const roundRemain= () => roundId() + ROUND_MS - Date.now();
const fmtWindow  = (rid) => {
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

// ── PRICE FEED ─────────────────────────────────────────────────────────
function connectPolymarketWS() {
  try {
    const ws = new WebSocket('wss://ws-live-data.polymarket.com');

    ws.on('open', () => {
      wsConnected = true;
      ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: 'btc/usd' }) }]
      }));
      console.log('[WS] Connected to Polymarket Chainlink feed');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol === 'btc/usd') {
          const price = parseFloat(msg.payload.value);
          if (price > 0) {
            currentPrice = price;
            priceBuffer.push(price);
            if (priceBuffer.length > 300) priceBuffer.shift();
          }
        }
      } catch(e) {}
    });

    ws.on('close', () => {
      wsConnected = false;
      console.log('[WS] Disconnected, reconnecting in 5s...');
      setTimeout(connectPolymarketWS, 5000);
    });

    ws.on('error', (e) => {
      wsConnected = false;
      console.error('[WS] Error:', e.message);
    });

  } catch(e) {
    console.error('[WS] Failed to connect:', e.message);
    setTimeout(connectPolymarketWS, 10000);
  }
}

async function fetchPriceFallback() {
  // Bybit
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', { timeout: 5000 });
    const d = await r.json();
    const t = d.result?.list?.[0];
    if (t) {
      currentPrice = parseFloat(t.lastPrice);
      priceChange  = parseFloat(t.price24hPcnt) * 100;
      priceBuffer.push(currentPrice);
      if (priceBuffer.length > 300) priceBuffer.shift();
      return currentPrice;
    }
  } catch(e) {}
  // CoinGecko
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', { timeout: 5000 });
    const d = await r.json();
    if (d.bitcoin?.usd) {
      currentPrice = d.bitcoin.usd;
      priceChange  = d.bitcoin.usd_24h_change || 0;
      priceBuffer.push(currentPrice);
      if (priceBuffer.length > 300) priceBuffer.shift();
      return currentPrice;
    }
  } catch(e) {}
  return currentPrice;
}

async function fetchKlines() {
  // Из буфера тиков WebSocket
  if (priceBuffer.length >= 30) {
    const buf = priceBuffer.slice(-60);
    const chunkSize = Math.max(1, Math.floor(buf.length / 10));
    const candles = [];
    for (let i = 0; i < 10; i++) {
      const chunk = buf.slice(i * chunkSize, (i + 1) * chunkSize);
      if (!chunk.length) continue;
      candles.push({
        o: chunk[0], h: Math.max(...chunk), l: Math.min(...chunk),
        c: chunk[chunk.length - 1], v: chunk.length
      });
    }
    if (candles.length >= 5) return candles;
  }
  // Bybit klines
  try {
    const r = await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=10', { timeout: 5000 });
    const d = await r.json();
    return (d.result?.list || []).reverse().map(k => ({
      o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    }));
  } catch(e) {}
  return [];
}

// ── POLYMARKET SENTIMENT ───────────────────────────────────────────────
let pmUpProb = 0.5, pmDownProb = 0.5, pmLastFetch = 0;

async function fetchPolymarketSentiment() {
  if (Date.now() - pmLastFetch < 60000) return;
  try {
    const nowSec  = Math.floor(Date.now() / 1000);
    const winTs   = nowSec - (nowSec % 300);
    const slug    = `btc-updown-5m-${winTs}`;
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout: 4000 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const market = data?.[0]?.markets?.[0];
    if (!market) throw new Error('No market data');
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    pmUpProb   = parseFloat(prices[0]) || 0.5;
    pmDownProb = parseFloat(prices[1]) || 0.5;
    pmLastFetch = Date.now();
    console.log(`[PM] Sentiment: UP ${(pmUpProb*100).toFixed(0)}% / DOWN ${(pmDownProb*100).toFixed(0)}%`);
  } catch(e) {
    // Keep previous values
  }
}

// ── AI SIGNAL ──────────────────────────────────────────────────────────
function aiSignal(klines) {
  if (klines.length < 3) {
    return { direction: 'UP', confidence: 52, reason: 'Нет данных свечей', score: 0, skip: true, betSize: 0 };
  }

  const n = klines.length;
  const c = klines.map(k => k.c), o = klines.map(k => k.o);
  const h = klines.map(k => k.h), l = klines.map(k => k.l);
  const v = klines.map(k => k.v);
  let score = 0;
  const signals = [];

  // 1. Тренд
  const rA = (c[n-1]+c[n-2]+c[n-3])/3, eA = (c[0]+c[1]+c[2])/3;
  if (rA > eA*1.0005)       { score += 2;   signals.push('Тренд▲'); }
  else if (rA < eA*0.9995)  { score -= 2;   signals.push('Тренд▼'); }
  else                        signals.push('Флет');

  // 2. Тело свечи
  const lb = c[n-1]-o[n-1], lr = h[n-1]-l[n-1], br = lr>0 ? Math.abs(lb)/lr : 0;
  if (lb>0 && br>0.5)        { score += 1.5; signals.push('BullCandle'); }
  else if (lb<0 && br>0.5)   { score -= 1.5; signals.push('BearCandle'); }

  // 3. Моментум
  let bR=0, beR=0;
  for (let i=n-3; i<n; i++) { if(c[i]>o[i]) bR++; else beR++; }
  if (bR===3)   { score += 2; signals.push('3×Bull'); }
  if (beR===3)  { score -= 2; signals.push('3×Bear'); }

  // 4. Объём
  const avgV = v.slice(0,-1).reduce((a,b)=>a+b,0) / (n-1);
  if (v[n-1] > avgV*1.4) {
    const s = lb>0 ? 1 : -1;
    score += s; signals.push('VolSpike');
  }

  // 5. Разворот
  const avgR = h.map((x,i)=>x-l[i]).reduce((a,b)=>a+b,0) / n;
  if (lr > avgR*2) { score *= 0.4; signals.push('Reversal'); }

  // 6. RSI
  const gains=[], losses=[];
  for (let i=1; i<n; i++) {
    const d = c[i]-c[i-1];
    if (d>0) gains.push(d); else losses.push(Math.abs(d));
  }
  const aG = gains.length  ? gains.reduce((a,b)=>a+b,0)/gains.length   : 0;
  const aL = losses.length ? losses.reduce((a,b)=>a+b,0)/losses.length : 0.001;
  const rsi = 100 - 100/(1+aG/aL);
  if (rsi>70)      { score -= 1.5; signals.push(`RSI${rsi.toFixed(0)}OB`); }
  else if (rsi<30) { score += 1.5; signals.push(`RSI${rsi.toFixed(0)}OS`); }

  // 7. Polymarket Sentiment
  if (pmUpProb !== 0.5) {
    if      (pmUpProb >= 0.62) { score += 3;   signals.push(`PM_UP${(pmUpProb*100).toFixed(0)}%`); }
    else if (pmUpProb <= 0.38) { score -= 3;   signals.push(`PM_DOWN${(pmDownProb*100).toFixed(0)}%`); }
    else if (pmUpProb >= 0.55) { score += 1.5; signals.push(`PM_UP${(pmUpProb*100).toFixed(0)}%`); }
    else if (pmUpProb <= 0.45) { score -= 1.5; signals.push(`PM_DOWN${(pmDownProb*100).toFixed(0)}%`); }
  }

  // 8. Время суток (UTC)
  const hourUTC = new Date().getUTCHours();
  const isActive = hourUTC >= 7 && hourUTC <= 21;
  if (!isActive) { score *= 0.5; signals.push('NightSession'); }

  const absScore = Math.abs(score);
  const skip     = absScore < 2.5;
  const dir      = score >= 0 ? 'UP' : 'DOWN';
  const conf     = Math.min(85, Math.max(52, 52 + absScore * 4.5));

  let betSize = 0;
  if (!skip) {
    if      (conf < 60) betSize = 3;
    else if (conf < 70) betSize = 5;
    else if (conf < 78) betSize = 7;
    else                betSize = 10;
    betSize = Math.min(betSize, parseFloat((state.wallet.balance * 0.15).toFixed(2)));
  }

  const pmStr = pmUpProb !== 0.5
    ? ` | PM: UP ${(pmUpProb*100).toFixed(0)}%`
    : '';
  const reason = `Скор: ${score.toFixed(1)} | RSI: ${rsi.toFixed(0)}${pmStr} | ${signals.join(', ')} | ${dir} · ${conf.toFixed(0)}%${skip?' | ⚠ ПРОПУСК':''}`;

  return { direction: dir, confidence: conf, signals, reason, score, skip, betSize };
}

// ── BOT LOGIC ──────────────────────────────────────────────────────────
async function placeBet(rid) {
  if (roundPlaced === rid) return;
  if (!state.botOn) return;
  if (state.wallet.balance < 3) {
    await log('❌ Баланс недостаточен, бот остановлен');
    state.botOn = false;
    await saveState();
    return;
  }

  roundPlaced = rid;
  if (!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();
  const klines = await fetchKlines();
  const sig = aiSignal(klines);

  if (sig.skip) {
    await log(`⏭ ПРОПУСК раунда ${fmtWindow(rid)} — скор ${sig.score.toFixed(1)}`);
    return;
  }

  const betAmount = sig.betSize;
  state.wallet.balance  = parseFloat((state.wallet.balance - betAmount).toFixed(2));
  state.wallet.totalBet += betAmount;
  state.lastRoundId = rid;

  state.pendingBet = {
    id: rid,
    direction:  sig.direction,
    confidence: sig.confidence,
    reason:     sig.reason,
    betAmount,
    startPrice: currentPrice,
    endPrice:   null,
    window:     fmtWindow(rid),
    result:     'pending',
    pnl:        0,
    ts:         new Date().toISOString(),
    sim:        false,
  };

  await saveState();
  await log(`🎯 СТАВКА ${sig.direction} $${betAmount} @ $${Math.round(currentPrice)} | ${sig.window} | Conf:${sig.confidence.toFixed(0)}%`);
}

async function resolveBet() {
  const bet = state.pendingBet;
  if (!bet || bet.result !== 'pending') return;

  if (!wsConnected) await fetchPriceFallback();
  bet.endPrice = currentPrice;

  const priceWentUp = bet.endPrice >= bet.startPrice;
  const won = (bet.direction === 'UP' && priceWentUp) || (bet.direction === 'DOWN' && !priceWentUp);

  if (won) {
    const profit = parseFloat((bet.betAmount * WIN_MULT).toFixed(2));
    state.wallet.balance  = parseFloat((state.wallet.balance + bet.betAmount + profit).toFixed(2));
    state.wallet.pnl      = parseFloat((state.wallet.pnl + profit).toFixed(2));
    state.wallet.wins++;
    state.stats.curStreak++;
    state.stats.totalWin += profit;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result = 'win';
    bet.pnl    = profit;
    await log(`✅ WIN +$${profit.toFixed(2)} | Баланс: $${state.wallet.balance.toFixed(2)} | $${Math.round(bet.startPrice)}→$${Math.round(bet.endPrice)}`);
  } else {
    state.wallet.pnl      = parseFloat((state.wallet.pnl - bet.betAmount).toFixed(2));
    state.wallet.losses++;
    state.stats.curStreak = 0;
    state.stats.totalLoss += bet.betAmount;
    bet.result = 'loss';
    bet.pnl    = -bet.betAmount;
    await log(`❌ LOSS -$${bet.betAmount} | Баланс: $${state.wallet.balance.toFixed(2)} | $${Math.round(bet.startPrice)}→$${Math.round(bet.endPrice)}`);
  }

  state.history.unshift({ ...bet });
  if (state.history.length > 200) state.history = state.history.slice(0, 200);
  state.pendingBet = null;
  await saveState();
}

// ── MAIN LOOP ──────────────────────────────────────────────────────────
async function tick() {
  if (!state || !state.botOn) return;

  const rid = roundId();
  const rem = roundRemain();

  // Резолвим ставку за 8 секунд до конца раунда
  if (rem < 8000 && state.pendingBet?.result === 'pending' && state.pendingBet?.id === rid) {
    await resolveBet();
  }

  // Ставим в первые 20 секунд раунда
  if (rem > ROUND_MS - 20000) {
    await placeBet(rid);
  }

  // Обновляем цену из fallback если WS не работает
  if (!wsConnected && Date.now() % 30000 < 5000) {
    await fetchPriceFallback();
  }
}

// ── LISTEN FOR COMMANDS FROM FIREBASE ─────────────────────────────────
function listenForCommands() {
  // Слушаем изменение botOn из браузера
  STATE_REF.child('botOn').on('value', async (snap) => {
    const val = snap.val();
    if (state && typeof val === 'boolean' && val !== state.botOn) {
      state.botOn = val;
      await log(val ? '▶ Бот запущен' : '■ Бот остановлен');
    }
  });

  // Слушаем команду reset
  db.ref('btc5m/command').on('value', async (snap) => {
    const cmd = snap.val();
    if (cmd === 'reset') {
      state = defaultState();
      roundPlaced = null;
      await saveState();
      await db.ref('btc5m/command').remove();
      await log('↺ Сброс выполнен — баланс $100');
    }
  });
}

// ── START ──────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 5M Bot starting...');

  // Загружаем состояние из Firebase
  state = await loadState();

  // Проверяем что Firebase работает
  if (!state) {
    console.error('Failed to load state from Firebase');
    process.exit(1);
  }

  // Подключаемся к Polymarket WebSocket
  connectPolymarketWS();

  // Слушаем команды из браузера
  listenForCommands();

  await log('🚀 Бот запущен | Баланс: $' + state.wallet.balance);

  // Основной цикл каждые 5 секунд
  setInterval(tick, 5000);

  // Пинг в Firebase каждую минуту (heartbeat)
  setInterval(async () => {
    try {
      await db.ref('btc5m/heartbeat').set(Date.now());
    } catch(e) {}
  }, 60000);
}

start().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
