/**
 * Multi-coin 2h cycle: each coin uses 24h-change side at H1 open (margin × leverage notional).
 * Optional TP/SL % from entry checked on 1h candle high/low (same candle: SL assumed first).
 * If no TP/SL exit on H1: close losers at H1 close; winners held until H2 (with H2 TP/SL then close).
 * Repeats for every consecutive pair of 1h candles (cycles = floor(minLen/2)).
 */

export const DEFAULT_MARGIN_USD = 50
export const DEFAULT_LEVERAGE = 20

function pnlPctAtClose(long, entry, closePx) {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(closePx)) {
    return null
  }
  return long
    ? ((closePx - entry) / entry) * 100
    : ((entry - closePx) / entry) * 100
}

function pnlPctAtExitPrice(long, entry, exitPx) {
  return pnlPctAtClose(long, entry, exitPx)
}

/** @returns {{ tp: number|null, sl: number|null }|null} */
function tpSlPrices(long, entry, tpPct, slPct) {
  const hasTp = Number.isFinite(tpPct) && tpPct > 0
  const hasSl = Number.isFinite(slPct) && slPct > 0
  if (!hasTp && !hasSl) return null
  if (long) {
    return {
      tp: hasTp ? entry * (1 + tpPct / 100) : null,
      sl: hasSl ? entry * (1 - slPct / 100) : null,
    }
  }
  return {
    tp: hasTp ? entry * (1 - tpPct / 100) : null,
    sl: hasSl ? entry * (1 + slPct / 100) : null,
  }
}

/**
 * Intrabar TP/SL using candle high/low. If both could hit same candle, SL is assumed first (conservative).
 * @param {{ high: number, low: number }} candle
 * @returns {{ exitPct: number, kind: 'TP'|'SL' }|null}
 */
function intrabarTpSl(long, entry, candle, tpPct, slPct) {
  const lv = tpSlPrices(long, entry, tpPct, slPct)
  if (!lv) return null
  const { high, low } = candle
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null

  const { tp, sl } = lv
  if (long) {
    const slHit = sl != null && low <= sl
    const tpHit = tp != null && high >= tp
    if (slHit && tpHit && sl != null) {
      return { exitPct: pnlPctAtExitPrice(long, entry, sl), kind: 'SL' }
    }
    if (slHit && sl != null) {
      return { exitPct: pnlPctAtExitPrice(long, entry, sl), kind: 'SL' }
    }
    if (tpHit && tp != null) {
      return { exitPct: pnlPctAtExitPrice(long, entry, tp), kind: 'TP' }
    }
  } else {
    const slHit = sl != null && high >= sl
    const tpHit = tp != null && low <= tp
    if (slHit && tpHit && sl != null) {
      return { exitPct: pnlPctAtExitPrice(long, entry, sl), kind: 'SL' }
    }
    if (slHit && sl != null) {
      return { exitPct: pnlPctAtExitPrice(long, entry, sl), kind: 'SL' }
    }
    if (tpHit && tp != null) {
      return { exitPct: pnlPctAtExitPrice(long, entry, tp), kind: 'TP' }
    }
  }
  return null
}

/**
 * @param {Record<string, Array<{ open: number, high: number, low: number, close: number, openTime: number }>>} candlesBySymbol
 * @param {{
 *   marginUsd?: number,
 *   leverage?: number,
 *   takeProfitPct?: number,
 *   stopLossPct?: number,
 *   change24hBySymbol?: Record<string, number | null>,
 * }} opts
 */
export function runBacktest3Simulation(candlesBySymbol, opts = {}) {
  const marginUsd =
    Number.isFinite(opts.marginUsd) && opts.marginUsd > 0
      ? opts.marginUsd
      : DEFAULT_MARGIN_USD
  const lev =
    Number.isFinite(opts.leverage) && opts.leverage > 0
      ? opts.leverage
      : DEFAULT_LEVERAGE
  const tpPct =
    Number.isFinite(opts.takeProfitPct) && opts.takeProfitPct > 0
      ? opts.takeProfitPct
      : 0
  const slPct =
    Number.isFinite(opts.stopLossPct) && opts.stopLossPct > 0
      ? opts.stopLossPct
      : 0
  const change24hBySymbol = opts.change24hBySymbol ?? {}
  const baseNotionalUsd = marginUsd * lev

  const symbols = Object.keys(candlesBySymbol)
  if (symbols.length === 0) {
    return { cycles: [], summary: emptySummary() }
  }

  let minLen = Infinity
  for (const sym of symbols) {
    const L = candlesBySymbol[sym]?.length ?? 0
    if (L < minLen) minLen = L
  }
  const numCycles = Math.floor(minLen / 2)
  if (numCycles < 1) {
    return { cycles: [], summary: emptySummary() }
  }

  const cycles = []
  let cumulativePnlUsd = 0

  for (let c = 0; c < numCycles; c++) {
    const i1 = 2 * c
    const i2 = 2 * c + 1
    let cyclePnlUsd = 0
    let closedH1 = 0
    let heldToH2 = 0
    const perSymbol = []

    for (const sym of symbols) {
      const K = candlesBySymbol[sym]
      const H1 = K[i1]
      const H2 = K[i2]
      const entry = H1.open
      if (!Number.isFinite(entry) || entry === 0) continue

      const change24h = change24hBySymbol[sym]
      const long = Number.isFinite(change24h) && change24h > 0

      const h1Intra = intrabarTpSl(long, entry, H1, tpPct, slPct)
      let exitPct
      let exitAt

      if (h1Intra) {
        exitPct = h1Intra.exitPct
        exitAt = h1Intra.kind === 'TP' ? 'H1-TP' : 'H1-SL'
        closedH1 += 1
      } else {
        const p1 = pnlPctAtClose(long, entry, H1.close)
        if (p1 == null) continue

        if (p1 < 0) {
          exitPct = p1
          exitAt = 'H1'
          closedH1 += 1
        } else {
          const h2Intra = intrabarTpSl(long, entry, H2, tpPct, slPct)
          if (h2Intra) {
            exitPct = h2Intra.exitPct
            exitAt = h2Intra.kind === 'TP' ? 'H2-TP' : 'H2-SL'
          } else {
            const p2 = pnlPctAtClose(long, entry, H2.close)
            exitPct = p2 ?? p1
            exitAt = 'H2'
          }
          heldToH2 += 1
        }
      }

      const pnlUsd = baseNotionalUsd * (exitPct / 100)
      cyclePnlUsd += pnlUsd
      perSymbol.push({
        symbol: sym,
        long,
        change24h,
        exitAt,
        pnlPct: exitPct,
        pnlUsd,
      })
    }

    cumulativePnlUsd += cyclePnlUsd
    const tOpen = candlesBySymbol[symbols[0]][i1]?.openTime
    cycles.push({
      cycleIndex: c,
      hour1OpenTime: tOpen,
      totalPnlUsd: cyclePnlUsd,
      cumulativePnlUsd,
      tradeCount: perSymbol.length,
      closedAtH1: closedH1,
      heldToH2: heldToH2,
      perSymbol,
    })
  }

  const totalPnlUsd = cycles.reduce((s, cy) => s + cy.totalPnlUsd, 0)
  return {
    cycles,
    summary: summarize(cycles, totalPnlUsd, symbols.length, numCycles),
  }
}

function emptySummary() {
  return {
    symbolCount: 0,
    numCycles: 0,
    totalPnlUsd: 0,
    avgCyclePnlUsd: 0,
    bestCycleUsd: 0,
    worstCycleUsd: 0,
  }
}

function summarize(cycles, totalPnlUsd, symbolCount, numCycles) {
  if (!cycles.length) return emptySummary()
  let best = -Infinity
  let worst = Infinity
  for (const cy of cycles) {
    if (cy.totalPnlUsd > best) best = cy.totalPnlUsd
    if (cy.totalPnlUsd < worst) worst = cy.totalPnlUsd
  }
  const n = numCycles > 0 ? numCycles : 1
  return {
    symbolCount,
    numCycles,
    totalPnlUsd,
    avgCyclePnlUsd: totalPnlUsd / n,
    bestCycleUsd: Number.isFinite(best) ? best : 0,
    worstCycleUsd: Number.isFinite(worst) ? worst : 0,
  }
}
