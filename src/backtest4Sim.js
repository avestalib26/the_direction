/**
 * Long: enter at a candle open. TP/SL % are fixed from entry; we scan forward candle
 * by candle (high/low) until TP or SL hits. No exit at an arbitrary candle close.
 * If data ends before either level touches, exit at last close (reason END).
 * Margin scales as baseMargin × multiplier^consecutiveLosses.
 * After `resetStage` consecutive losses, streak resets to 0 (next trade = base margin).
 */

export const DEFAULT_BASE_MARGIN_USD = 50
export const DEFAULT_LEVERAGE = 20
export const DEFAULT_MARTINGALE_MULT = 2
export const DEFAULT_RESET_STAGE = 4
export const DEFAULT_TAKE_PROFIT_PCT = 5
export const DEFAULT_STOP_LOSS_PCT = 5

/**
 * @param {Array<{ open: number, high?: number, low?: number, close: number, openTime: number }>} candles oldest → newest
 * @param {{
 *   baseMarginUsd?: number,
 *   leverage?: number,
 *   martingaleMultiplier?: number,
 *   resetStage?: number,
 *   takeProfitPct?: number,
 *   stopLossPct?: number,
 *   side?: 'long' | 'short',
 * }} opts
 */
export function runMartingaleBacktest(candles, opts = {}) {
  const baseMargin = pickPositive(opts.baseMarginUsd, DEFAULT_BASE_MARGIN_USD)
  const lev = pickPositive(opts.leverage, DEFAULT_LEVERAGE)
  const mult = pickMult(opts.martingaleMultiplier, DEFAULT_MARTINGALE_MULT)
  const resetStage = pickResetStage(opts.resetStage, DEFAULT_RESET_STAGE)
  const tpPct = pickPct(opts.takeProfitPct, DEFAULT_TAKE_PROFIT_PCT)
  const slPct = pickPct(opts.stopLossPct, DEFAULT_STOP_LOSS_PCT)
  const side = pickSide(opts.side)
  const hitOnBar =
    side === 'short' ? resolveShortHitOnBar : resolveLongHitOnBar

  if (!Array.isArray(candles) || candles.length === 0) {
    return { trades: [], summary: emptySummary() }
  }

  const trades = []
  let consecutiveLosses = 0
  let cumulativePnlUsd = 0
  let equity = 0
  let peak = 0
  let maxDrawdownUsd = 0
  let streakResets = 0
  let wins = 0
  let losses = 0
  let maxMarginUsd = 0
  let tpHits = 0
  let slHits = 0
  let endHits = 0

  let i = 0
  while (i < candles.length) {
    const k0 = candles[i]
    const entry = k0.open
    if (!Number.isFinite(entry) || entry === 0) {
      i += 1
      continue
    }

    const streakBefore = consecutiveLosses
    const marginUsd = baseMargin * mult ** streakBefore
    maxMarginUsd = Math.max(maxMarginUsd, marginUsd)
    const notionalUsd = marginUsd * lev

    let exitIdx = -1
    let intrabarHit = null

    for (let j = i; j < candles.length; j++) {
      const bar = candles[j]
      const close = bar.close
      const high = Number.isFinite(bar.high) ? bar.high : close
      const low = Number.isFinite(bar.low) ? bar.low : close
      if (!Number.isFinite(close)) continue

      const hit = hitOnBar(entry, high, low, tpPct, slPct)
      if (hit) {
        exitIdx = j
        intrabarHit = hit
        break
      }
    }

    let exitReason
    let exitPx
    let retPct

    if (intrabarHit) {
      exitReason = intrabarHit.reason
      exitPx = intrabarHit.exitPx
      retPct = intrabarHit.retPct
      if (exitReason === 'TP') tpHits += 1
      else slHits += 1
    } else {
      exitIdx = candles.length - 1
      const last = candles[exitIdx]
      const c = last.close
      exitPx = Number.isFinite(c) ? c : entry
      retPct = ((exitPx - entry) / entry) * 100
      exitReason = 'END'
      endHits += 1
    }

    const pnlUsd = notionalUsd * (retPct / 100)
    const win = pnlUsd > 0

    equity += pnlUsd
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd

    cumulativePnlUsd += pnlUsd
    if (win) wins += 1
    else losses += 1

    let resetTriggered = false
    if (win) {
      consecutiveLosses = 0
    } else {
      consecutiveLosses += 1
      if (consecutiveLosses >= resetStage) {
        consecutiveLosses = 0
        resetTriggered = true
        streakResets += 1
      }
    }

    const exitBar = candles[exitIdx]
    trades.push({
      index: trades.length,
      side,
      entryCandleIndex: i,
      exitCandleIndex: exitIdx,
      barsHeld: exitIdx - i + 1,
      openTime: k0.openTime,
      exitOpenTime: exitBar.openTime,
      open: entry,
      exitPx,
      exitReason,
      retPct,
      marginUsd,
      leverage: lev,
      notionalUsd,
      pnlUsd,
      win,
      streakBefore,
      resetAfterLoss: resetTriggered,
    })

    i = exitIdx + 1
  }

  const count = trades.length
  return {
    trades,
    summary: {
      count,
      wins,
      losses,
      winRatePct: count > 0 ? (wins / count) * 100 : 0,
      totalPnlUsd: cumulativePnlUsd,
      maxDrawdownUsd,
      streakResets,
      maxMarginUsd,
      baseMarginUsd: baseMargin,
      martingaleMultiplier: mult,
      resetStage,
      leverage: lev,
      takeProfitPct: tpPct,
      stopLossPct: slPct,
      side,
      tpHits,
      slHits,
      endHits,
    },
  }
}

function emptySummary() {
  return {
    count: 0,
    wins: 0,
    losses: 0,
    winRatePct: 0,
    totalPnlUsd: 0,
    maxDrawdownUsd: 0,
    streakResets: 0,
    maxMarginUsd: 0,
    baseMarginUsd: DEFAULT_BASE_MARGIN_USD,
    martingaleMultiplier: DEFAULT_MARTINGALE_MULT,
    resetStage: DEFAULT_RESET_STAGE,
    leverage: DEFAULT_LEVERAGE,
    takeProfitPct: DEFAULT_TAKE_PROFIT_PCT,
    stopLossPct: DEFAULT_STOP_LOSS_PCT,
    side: 'long',
    tpHits: 0,
    slHits: 0,
    endHits: 0,
  }
}

/**
 * Long from `entry`: TP above, SL below. Same bar: SL first if both touched.
 * @returns {{ reason: 'TP'|'SL', exitPx: number, retPct: number } | null}
 */
function resolveLongHitOnBar(entry, high, low, tpPct, slPct) {
  const tpPx = entry * (1 + tpPct / 100)
  const slPx = entry * (1 - slPct / 100)
  const tpHit = high >= tpPx
  const slHit = low <= slPx

  if (slHit && tpHit) {
    return {
      reason: 'SL',
      exitPx: slPx,
      retPct: ((slPx - entry) / entry) * 100,
    }
  }
  if (slHit) {
    return {
      reason: 'SL',
      exitPx: slPx,
      retPct: ((slPx - entry) / entry) * 100,
    }
  }
  if (tpHit) {
    return {
      reason: 'TP',
      exitPx: tpPx,
      retPct: ((tpPx - entry) / entry) * 100,
    }
  }
  return null
}

/**
 * Short from `entry`: TP below (price down), SL above. Same bar: SL first if both touched.
 * @returns {{ reason: 'TP'|'SL', exitPx: number, retPct: number } | null}
 */
function resolveShortHitOnBar(entry, high, low, tpPct, slPct) {
  const tpPx = entry * (1 - tpPct / 100)
  const slPx = entry * (1 + slPct / 100)
  const tpHit = low <= tpPx
  const slHit = high >= slPx

  if (slHit && tpHit) {
    return {
      reason: 'SL',
      exitPx: slPx,
      retPct: ((entry - slPx) / entry) * 100,
    }
  }
  if (slHit) {
    return {
      reason: 'SL',
      exitPx: slPx,
      retPct: ((entry - slPx) / entry) * 100,
    }
  }
  if (tpHit) {
    return {
      reason: 'TP',
      exitPx: tpPx,
      retPct: ((entry - tpPx) / entry) * 100,
    }
  }
  return null
}

function pickSide(v) {
  const s = String(v ?? 'long').toLowerCase().trim()
  return s === 'short' ? 'short' : 'long'
}

function pickPositive(v, def) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}

function pickMult(v, def) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? n : def
}

function pickResetStage(v, def) {
  const n = Number.parseInt(String(v), 10)
  if (Number.isFinite(n) && n >= 1) return n
  return def
}

function pickPct(v, def) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}
