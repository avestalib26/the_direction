/**
 * Random long/short each trade; TP/SL as % of entry. Same-bar TP+SL → SL first (conservative).
 * Next trade opens at the candle after the exit bar.
 */

/**
 * @param {Array<{ open: number, high: number, low: number, close: number, openTime: number }>} candles oldest → newest
 * @param {{ tpPct: number, slPct: number }} params
 */
export function runCoinTossBacktest(candles, { tpPct, slPct }) {
  const trades = []
  if (!candles?.length || tpPct <= 0 || slPct <= 0) {
    return { trades, summary: emptySummary() }
  }

  let i = 0
  while (i < candles.length) {
    const long = Math.random() < 0.5
    const entry = candles[i].open
    if (!Number.isFinite(entry) || entry === 0) {
      i += 1
      continue
    }

    const tpPx = long
      ? entry * (1 + tpPct / 100)
      : entry * (1 - tpPct / 100)
    const slPx = long
      ? entry * (1 - slPct / 100)
      : entry * (1 + slPct / 100)

    let exitSide = null
    let exitPrice = null
    let exitBar = -1

    for (let j = i; j < candles.length; j++) {
      const { high: h, low: l } = candles[j]
      if (long) {
        const slHit = l <= slPx
        const tpHit = h >= tpPx
        if (slHit && tpHit) {
          exitSide = 'SL'
          exitPrice = slPx
          exitBar = j
          break
        }
        if (slHit) {
          exitSide = 'SL'
          exitPrice = slPx
          exitBar = j
          break
        }
        if (tpHit) {
          exitSide = 'TP'
          exitPrice = tpPx
          exitBar = j
          break
        }
      } else {
        const slHit = h >= slPx
        const tpHit = l <= tpPx
        if (slHit && tpHit) {
          exitSide = 'SL'
          exitPrice = slPx
          exitBar = j
          break
        }
        if (slHit) {
          exitSide = 'SL'
          exitPrice = slPx
          exitBar = j
          break
        }
        if (tpHit) {
          exitSide = 'TP'
          exitPrice = tpPx
          exitBar = j
          break
        }
      }
    }

    if (exitSide == null) {
      const last = candles[candles.length - 1]
      exitSide = 'END'
      exitPrice = last.close
      exitBar = candles.length - 1
    }

    const pnlPct = long
      ? ((exitPrice - entry) / entry) * 100
      : ((entry - exitPrice) / entry) * 100

    trades.push({
      tradeNum: trades.length + 1,
      entryIdx: i,
      exitIdx: exitBar,
      entryTime: candles[i].openTime,
      exitTime: candles[exitBar].openTime,
      direction: long ? 'LONG' : 'SHORT',
      entry,
      exitPrice,
      outcome: exitSide,
      pnlPct,
      barsHeld: exitBar - i + 1,
    })

    i = exitBar + 1
  }

  return { trades, summary: summarizeTrades(trades) }
}

function emptySummary() {
  return {
    count: 0,
    tpHits: 0,
    slHits: 0,
    endHits: 0,
    wins: 0,
    losses: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,
    winRatePct: 0,
  }
}

function summarizeTrades(trades) {
  if (!trades.length) return emptySummary()
  let tpHits = 0
  let slHits = 0
  let endHits = 0
  let wins = 0
  let totalPnl = 0
  for (const t of trades) {
    if (t.outcome === 'TP') tpHits += 1
    else if (t.outcome === 'SL') slHits += 1
    else endHits += 1
    if (t.pnlPct > 0) wins += 1
    totalPnl += t.pnlPct
  }
  return {
    count: trades.length,
    tpHits,
    slHits,
    endHits,
    wins,
    losses: trades.length - wins,
    totalPnlPct: totalPnl,
    avgPnlPct: totalPnl / trades.length,
    winRatePct: (wins / trades.length) * 100,
  }
}
