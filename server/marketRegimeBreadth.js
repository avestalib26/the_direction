/**
 * Daily cross-sectional market breadth, regime score, momentum picks,
 * washout/rebound flags, and optional simplified strategy simulation.
 * Uses Binance USDT-M perpetual daily klines.
 */

import { computeFutures24hVolumes } from './volumeScreener.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

const IS_VERCEL = process.env.VERCEL === '1'
const KLINES_CONCURRENCY = IS_VERCEL
  ? Math.min(
      8,
      Math.max(4, Number.parseInt(process.env.BREADTH_KLINES_CONCURRENCY ?? '5', 10) || 5),
    )
  : 12

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

async function mapPool(items, concurrency, mapper) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      out[idx] = await mapper(items[idx], idx)
    }
  }
  const n = Math.min(concurrency, items.length) || 1
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

function parseKlines(data) {
  if (!Array.isArray(data)) return []
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7]),
  }))
}

async function fetchDailyKlines(futuresBase, symbol, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval: '1d',
    limit: String(limit),
  })
  const url = `${futuresBase}/fapi/v1/klines?${q}`
  const data = await fetchJson(url)
  return parseKlines(data)
}

function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (!a.length) return NaN
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

function sampleStdev(vals) {
  const a = vals.filter((x) => Number.isFinite(x))
  const n = a.length
  if (n < 2) return 0
  const m = a.reduce((s, x) => s + x, 0) / n
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)
  return Math.sqrt(v)
}

/** Rolling z-score: at i uses window ending at i (inclusive), length `window`. */
function rollingZ(series, window) {
  const n = series.length
  const out = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (i < window - 1) continue
    const slice = []
    for (let j = i - window + 1; j <= i; j++) {
      const v = series[j]
      if (v != null && Number.isFinite(v)) slice.push(v)
    }
    if (slice.length < window) continue
    const m = slice.reduce((s, x) => s + x, 0) / window
    const sd = sampleStdev(slice)
    const cur = series[i]
    if (cur == null || !Number.isFinite(cur)) continue
    out[i] = sd < 1e-14 ? 0 : (cur - m) / sd
  }
  return out
}

function sma(series, period) {
  const n = series.length
  const out = new Array(n).fill(null)
  for (let i = period - 1; i < n; i++) {
    let s = 0
    let ok = true
    for (let j = i - period + 1; j <= i; j++) {
      const v = series[j]
      if (v == null || !Number.isFinite(v)) {
        ok = false
        break
      }
      s += v
    }
    if (ok) out[i] = s / period
  }
  return out
}

function rollingStdDevDailyReturns(dailyRets, window) {
  const n = dailyRets.length
  const out = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (i < window - 1) continue
    const slice = []
    for (let j = i - window + 1; j <= i; j++) {
      const v = dailyRets[j]
      if (v != null && Number.isFinite(v)) slice.push(v)
    }
    if (slice.length < window) continue
    out[i] = sampleStdev(slice)
  }
  return out
}

/**
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function computeMarketRegimeBreadth(futuresBase, opts = {}) {
  const minQuoteVolume = Number.isFinite(opts.minQuoteVolume)
    ? opts.minQuoteVolume
    : 2_000_000
  const maxSymbols = Math.min(
    400,
    Math.max(20, Number.parseInt(String(opts.maxSymbols ?? 150), 10) || 150),
  )
  const dailyLimit = Math.min(
    1500,
    Math.max(120, Number.parseInt(String(opts.dailyLimit ?? 400), 10) || 400),
  )
  const minHistoryDays = Math.min(
    dailyLimit - 1,
    Math.max(30, Number.parseInt(String(opts.minHistoryDays ?? 90), 10) || 90),
  )
  const zWindow = Math.min(60, Math.max(10, Number.parseInt(String(opts.zWindow ?? 20), 10) || 20))
  const K = Math.min(20, Math.max(1, Number.parseInt(String(opts.k ?? 5), 10) || 5))
  const regimeThreshold = Number.isFinite(opts.regimeThreshold)
    ? opts.regimeThreshold
    : 0.75
  const w1 = Number.isFinite(opts.weightZ1) ? opts.weightZ1 : 0.4
  const w2 = Number.isFinite(opts.weightZ2) ? opts.weightZ2 : 0.3
  const w3 = Number.isFinite(opts.weightZ3) ? opts.weightZ3 : 0.3
  const maxWeightPerName = Number.isFinite(opts.maxWeightPerName)
    ? opts.maxWeightPerName
    : 0.2
  const grossBookCap = Number.isFinite(opts.grossBookCap) ? opts.grossBookCap : 1.0
  const feeBpsRoundTrip = Number.isFinite(opts.feeBpsRoundTrip)
    ? opts.feeBpsRoundTrip
    : 8

  const volRows = await computeFutures24hVolumes(futuresBase)
  const liquid = volRows.filter((r) => r.quoteVolume24h >= minQuoteVolume)
  const candidateSymbols = liquid.slice(0, maxSymbols).map((r) => r.symbol)

  const raw = await mapPool(candidateSymbols, KLINES_CONCURRENCY, async (symbol) => {
    try {
      const klines = await fetchDailyKlines(futuresBase, symbol, dailyLimit)
      if (!klines.length || klines.length < minHistoryDays) {
        return { symbol, klines: null, error: 'insufficient history' }
      }
      return { symbol, klines: klines.slice(-dailyLimit), error: null }
    } catch (e) {
      return {
        symbol,
        klines: null,
        error: e instanceof Error ? e.message : 'fetch failed',
      }
    }
  })

  const valid = raw.filter((r) => r.klines && r.klines.length >= minHistoryDays)
  if (valid.length < 20) {
    return {
      error: `Too few symbols with ${minHistoryDays}+ daily bars (${valid.length}). Lower minQuoteVolume or minHistoryDays.`,
    }
  }

  const L = Math.min(...valid.map((r) => r.klines.length))
  const nSyms = valid.length

  const closes = []
  const opens = []
  const times = []
  for (let s = 0; s < nSyms; s++) {
    const kl = valid[s].klines.slice(-L)
    closes.push(kl.map((k) => k.close))
    opens.push(kl.map((k) => k.open))
    if (s === 0) times.push(...kl.map((k) => k.openTime))
  }

  const ret = Array.from({ length: nSyms }, () => new Array(L).fill(null))
  const ma20 = Array.from({ length: nSyms }, () => new Array(L).fill(null))
  const vol20 = Array.from({ length: nSyms }, () => new Array(L).fill(null))
  const mom20 = Array.from({ length: nSyms }, () => new Array(L).fill(null))
  const mom5 = Array.from({ length: nSyms }, () => new Array(L).fill(null))
  const ma10 = Array.from({ length: nSyms }, () => new Array(L).fill(null))

  for (let s = 0; s < nSyms; s++) {
    const c = closes[s]
    for (let i = 1; i < L; i++) {
      if (c[i - 1] > 0 && Number.isFinite(c[i])) {
        ret[s][i] = ((c[i] - c[i - 1]) / c[i - 1]) * 100
      }
    }
    for (let i = 19; i < L; i++) {
      let sum = 0
      for (let j = i - 19; j <= i; j++) sum += c[j]
      ma20[s][i] = sum / 20
    }
    for (let i = 9; i < L; i++) {
      let sum = 0
      for (let j = i - 9; j <= i; j++) sum += c[j]
      ma10[s][i] = sum / 10
    }
    vol20[s] = rollingStdDevDailyReturns(ret[s], 20)
    for (let i = 20; i < L; i++) {
      if (c[i - 20] > 0) mom20[s][i] = c[i] / c[i - 20] - 1
    }
    for (let i = 5; i < L; i++) {
      if (c[i - 5] > 0) mom5[s][i] = c[i] / c[i - 5] - 1
    }
  }

  const B1 = new Array(L).fill(null)
  const B2 = new Array(L).fill(null)
  const B3 = new Array(L).fill(null)
  const B4 = new Array(L).fill(null)
  const nActive = new Array(L).fill(0)

  for (let i = 19; i < L; i++) {
    const rets = []
    let green = 0
    let above = 0
    let panic = 0
    let denom3 = 0
    for (let s = 0; s < nSyms; s++) {
      const r = ret[s][i]
      if (r == null || !Number.isFinite(r)) continue
      rets.push(r)
      if (r > 0) green++
      if (r < -3) panic++
      if (ma20[s][i] != null && Number.isFinite(ma20[s][i])) {
        denom3++
        if (closes[s][i] > ma20[s][i]) above++
      }
    }
    nActive[i] = rets.length
    if (rets.length < Math.min(15, Math.floor(nSyms * 0.2))) continue
    B1[i] = median(rets)
    B2[i] = green / rets.length
    B3[i] = denom3 > 0 ? above / denom3 : null
    B4[i] = rets.length > 0 ? panic / rets.length : null
  }

  const Z1 = rollingZ(B1, zWindow)
  const Z2 = rollingZ(B2, zWindow)
  const Z3 = rollingZ(B3, zWindow)

  const R = new Array(L).fill(null)
  for (let i = 0; i < L; i++) {
    const a = Z1[i]
    const b = Z2[i]
    const c = Z3[i]
    if (a == null || b == null || c == null) continue
    R[i] = w1 * a + w2 * b + w3 * c
  }

  const ma3R = sma(R, 3)
  const ma10R = sma(R, 10)
  const slope = new Array(L).fill(null)
  for (let i = 0; i < L; i++) {
    if (ma3R[i] != null && ma10R[i] != null) slope[i] = ma3R[i] - ma10R[i]
  }

  const regime = new Array(L).fill(null)
  for (let i = 0; i < L; i++) {
    const r = R[i]
    const sl = slope[i]
    if (r == null || sl == null) continue
    if (r > regimeThreshold && sl > 0) regime[i] = 'bull'
    else if (r < -regimeThreshold && sl < 0) regime[i] = 'bear'
    else regime[i] = 'neutral'
  }

  /** BTC proxy for washout / rebound */
  let btcCloses = null
  let btcMa5 = null
  let btcMa10 = null
  try {
    const btcK = await fetchDailyKlines(futuresBase, 'BTCUSDT', dailyLimit)
    if (btcK.length >= L) {
      const btc = btcK.slice(-L)
      btcCloses = btc.map((k) => k.close)
      btcMa5 = sma(btcCloses, 5)
      btcMa10 = sma(btcCloses, 10)
    }
  } catch {
    btcCloses = null
  }

  const washout = new Array(L).fill(false)
  const rebound = new Array(L).fill(false)
  for (let i = 19; i < L; i++) {
    const r = R[i]
    const b2 = B2[i]
    const b4 = B4[i]
    if (r == null || b2 == null || b4 == null) continue
    const btcBelow =
      btcCloses &&
      btcMa10 &&
      btcMa10[i] != null &&
      btcCloses[i] < btcMa10[i]
    washout[i] = r < -2 && b2 < 0.25 && b4 > 0.2 && !!btcBelow
  }

  /** Rebound: rise from 20d low + breadth recovery + BTC above MA5 + leaders green */
  const rLowWindow = 20
  for (let i = 20; i < L; i++) {
    let minR = Infinity
    for (let j = Math.max(0, i - rLowWindow); j < i; j++) {
      const v = R[j]
      if (v != null && Number.isFinite(v)) minR = Math.min(minR, v)
    }
    const r = R[i]
    const b2 = B2[i]
    if (r == null || minR === Infinity || !Number.isFinite(minR) || b2 == null) continue
    const rise = r - minR
    const btcOk =
      btcCloses &&
      btcMa5 &&
      btcMa5[i] != null &&
      btcCloses[i] > btcMa5[i]
    const moms = []
    for (let s = 0; s < nSyms; s++) {
      const m = mom5[s][i]
      if (m != null && Number.isFinite(m)) moms.push({ s, m })
    }
    moms.sort((a, b) => b.m - a.m)
    const top10 = moms.slice(0, 10)
    const leadersPos = top10.length >= 5 && top10.every((x) => x.m > 0)
    rebound[i] = rise >= 0.75 && b2 > 0.5 && !!btcOk && leadersPos
  }

  /** Divergence heuristics (last 30 bars) */
  const divLookback = Math.min(30, L - 1)
  const lastI = L - 1
  let bullishDiv = false
  let bearishDiv = false
  if (lastI >= divLookback && btcCloses) {
    let btcMin = Infinity
    let btcMax = -Infinity
    let rAtBtcMin = null
    let rAtBtcMax = null
    for (let i = lastI - divLookback; i <= lastI; i++) {
      const b = btcCloses[i]
      if (b < btcMin) {
        btcMin = b
        rAtBtcMin = R[i]
      }
      if (b > btcMax) {
        btcMax = b
        rAtBtcMax = R[i]
      }
    }
    const btcLL = btcCloses[lastI] <= btcMin * 1.002
    const rNotLL = rAtBtcMin != null && R[lastI] != null && R[lastI] > rAtBtcMin + 0.2
    const b2Up = B2[lastI] != null && B2[lastI] > 0.45
    bullishDiv = btcLL && rNotLL && b2Up

    const btcHH = btcCloses[lastI] >= btcMax * 0.998
    const rWeak = rAtBtcMax != null && R[lastI] != null && R[lastI] < rAtBtcMax - 0.2
    const b3Weak = B3[lastI] != null && B3[lastI] < 0.4
    bearishDiv = btcHH && rWeak && b3Weak
  }

  function rankAt(i) {
    const rows = []
    for (let s = 0; s < nSyms; s++) {
      const m = mom20[s][i]
      const v = vol20[s][i]
      if (m == null || v == null || v < 1e-12) continue
      rows.push({
        symbol: valid[s].symbol,
        mom20: m,
        vol20: v,
        invVol: 1 / v,
        close: closes[s][i],
        ma10: ma10[s][i],
      })
    }
    rows.sort((a, b) => b.mom20 - a.mom20)
    const topK = rows.slice(0, K)
    const bottomK = rows.slice(-K)
    return { rows, topK, bottomK }
  }

  function volWeights(candidates) {
    if (!candidates.length) return []
    let raw = candidates.map((c) => ({
      ...c,
      rawW: c.invVol,
    }))
    let sum = raw.reduce((s, x) => s + x.rawW, 0)
    if (sum <= 0) return []
    let w = raw.map((x) => ({ ...x, weight: (x.rawW / sum) * grossBookCap }))
    w = w.map((x) => ({
      ...x,
      weight: Math.min(x.weight, maxWeightPerName),
    }))
    sum = w.reduce((s, x) => s + x.weight, 0)
    if (sum > 1e-12) {
      w = w.map((x) => ({ ...x, weight: (x.weight / sum) * grossBookCap }))
    }
    return w
  }

  const last = L - 1
  const { rows: rankRows, topK, bottomK } = rankAt(last)
  const reg = regime[last]
  let longPicks = []
  let shortPicks = []
  if (reg === 'bull') longPicks = volWeights(topK)
  if (reg === 'bear') shortPicks = volWeights(bottomK)

  const hedgeLongFromShort =
    reg === 'bull' ? volWeights(bottomK.slice(0, 3)) : []
  const hedgeShortFromLong =
    reg === 'bear' ? volWeights(topK.slice(0, 3)) : []

  const symIndex = {}
  for (let s = 0; s < nSyms; s++) symIndex[valid[s].symbol] = s

  /** Simplified: portfolio from signal at close i−1; day-i return on closes; daily rebalance. */
  const simStart = Math.min(L - 2, Math.max(zWindow + 25, 40))
  let equity = 1
  const equityCurve = []
  const feeRate = feeBpsRoundTrip / 10000

  for (let i = simStart; i < L; i++) {
    const sig = i - 1
    const regSig = regime[sig]
    const { topK: tk, bottomK: bk } = rankAt(sig)
    let pnl = 0
    if (regSig === 'bull') {
      const w = volWeights(tk)
      for (const p of w) {
        const sIdx = symIndex[p.symbol]
        const r = ret[sIdx][i]
        if (r == null || !Number.isFinite(r)) continue
        pnl += p.weight * (r / 100)
      }
    } else if (regSig === 'bear') {
      const w = volWeights(bk)
      for (const p of w) {
        const sIdx = symIndex[p.symbol]
        const r = ret[sIdx][i]
        if (r == null || !Number.isFinite(r)) continue
        pnl -= p.weight * (r / 100)
      }
    }
    equity *= 1 + pnl
    equity *= 1 - feeRate / 252
    equityCurve.push({
      openTime: times[i],
      equity,
      regime: regime[i],
    })
  }

  const history = []
  const histFrom = Math.max(0, L - 400)
  for (let i = histFrom; i < L; i++) {
    if (R[i] == null) continue
    history.push({
      openTime: times[i],
      B1: B1[i],
      B2: B2[i],
      B3: B3[i],
      B4: B4[i],
      Z1: Z1[i],
      Z2: Z2[i],
      Z3: Z3[i],
      regimeScore: R[i],
      slope: slope[i],
      regime: regime[i],
      washout: washout[i],
      rebound: rebound[i],
      nActive: nActive[i],
    })
  }

  const latest = {
    openTime: times[last],
    regime: reg,
    regimeScore: R[last],
    slope: slope[last],
    B1: B1[last],
    B2: B2[last],
    B3: B3[last],
    B4: B4[last],
    Z1: Z1[last],
    Z2: Z2[last],
    Z3: Z3[last],
    washout: washout[last],
    rebound: rebound[last],
    bullishDivergence: bullishDiv,
    bearishDivergence: bearishDiv,
    nCoins: nSyms,
    nActive: nActive[last],
    longPicks,
    shortPicks,
    versionB: {
      hedgeLongPct25: reg === 'bull' ? hedgeLongFromShort : [],
      hedgeShortPct25: reg === 'bear' ? hedgeShortFromLong : [],
    },
    rules: {
      topK: K,
      bucketExit: 2 * K,
      maxHoldDays: 15,
      regimeThreshold,
      zWindow,
      washout: 'R < -2, B2 < 0.25, B4 > 0.20, BTC < MA10',
      rebound:
        'R up ≥0.75 from 20d low, B2 > 0.50, BTC > MA5, top 10 by MOM5 all > 0',
      exits:
        'Regime change, fall out of top/bottom 2K bucket, close vs 10d MA, or max 15 sessions',
    },
  }

  return {
    fetchedAt: new Date().toISOString(),
    params: {
      minQuoteVolume,
      maxSymbols,
      dailyLimit,
      minHistoryDays,
      zWindow,
      K,
      regimeThreshold,
      weights: { z1: w1, z2: w2, z3: w3 },
      maxWeightPerName,
      grossBookCap,
      feeBpsRoundTrip,
    },
    universe: {
      requested: candidateSymbols.length,
      used: nSyms,
      minQuoteVolume,
    },
    latest,
    history,
    simulation: {
      note:
        'Simplified daily mark-to-market with round-trip fee estimate on position changes. Not funding/slippage.',
      finalEquity: equity,
      equityCurve: equityCurve.slice(-120),
    },
    rankUniverse: rankRows.slice(0, 40).map((r) => ({
      symbol: r.symbol,
      mom20: r.mom20,
      vol20: r.vol20,
    })),
  }
}
