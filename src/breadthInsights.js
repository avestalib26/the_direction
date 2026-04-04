/**
 * Derive trading-oriented summaries from candleBreadth (oldest → newest).
 */

const RECENT_BARS = 5

export function computeBreadthInsights(candles) {
  if (!candles?.length) return null

  const n = candles.length
  const latest = candles[n - 1]
  const prior = n >= 2 ? candles[n - 2] : null

  const greens = candles.map((c) => c.greenPct)
  const meanGreenPct =
    greens.reduce((a, b) => a + b, 0) / Math.max(greens.length, 1)

  const k = Math.min(RECENT_BARS, n)
  const recentSlice = candles.slice(-k)
  const earlySlice = candles.slice(0, k)
  const recentAvgGreen =
    recentSlice.reduce((s, c) => s + c.greenPct, 0) / recentSlice.length
  const earlyAvgGreen =
    earlySlice.reduce((s, c) => s + c.greenPct, 0) / earlySlice.length
  const momentum = recentAvgGreen - earlyAvgGreen

  let trendLabel = 'Mixed / balanced'
  if (momentum > 3) trendLabel = 'Breadth improving (recent vs start of window)'
  else if (momentum < -3)
    trendLabel = 'Breadth weakening (recent vs start of window)'

  const deltaLatestVsPrior = prior
    ? latest.greenPct - prior.greenPct
    : null

  const greenMajorityBars = candles.filter((c) => c.greenPct > 50).length
  const redMajorityBars = candles.filter((c) => c.redPct > 50).length

  let greenStreakEnd = 0
  for (let i = n - 1; i >= 0; i--) {
    if (candles[i].greenPct > 50) greenStreakEnd++
    else break
  }
  let redStreakEnd = 0
  for (let i = n - 1; i >= 0; i--) {
    if (candles[i].redPct > 50) redStreakEnd++
    else break
  }

  const latestBias =
    latest.greenPct > 55
      ? 'Broad participation up'
      : latest.redPct > 55
        ? 'Broad participation down'
        : 'Split market'

  return {
    latest,
    prior,
    meanGreenPct,
    recentAvgGreen,
    earlyAvgGreen,
    momentum,
    trendLabel,
    deltaLatestVsPrior,
    greenMajorityBars,
    redMajorityBars,
    greenStreakEnd,
    redStreakEnd,
    latestBias,
    n,
  }
}

/** Last-candle % change per symbol, sorted. */
export function topMoversLastBar(symbolRows, n = 8) {
  if (!symbolRows?.length) return { winners: [], losers: [] }

  const scored = symbolRows
    .map((row) => {
      const last = row.candles[row.candles.length - 1]
      const pct = last?.changePct
      return {
        symbol: row.symbol,
        changePct: pct,
      }
    })
    .filter((x) => x.changePct !== null && Number.isFinite(x.changePct))

  const sorted = [...scored].sort((a, b) => b.changePct - a.changePct)
  const winners = sorted.slice(0, n)
  const winnerSyms = new Set(winners.map((w) => w.symbol))
  const outsideWinners = sorted.filter((s) => !winnerSyms.has(s.symbol))
  const losers = outsideWinners.slice(-n).reverse()
  return { winners, losers }
}

export function buildCandleBreadthCsv(candles) {
  const header =
    'index,openTimeUtc,green,red,flat,greenPct,redPct,neutralPct'
  const lines = candles.map((c) =>
    [
      c.index + 1,
      c.openTime ? new Date(c.openTime).toISOString() : '',
      c.green,
      c.red,
      c.neutral,
      c.greenPct.toFixed(2),
      c.redPct.toFixed(2),
      c.neutralPct.toFixed(2),
    ].join(','),
  )
  return [header, ...lines].join('\n')
}

export function buildSymbolMatrixCsv(candles, symbolRows) {
  const times = candles.map((c) =>
    c.openTime ? new Date(c.openTime).toISOString() : '',
  )
  const head = ['symbol', ...times.map((_, i) => `candle_${i + 1}`)].join(',')
  const body = symbolRows.map((row) => {
    const vals = row.candles.map((cell) =>
      cell.changePct == null ? '' : String(cell.changePct),
    )
    return [row.symbol, ...vals].join(',')
  })
  return [head, ...body].join('\n')
}

export function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
