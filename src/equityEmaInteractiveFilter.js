/** Stacked equity curve starts here (matches per-trade candle chart). */
export const EQUITY_STACK_BASE = 100

function computeEmaFromCloses(closes, period) {
  const out = closes.map(() => null)
  if (!Array.isArray(closes) || closes.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

/** Equity EMA period for stacked-curve filter (clamped 2–500; default 50). */
export function normalizeEquityEmaPeriod(emaPeriodRaw) {
  let p = Math.floor(Number(emaPeriodRaw))
  if (!Number.isFinite(p)) p = 50
  return Math.min(500, Math.max(2, p))
}

/**
 * Keep trade i only if stacked cumulative close &gt; single EMA at prior bar (i−1) — same idea as live regime
 * (equity above its EMA). Warmup: if EMA missing at i−1, the trade is kept.
 *
 * When `entryOkByTrade` is provided (same length as pcts), uses server-computed flags on **entry-ordered** stack.
 *
 * @param {number[]} pcts
 * @param {number[]} rMultiples
 * @param {string[] | null} outcomes
 * @param {number} emaPeriod — EMA length on stacked cumulative close (e.g. 50)
 * @param {boolean[] | null | undefined} entryOkByTrade — optional; when set, ignores stack-based rule above
 */
export function computeEquityEmaFilterStats(
  pcts,
  rMultiples,
  outcomes,
  emaPeriod,
  entryOkByTrade = null,
) {
  const n = pcts?.length ?? 0
  if (!n || !Array.isArray(rMultiples) || rMultiples.length !== n) return null
  const period = normalizeEquityEmaPeriod(emaPeriod)

  const closes = []
  let level = EQUITY_STACK_BASE
  for (let i = 0; i < n; i++) {
    const pct = Number(pcts[i])
    level += Number.isFinite(pct) ? pct : 0
    closes.push(level)
  }

  const emaRow = computeEmaFromCloses(closes, period)

  const useEntryFlags =
    Array.isArray(entryOkByTrade) && entryOkByTrade.length === n

  let kept = 0
  let skipped = 0
  let sumR = 0
  let sumPnlPct = 0
  let tpHits = 0
  let slHits = 0
  let eodHits = 0
  let winningTrades = 0
  let losingTrades = 0
  let breakevenTrades = 0

  for (let i = 0; i < n; i++) {
    let ok = true
    if (useEntryFlags) {
      ok = entryOkByTrade[i] === true
    } else if (i > 0) {
      const c = closes[i - 1]
      const e = emaRow[i - 1]
      ok =
        e == null ||
        !Number.isFinite(c) ||
        !Number.isFinite(e) ||
        c > e
    }

    if (!ok) {
      skipped += 1
      continue
    }

    kept += 1
    const r = Number(rMultiples[i])
    if (Number.isFinite(r)) sumR += r
    const pct = Number(pcts[i])
    if (Number.isFinite(pct)) sumPnlPct += pct

    const oc = outcomes?.[i]
    if (oc === 'tp') tpHits += 1
    else if (oc === 'sl') slHits += 1
    else if (oc === 'eod') eodHits += 1

    if (Number.isFinite(r)) {
      if (r > 0) winningTrades += 1
      else if (r < 0) losingTrades += 1
      else breakevenTrades += 1
    }
  }

  const decided = tpHits + slHits
  return {
    mode: 'filtered',
    filterBasis: useEntryFlags ? 'entry_realized_equity' : 'stack_before_trade',
    emaPeriod: period,
    sampleSize: n,
    kept,
    skipped,
    sumR,
    avgR: kept > 0 ? sumR / kept : null,
    sumPnlPct,
    finalStackLevel: EQUITY_STACK_BASE + sumPnlPct,
    tpHits,
    slHits,
    eodHits,
    winRateTpVsSlPct: decided > 0 ? (100 * tpHits) / decided : null,
    winningTrades,
    losingTrades,
    breakevenTrades,
  }
}

/** Aggregate over every point in the subsample (no EMA gate) — for toggle-off comparison. */
export function computePerTradeSubsampleStats(pcts, rMultiples, outcomes) {
  const n = pcts?.length ?? 0
  if (!n || !Array.isArray(rMultiples) || rMultiples.length !== n) return null

  let sumR = 0
  let sumPnlPct = 0
  let tpHits = 0
  let slHits = 0
  let eodHits = 0
  let winningTrades = 0
  let losingTrades = 0
  let breakevenTrades = 0

  for (let i = 0; i < n; i++) {
    const r = Number(rMultiples[i])
    if (Number.isFinite(r)) sumR += r
    const pct = Number(pcts[i])
    if (Number.isFinite(pct)) sumPnlPct += pct

    const oc = outcomes?.[i]
    if (oc === 'tp') tpHits += 1
    else if (oc === 'sl') slHits += 1
    else if (oc === 'eod') eodHits += 1

    if (Number.isFinite(r)) {
      if (r > 0) winningTrades += 1
      else if (r < 0) losingTrades += 1
      else breakevenTrades += 1
    }
  }

  const decided = tpHits + slHits
  return {
    mode: 'all',
    emaPeriod: null,
    sampleSize: n,
    kept: n,
    skipped: 0,
    sumR,
    avgR: n > 0 ? sumR / n : null,
    sumPnlPct,
    finalStackLevel: EQUITY_STACK_BASE + sumPnlPct,
    tpHits,
    slHits,
    eodHits,
    winRateTpVsSlPct: decided > 0 ? (100 * tpHits) / decided : null,
    winningTrades,
    losingTrades,
    breakevenTrades,
  }
}
