/**
 * Aggregates for closed-position rows (realizedPnl, closedAt ms).
 * "All-time" here means the full loaded array (API limit), not guaranteed exchange lifetime.
 */

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0)
}

function filterWindow(rows, sinceMs) {
  return rows.filter((r) => r.closedAt >= sinceMs)
}

export function computeTradeHistoryMetrics(closes) {
  const rows = Array.isArray(closes) ? closes : []
  const pnls = rows
    .map((r) => Number(r.realizedPnl))
    .filter((n) => Number.isFinite(n))

  if (!pnls.length) {
    return {
      empty: true,
      sampleSize: 0,
    }
  }

  const wins = pnls.filter((n) => n > 0)
  const losses = pnls.filter((n) => n < 0)
  const flats = pnls.filter((n) => n === 0)

  const winCount = wins.length
  const lossCount = losses.length
  const flatCount = flats.length
  const totalTrades = pnls.length

  const winRateTotalPct =
    totalTrades > 0 ? (winCount / totalTrades) * 100 : null
  const decisive = winCount + lossCount
  const winRateDecisivePct =
    decisive > 0 ? (winCount / decisive) * 100 : null

  const avgWin = winCount > 0 ? sum(wins) / winCount : null
  const avgLoss = lossCount > 0 ? sum(losses) / lossCount : null

  const sumWin = sum(wins)
  const sumLoss = sum(losses)
  const sumLossAbs = Math.abs(sumLoss)

  let profitFactor = null
  if (sumLossAbs > 0) {
    profitFactor = sumWin / sumLossAbs
  } else if (sumWin > 0) {
    profitFactor = Number.POSITIVE_INFINITY
  }

  const netPnl = sum(pnls)
  const avgTradePnl = netPnl / totalTrades

  const largestWin = winCount > 0 ? Math.max(...wins) : null
  const largestLoss = lossCount > 0 ? Math.min(...losses) : null

  const expectancy =
    decisive > 0
      ? (winCount / decisive) * (avgWin ?? 0) +
        (lossCount / decisive) * (avgLoss ?? 0)
      : null

  const now = Date.now()
  const startToday = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    new Date().getDate(),
  ).getTime()
  const endToday = startToday + 86400000

  const todayRows = rows.filter(
    (r) => r.closedAt >= startToday && r.closedAt < endToday,
  )
  const todayPnls = todayRows
    .map((r) => Number(r.realizedPnl))
    .filter(Number.isFinite)
  const tw = todayPnls.filter((n) => n > 0).length
  const tl = todayPnls.filter((n) => n < 0).length
  const tt = todayPnls.length
  const todayWinRatePct = tt > 0 ? (tw / tt) * 100 : null
  const todayNetPnl = todayPnls.length ? sum(todayPnls) : null
  const todayAvgPnl =
    todayPnls.length > 0 ? todayNetPnl / todayPnls.length : null

  const ms7d = now - 7 * 86400000
  const ms30d = now - 30 * 86400000
  const rows7 = filterWindow(rows, ms7d)
  const rows30 = filterWindow(rows, ms30d)
  const p7 = rows7.map((r) => Number(r.realizedPnl)).filter(Number.isFinite)
  const p30 = rows30.map((r) => Number(r.realizedPnl)).filter(Number.isFinite)

  const winRate7dPct =
    p7.length > 0
      ? (p7.filter((n) => n > 0).length / p7.length) * 100
      : null
  const net7d = p7.length ? sum(p7) : null

  const winRate30dPct =
    p30.length > 0
      ? (p30.filter((n) => n > 0).length / p30.length) * 100
      : null
  const net30d = p30.length ? sum(p30) : null

  const avgWin7d =
    p7.filter((n) => n > 0).length > 0
      ? sum(p7.filter((n) => n > 0)) / p7.filter((n) => n > 0).length
      : null
  const avgLoss7d =
    p7.filter((n) => n < 0).length > 0
      ? sum(p7.filter((n) => n < 0)) / p7.filter((n) => n < 0).length
      : null

  return {
    empty: false,
    sampleSize: totalTrades,
    winCount,
    lossCount,
    flatCount,
    winRateTotalPct,
    winRateDecisivePct,
    avgWin,
    avgLoss,
    profitFactor,
    netPnl,
    avgTradePnl,
    largestWin,
    largestLoss,
    expectancy,
    todayCount: tt,
    todayWins: tw,
    todayLosses: tl,
    todayWinRatePct,
    todayNetPnl,
    todayAvgPnl,
    count7d: p7.length,
    winRate7dPct,
    net7d,
    avgWin7d,
    avgLoss7d,
    count30d: p30.length,
    winRate30dPct,
    net30d,
  }
}
