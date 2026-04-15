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

/** Ensure fast period &lt; slow period for a sensible pair (swap if needed, bump slow if tied). */
export function normalizeEquityEmaPair(emaFastRaw, emaSlowRaw) {
  let fast = Math.max(2, Math.floor(Number(emaFastRaw)) || 10)
  let slow = Math.max(2, Math.floor(Number(emaSlowRaw)) || 50)
  if (fast > slow) [fast, slow] = [slow, fast]
  if (fast >= slow) slow = Math.min(fast + 1, 500)
  return { fast, slow }
}

/**
 * Keep trade i only if fast EMA &gt; slow EMA on prior cumulative close (bar i−1).
 * Warmup: if either EMA missing at i−1, the trade is kept.
 *
 * @param {number[]} pcts
 * @param {number[]} rMultiples
 * @param {string[] | null} outcomes
 * @param {number} emaFastPeriod — smaller period (e.g. 10)
 * @param {number} emaSlowPeriod — larger period (e.g. 50)
 */
export function computeEquityEmaFilterStats(pcts, rMultiples, outcomes, emaFastPeriod, emaSlowPeriod) {
  const n = pcts?.length ?? 0
  if (!n || !Array.isArray(rMultiples) || rMultiples.length !== n) return null
  const { fast, slow } = normalizeEquityEmaPair(emaFastPeriod, emaSlowPeriod)

  const closes = []
  let level = EQUITY_STACK_BASE
  for (let i = 0; i < n; i++) {
    const pct = Number(pcts[i])
    level += Number.isFinite(pct) ? pct : 0
    closes.push(level)
  }

  const emaFast = computeEmaFromCloses(closes, fast)
  const emaSlow = computeEmaFromCloses(closes, slow)

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
    if (i > 0) {
      const ef = emaFast[i - 1]
      const es = emaSlow[i - 1]
      ok =
        ef == null ||
        es == null ||
        !Number.isFinite(ef) ||
        !Number.isFinite(es) ||
        ef > es
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
    emaFastPeriod: fast,
    emaSlowPeriod: slow,
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
    emaFastPeriod: null,
    emaSlowPeriod: null,
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
