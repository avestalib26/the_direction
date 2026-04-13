/**
 * Zone-hedge backtest: sequential legs with fixed % TP/SL from each entry,
 * doubling margin steps, opposite hedge after stop. Modular parameters.
 */

import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

function parseKlines(data) {
  if (!Array.isArray(data)) return []
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }))
}

async function fetchJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    throw new Error(`Binance ${res.status}: ${msg}`)
  }
  return data
}

export async function fetchKlines(futuresBase, symbol, interval, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  })
  const data = await fetchJson(`${futuresBase}/fapi/v1/klines?${q}`)
  return parseKlines(data)
}

/** Apply slippage: long entry worse up, exit worse down; short opposite */
function slipPrice(price, side, isEntry, slipBps) {
  const s = slipBps / 10000
  if (side === 'long') {
    if (isEntry) return price * (1 + s)
    return price * (1 - s)
  }
  if (isEntry) return price * (1 - s)
  return price * (1 + s)
}

/**
 * Isolated USDT-M style liquidation (approx): adverse move ~ 1/L before liq.
 * Long liq below entry; short liq above.
 */
function liquidationPrice(entry, side, leverage, maintenanceRate) {
  const im = 1 / leverage
  const buf = maintenanceRate
  if (side === 'long') {
    return entry * (1 - im + buf)
  }
  return entry * (1 + im - buf)
}

/**
 * Intrabar resolution: liq > adverse SL > TP (conservative for backtest).
 * Returns { hit: 'liq'|'sl'|'tp'|null, exitPrice }
 */
function resolveBar(side, entry, tpPrice, slPrice, liqPrice, low, high) {
  if (side === 'long') {
    const liqHit = low <= liqPrice
    const slHit = low <= slPrice
    const tpHit = high >= tpPrice
    if (liqHit) return { hit: 'liq', exitPrice: liqPrice }
    if (slHit && tpHit) return { hit: 'sl', exitPrice: slPrice }
    if (slHit) return { hit: 'sl', exitPrice: slPrice }
    if (tpHit) return { hit: 'tp', exitPrice: tpPrice }
  } else {
    const liqHit = high >= liqPrice
    const slHit = high >= slPrice
    const tpHit = low <= tpPrice
    if (liqHit) return { hit: 'liq', exitPrice: liqPrice }
    if (slHit && tpHit) return { hit: 'sl', exitPrice: slPrice }
    if (slHit) return { hit: 'sl', exitPrice: slPrice }
    if (tpHit) return { hit: 'tp', exitPrice: tpPrice }
  }
  return { hit: null, exitPrice: null }
}

function tpSlFromEntry(entry, side, tpPct, adversePct) {
  const tpF = tpPct / 100
  const adF = adversePct / 100
  if (side === 'long') {
    return {
      tpPrice: entry * (1 + tpF),
      slPrice: entry * (1 - adF),
    }
  }
  return {
    tpPrice: entry * (1 - tpF),
    slPrice: entry * (1 + adF),
  }
}

function notionalUsd(marginUsd, leverage) {
  return marginUsd * leverage
}

function roundTripFees(notional, feeBpsPerSide) {
  const r = feeBpsPerSide / 10000
  return notional * r * 2
}

/**
 * One leg PnL in USD (linear coin-USDT notional).
 */
function legPnlUsd(side, entry, exit, qty, feesUsd) {
  let gross
  if (side === 'long') gross = qty * (exit - entry)
  else gross = qty * (entry - exit)
  return gross - feesUsd
}

/**
 * Run a single zone-hedge cycle starting at candle index `startIdx` (entry at open of that candle).
 * Returns { outcome, legs, netRealizedUsd, endBarIndex } where endBarIndex is last bar consumed.
 */
export function simulateOneCycle(candles, startIdx, params) {
  const {
    marginsUsd,
    leverage,
    maxSteps,
    tpPct,
    adversePct,
    feeBpsPerSide,
    slippageBps,
    maintenanceMarginRate,
    mode,
  } = params

  const legs = []
  let cumulativeLegPnl = 0
  let barIdx = startIdx
  if (barIdx >= candles.length) {
    return {
      outcome: 'no_data',
      legs: [],
      netRealizedUsd: 0,
      endBarIndex: startIdx,
    }
  }

  /** After SL, flip side; after TP, cycle wins */
  let side = mode === 'shortFirst' ? 'short' : 'long'

  for (let step = 1; step <= maxSteps; step++) {
    const marginUsd = marginsUsd[step - 1]
    if (marginUsd == null || !Number.isFinite(marginUsd)) break

    if (barIdx >= candles.length) break
    const bar = candles[barIdx]
    const rawEntry = bar.open
    const entry = slipPrice(rawEntry, side, true, slippageBps)
    const N = notionalUsd(marginUsd, leverage)
    const qty = N / entry

    const { tpPrice: rawTp, slPrice: rawSl } = tpSlFromEntry(entry, side, tpPct, adversePct)
    const tpPrice = rawTp
    const slPrice = rawSl
    const liqPx = liquidationPrice(entry, side, leverage, maintenanceMarginRate)

    const feesUsd = roundTripFees(N, feeBpsPerSide)

    let exitPrice = null
    let exitReason = null
    let exitBarIdx = barIdx

    /** Same bar: can TP/SL/liq on entry bar range */
    const first = resolveBar(side, entry, tpPrice, slPrice, liqPx, bar.low, bar.high)
    if (first.hit) {
      exitReason = first.hit
      exitPrice = slipPrice(first.exitPrice, side, false, slippageBps)
      exitBarIdx = barIdx
    } else {
      /** Scan forward */
      let j = barIdx + 1
      while (j < candles.length) {
        const b = candles[j]
        const r = resolveBar(side, entry, tpPrice, slPrice, liqPx, b.low, b.high)
        if (r.hit) {
          exitReason = r.hit
          exitPrice = slipPrice(r.exitPrice, side, false, slippageBps)
          exitBarIdx = j
          break
        }
        j++
      }
      if (exitReason == null) {
        /** Open exit at last close (data end) */
        const last = candles[candles.length - 1]
        exitBarIdx = candles.length - 1
        exitPrice = slipPrice(last.close, side, false, slippageBps)
        exitReason = 'eod'
      }
    }

    const net = legPnlUsd(side, entry, exitPrice, qty, feesUsd)
    cumulativeLegPnl += net

    legs.push({
      step,
      side,
      marginUsd,
      notionalUsd: N,
      qty,
      entryPrice: entry,
      exitPrice,
      tpPrice,
      slPrice,
      liqPrice: liqPx,
      exitReason,
      exitBarIndex: exitBarIdx,
      entryBarIndex: barIdx,
      feesUsd,
      netPnlUsd: net,
      cumulativeAfterLegUsd: cumulativeLegPnl,
    })

    barIdx = exitBarIdx + 1

    if (exitReason === 'tp') {
      return {
        outcome: 'win',
        legs,
        netRealizedUsd: cumulativeLegPnl,
        endBarIndex: exitBarIdx,
      }
    }
    if (exitReason === 'liq') {
      return {
        outcome: 'liquidated',
        legs,
        netRealizedUsd: cumulativeLegPnl,
        endBarIndex: exitBarIdx,
      }
    }
    if (exitReason === 'eod') {
      return {
        outcome: 'eod',
        legs,
        netRealizedUsd: cumulativeLegPnl,
        endBarIndex: exitBarIdx,
      }
    }

    /** SL or adverse — next hedge unless max steps */
    if (step >= maxSteps) {
      return {
        outcome: 'max_steps_loss',
        legs,
        netRealizedUsd: cumulativeLegPnl,
        endBarIndex: exitBarIdx,
      }
    }

    side = side === 'long' ? 'short' : 'long'
  }

  return {
    outcome: 'incomplete',
    legs,
    netRealizedUsd: cumulativeLegPnl,
    endBarIndex: barIdx - 1,
  }
}

/**
 * Full backtest over candles; chains cycles starting after each cycle ends.
 */
export function runZoneHedgeBacktest(candles, userParams = {}) {
  const marginsUsd =
    Array.isArray(userParams.marginsUsd) && userParams.marginsUsd.length > 0
      ? userParams.marginsUsd
      : [50, 100, 200]
  const params = {
    marginsUsd,
    leverage: Number(userParams.leverage) || 20,
    maxSteps: Number(userParams.maxSteps) || 3,
    tpPct: Number(userParams.tpPct) || 10,
    adversePct: Number(userParams.adversePct) || 10,
    feeBpsPerSide: Number(userParams.feeBpsPerSide) || 4,
    slippageBps: Number(userParams.slippageBps) || 2,
    maintenanceMarginRate: Number(userParams.maintenanceMarginRate) || 0.004,
    mode: userParams.mode === 'shortFirst' ? 'shortFirst' : 'longFirst',
  }

  const cycles = []
  const equityPoints = []
  let startEquity = Number(userParams.startingEquity) || 10_000
  let equity = startEquity
  let peak = equity
  let maxDrawdownUsd = 0
  let maxDrawdownPct = 0
  let cumulativePnl = 0
  let wins = 0
  let losses = 0

  let i = 0
  while (i < candles.length) {
    const c = simulateOneCycle(candles, i, params)
    if (c.outcome === 'no_data' || c.legs.length === 0) break
    const t = candles[c.endBarIndex]?.openTime ?? 0
    cumulativePnl += c.netRealizedUsd
    equity = startEquity + cumulativePnl
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd
    if (peak > 0 && dd / peak > maxDrawdownPct) maxDrawdownPct = dd / peak

    if (c.outcome === 'win') wins += 1
    else losses += 1

    cycles.push({
      ...c,
      cycleStartIndex: i,
      cycleEndTime: t,
      cumulativePnlUsd: cumulativePnl,
      equityAfter: equity,
    })
    equityPoints.push({ openTime: t, equity, cumulativePnlUsd: cumulativePnl })

    i = c.endBarIndex + 1
    if (c.outcome === 'eod') break
  }

  const total = wins + losses
  const winRatePct = total > 0 ? (wins / total) * 100 : 0

  return {
    params,
    cycles,
    equityCurve: equityPoints,
    summary: {
      startingEquity: startEquity,
      finalEquity: equity,
      totalCycles: cycles.length,
      wins,
      losses,
      winRatePct,
      cumulativePnlUsd: cumulativePnl,
      maxDrawdownUsd,
      maxDrawdownPct: maxDrawdownPct * 100,
    },
  }
}

export async function computeZoneHedgeBacktest(futuresBase, opts) {
  const symbol = String(opts.symbol || 'BTCUSDT').toUpperCase()
  const interval = String(opts.interval || '1h')
  const limit = Math.min(1500, Math.max(50, Number(opts.limit) || 500))
  const candles = await fetchKlines(futuresBase, symbol, interval, limit)
  if (candles.length < 30) {
    return { error: 'Not enough candles' }
  }

  const marginsUsd =
    Array.isArray(opts.marginsUsd) && opts.marginsUsd.length > 0
      ? opts.marginsUsd
      : [50, 100, 200]
  const result = runZoneHedgeBacktest(candles, {
    marginsUsd,
    leverage: opts.leverage,
    maxSteps: opts.maxSteps,
    tpPct: opts.tpPct,
    adversePct: opts.adversePct,
    feeBpsPerSide: opts.feeBpsPerSide,
    slippageBps: opts.slippageBps,
    maintenanceMarginRate: opts.maintenanceMarginRate,
    mode: opts.mode,
    startingEquity: opts.startingEquity,
  })

  return {
    ...result,
    symbol,
    interval,
    candleCount: candles.length,
    fetchedAt: new Date().toISOString(),
  }
}
