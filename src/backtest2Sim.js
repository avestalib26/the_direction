/**
 * Coin-toss long/short with TP/SL (same bar rules as Backtest 1), with martingale sizing on
 * notional: stake starts at 1× base notional; after a loss, stake × multiplier; after a win, reset to 1.
 *
 * Dollar PnL per trade: notionalUsd × (PnL% / 100), where notionalUsd = (marginUsd × leverage) × stake.
 *
 * @param {Array<{ open: number, high: number, low: number, close: number, openTime: number }>} candles oldest → newest
 * @param {{ tpPct: number, slPct: number, martingaleMultiplier: number, startMarginUsd?: number, leverage?: number, directionMode?: 'random' | 'long' | 'short' }} params
 */

export const DEFAULT_MARGIN_USD = 50
export const DEFAULT_LEVERAGE = 20

/** @param {'random' | 'long' | 'short'} mode */
function pickLong(mode) {
  const m = String(mode ?? 'random').toLowerCase()
  if (m === 'long') return true
  if (m === 'short') return false
  return Math.random() < 0.5
}

export function runMartingaleBacktest(candles, {
  tpPct,
  slPct,
  martingaleMultiplier,
  startMarginUsd = DEFAULT_MARGIN_USD,
  leverage = DEFAULT_LEVERAGE,
  directionMode = 'random',
}) {
  const trades = []
  const mult =
    Number.isFinite(martingaleMultiplier) && martingaleMultiplier >= 1
      ? martingaleMultiplier
      : 2

  const marginUsd =
    Number.isFinite(startMarginUsd) && startMarginUsd > 0
      ? startMarginUsd
      : DEFAULT_MARGIN_USD
  const lev =
    Number.isFinite(leverage) && leverage > 0 ? leverage : DEFAULT_LEVERAGE
  const baseNotionalUsd = marginUsd * lev

  if (!candles?.length || tpPct <= 0 || slPct <= 0) {
    return {
      trades,
      summary: emptySummary({ marginUsd, leverage, baseNotionalUsd }),
    }
  }

  let i = 0
  let stake = 1
  let maxStake = 1

  while (i < candles.length) {
    const long = pickLong(directionMode)
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

    const notionalUsd = baseNotionalUsd * stake
    const pnlUsd = notionalUsd * (pnlPct / 100)

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
      stake,
      notionalUsd,
      pnlUsd,
    })

    if (pnlPct > 0) {
      stake = 1
    } else {
      stake *= mult
    }
    if (stake > maxStake) maxStake = stake

    i = exitBar + 1
  }

  return {
    trades,
    summary: summarizeMartingale(trades, maxStake, {
      marginUsd,
      leverage,
      baseNotionalUsd,
    }),
  }
}

function emptySummary({ marginUsd, leverage, baseNotionalUsd } = {}) {
  const m = marginUsd ?? DEFAULT_MARGIN_USD
  const l = leverage ?? DEFAULT_LEVERAGE
  const b = baseNotionalUsd ?? m * l
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
    totalPnlUsd: 0,
    avgPnlUsd: 0,
    maxStake: 1,
    maxNotionalUsd: b,
    marginUsd: m,
    leverage: l,
    baseNotionalUsd: b,
  }
}

function summarizeMartingale(trades, maxStake, sizing) {
  const { marginUsd, leverage, baseNotionalUsd } = sizing
  if (!trades.length) {
    return emptySummary({ marginUsd, leverage, baseNotionalUsd })
  }
  let tpHits = 0
  let slHits = 0
  let endHits = 0
  let wins = 0
  let totalPnl = 0
  let totalPnlUsd = 0
  for (const t of trades) {
    if (t.outcome === 'TP') tpHits += 1
    else if (t.outcome === 'SL') slHits += 1
    else endHits += 1
    if (t.pnlPct > 0) wins += 1
    totalPnl += t.pnlPct
    totalPnlUsd += t.pnlUsd
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
    totalPnlUsd,
    avgPnlUsd: totalPnlUsd / trades.length,
    maxStake,
    maxNotionalUsd: maxStake * baseNotionalUsd,
    marginUsd,
    leverage,
    baseNotionalUsd,
  }
}
