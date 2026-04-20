import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'
import { longSpikeIndicesForAgent1Scan, shortSpikeIndicesForAgent3Scan } from './fiveMinScreener.js'
import { simulateLongTrade, simulateShortRedSpikeTrade } from './spikeTpSlBacktest.js'
import { computeFutures24hVolumes } from './volumeScreener.js'

export const AGENT1_SHADOW_DEFAULT_BAR_COUNT = 1000
export const AGENT1_SHADOW_MIN_QUOTE_VOLUME_FLOOR = 10_000_000
export const AGENT1_SHADOW_REGIME_EMA_PERIOD = 50
/** Take-profit multiple of spike R in shadow replay (long: TP = entry + R×tpR; short: entry − R×tpR). Not in DB. */
export const AGENT1_SHADOW_REPLAY_TP_R = 2

function parseKlineRow(k) {
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }
}

/**
 * @param {string} futuresBase
 * @param {string} symbol
 * @param {string} interval
 * @param {number} limit — clamped [50, 1500]
 */
export async function fetchAgent1ShadowKlines(futuresBase, symbol, interval, limit) {
  const n = Math.min(1500, Math.max(50, Math.floor(limit) || AGENT1_SHADOW_DEFAULT_BAR_COUNT))
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(n))
  const q = new URLSearchParams({
    symbol,
    interval: String(interval ?? '5m').trim(),
    limit: String(n),
  })
  const r = await fetch(`${futuresBase}/fapi/v1/klines?${q}`)
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : []
  } catch {
    throw new Error(`Binance klines: invalid JSON (${r.status})`)
  }
  if (!r.ok) {
    const msg = data?.msg || data?.message || text
    throw new Error(`Binance ${r.status}: ${msg}`)
  }
  if (!Array.isArray(data)) throw new Error('Unexpected klines response')
  return data.map(parseKlineRow)
}

/**
 * Long-only replay: same non-overlapping rule as spike TP/SL backtest; spike definition matches Agent 1 scan (body/wick, direction).
 *
 * @param {ReturnType<parseKlineRow>[]} candles — chronological OHLC
 * @param {object} opts
 */
export function replayAgent1ShadowLongTrades(candles, opts) {
  const thresholdPct = Number(opts.thresholdPct)
  const maxSlPct = Number(opts.maxSlPct)
  const spikeMetric = opts.spikeMetric ?? 'body'
  const scanDirection = opts.scanDirection ?? 'both'
  const tpR = Number(opts.tpR ?? 2)
  const indices = longSpikeIndicesForAgent1Scan(
    candles,
    Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : 3,
    spikeMetric,
    scanDirection,
  )
  let lastExitBar = -1
  const trades = []
  for (const si of indices) {
    if (si + 1 <= lastExitBar) continue
    const tr = simulateLongTrade(candles, si, {
      maxSlPct: Number.isFinite(maxSlPct) && maxSlPct > 0 ? maxSlPct : undefined,
      tpR: Number.isFinite(tpR) && tpR > 0 ? tpR : 2,
    })
    if (!tr) continue
    trades.push(tr)
    lastExitBar = tr.exitBarIndex
  }
  return trades
}

/**
 * Short-only replay: non-overlapping; down spikes per Agent 3 scan metric; exits via simulateShortRedSpikeTrade.
 */
export function replayAgent3ShadowShortTrades(candles, opts) {
  const thresholdPct = Number(opts.thresholdPct)
  const maxSlPct = Number(opts.maxSlPct)
  const spikeMetric = opts.spikeMetric ?? 'body'
  const scanDirection = opts.scanDirection ?? 'down'
  const tpR = Number(opts.tpR ?? 2)
  const indices = shortSpikeIndicesForAgent3Scan(
    candles,
    Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : 3,
    spikeMetric,
    scanDirection,
  )
  let lastExitBar = -1
  const trades = []
  for (const si of indices) {
    if (si + 1 <= lastExitBar) continue
    const tr = simulateShortRedSpikeTrade(candles, si, {
      maxSlPct: Number.isFinite(maxSlPct) && maxSlPct > 0 ? maxSlPct : undefined,
      tpR: Number.isFinite(tpR) && tpR > 0 ? tpR : 2,
    })
    if (!tr) continue
    trades.push(tr)
    lastExitBar = tr.exitBarIndex
  }
  return trades
}

function tradePriceReturnPctLong(t) {
  const e = t.entryPrice ?? t.entry
  const x = t.exitPrice
  if (!Number.isFinite(e) || e === 0 || !Number.isFinite(x)) return 0
  return ((x - e) / e) * 100
}

function tradePriceReturnPctShort(t) {
  const e = t.entryPrice ?? t.entry
  const x = t.exitPrice
  if (!Number.isFinite(e) || e === 0 || !Number.isFinite(x)) return 0
  return ((e - x) / e) * 100
}

/** Cumulative sum of closed-trade price %; one point per close (v1: no open-trade mark-to-market). */
export function buildAgent1ShadowCurveClosedTrades(tradesChronAsc) {
  const curve = []
  let cum = 0
  for (let i = 0; i < tradesChronAsc.length; i++) {
    const t = tradesChronAsc[i]
    const pct = tradePriceReturnPctLong(t)
    cum += pct
    curve.push({
      tradeIndex: i + 1,
      time: t.exitOpenTime,
      pnlPct: pct,
      cumulativePnlPct: cum,
      equityBase100: 100 + cum,
      outcome: t.outcome,
      spikeOpenTime: t.spikeOpenTime,
      entryOpenTime: t.entryOpenTime,
      symbol: t.symbol ?? null,
    })
  }
  return curve
}

/** Cumulative Σ price % for closed short trades (chronological by exit). */
export function buildAgent3ShadowCurveClosedTrades(tradesChronAsc) {
  const curve = []
  let cum = 0
  for (let i = 0; i < tradesChronAsc.length; i++) {
    const t = tradesChronAsc[i]
    const pct = tradePriceReturnPctShort(t)
    cum += pct
    curve.push({
      tradeIndex: i + 1,
      time: t.exitOpenTime,
      pnlPct: pct,
      cumulativePnlPct: cum,
      equityBase100: 100 + cum,
      outcome: t.outcome,
      spikeOpenTime: t.spikeOpenTime,
      entryOpenTime: t.entryOpenTime,
      symbol: t.symbol ?? null,
    })
  }
  return curve
}

/**
 * Open in the replay window = a trade still unresolved at window end (represented by eod at the final bar).
 * Closed = TP/SL or any historical close that is not the active end-of-window mark.
 */
export function splitClosedAndOpenShadowTrades(trades, lastBarOpenTime) {
  const closedTrades = []
  const openTrades = []
  const lastBar = Number(lastBarOpenTime)
  const hasLastBar = Number.isFinite(lastBar)
  for (const t of trades ?? []) {
    const isWindowOpen =
      t?.outcome === 'eod' &&
      hasLastBar &&
      Number.isFinite(Number(t?.exitOpenTime)) &&
      Number(t.exitOpenTime) === lastBar
    if (isWindowOpen) openTrades.push(t)
    else closedTrades.push(t)
  }
  return { closedTrades, openTrades }
}

/** Closed-trade curve + one aggregate mark-to-market point from current open trades. */
export function buildLiveCurveWithOpenTrades(closedCurve, openTrades, markTimeMs) {
  const out = Array.isArray(closedCurve) ? [...closedCurve] : []
  if (!Array.isArray(openTrades) || openTrades.length === 0) return out
  let openPnlPctSum = 0
  for (const t of openTrades) openPnlPctSum += tradePriceReturnPctLong(t)
  const base = out.length > 0 ? Number(out[out.length - 1].cumulativePnlPct) || 0 : 0
  const markTime = Number.isFinite(Number(markTimeMs))
    ? Number(markTimeMs)
    : out.length > 0
      ? out[out.length - 1].time
      : Date.now()
  out.push({
    tradeIndex: out.length + 1,
    time: markTime,
    pnlPct: openPnlPctSum,
    cumulativePnlPct: base + openPnlPctSum,
    equityBase100: 100 + base + openPnlPctSum,
    outcome: 'open_mark',
    isOpenAggregate: true,
    openCount: openTrades.length,
  })
  return out
}

/** Closed short curve + aggregate mark-to-market for open shorts. */
export function buildLiveCurveWithOpenTradesShort(closedCurve, openTrades, markTimeMs) {
  const out = Array.isArray(closedCurve) ? [...closedCurve] : []
  if (!Array.isArray(openTrades) || openTrades.length === 0) return out
  let openPnlPctSum = 0
  for (const t of openTrades) openPnlPctSum += tradePriceReturnPctShort(t)
  const base = out.length > 0 ? Number(out[out.length - 1].cumulativePnlPct) || 0 : 0
  const markTime = Number.isFinite(Number(markTimeMs))
    ? Number(markTimeMs)
    : out.length > 0
      ? out[out.length - 1].time
      : Date.now()
  out.push({
    tradeIndex: out.length + 1,
    time: markTime,
    pnlPct: openPnlPctSum,
    cumulativePnlPct: base + openPnlPctSum,
    equityBase100: 100 + base + openPnlPctSum,
    outcome: 'open_mark',
    isOpenAggregate: true,
    openCount: openTrades.length,
  })
  return out
}

function emaLastOnValues(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 2) return null
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let ema = sum / period
  const alpha = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    ema = values[i] * alpha + ema * (1 - alpha)
  }
  return ema
}

/**
 * Server-side regime snapshot from live curve (includes open-trade mark when present).
 * This is what execution logic should consume, not UI-local EMA calculations.
 */
export function buildShadowRegimeSnapshotFromLiveCurve(liveCurve, {
  emaPeriod = AGENT1_SHADOW_REGIME_EMA_PERIOD,
  source = 'sim',
  updatedAt = new Date().toISOString(),
} = {}) {
  const period = Number.isFinite(Number(emaPeriod)) ? Math.max(2, Math.floor(Number(emaPeriod))) : 50
  const values = (liveCurve ?? [])
    .map((p) => Number(p?.cumulativePnlPct))
    .filter((v) => Number.isFinite(v))
  const latestCumPnlPct = values.length > 0 ? values[values.length - 1] : null
  const emaValue = emaLastOnValues(values, period)
  const ready = Number.isFinite(emaValue)
  const isAboveEma = ready && Number.isFinite(latestCumPnlPct) ? latestCumPnlPct > emaValue : null
  return {
    source,
    updatedAt,
    emaPeriod: period,
    latestCumPnlPct,
    emaValue,
    isAboveEma,
    gateAllowLong: Boolean(isAboveEma),
    sampleSize: values.length,
  }
}

function calcLongRMultipleAtPrice(t, markPrice) {
  const entry = Number(t?.entryPrice ?? t?.entry)
  const r = Number(t?.R)
  const px = Number(markPrice)
  if (!Number.isFinite(entry) || !Number.isFinite(r) || !(r > 0) || !Number.isFinite(px)) return null
  return (px - entry) / r
}

function calcShortRMultipleAtPrice(t, markPrice) {
  const entry = Number(t?.entryPrice ?? t?.entry)
  const r = Number(t?.R)
  const px = Number(markPrice)
  if (!Number.isFinite(entry) || !Number.isFinite(r) || !(r > 0) || !Number.isFinite(px)) return null
  return (entry - px) / r
}

/**
 * Mark open trades with a latest live price map.
 * @param {Array<object>} openTradesRaw
 * @param {Map<string, number>} latestPriceBySymbol
 * @param {number} markTimeMs
 */
export function markOpenTradesWithLatestPrices(openTradesRaw, latestPriceBySymbol, markTimeMs) {
  const out = []
  for (const t of openTradesRaw ?? []) {
    const sym = String(t?.symbol ?? '').toUpperCase()
    const livePx = latestPriceBySymbol.get(sym)
    const markPx = Number.isFinite(Number(livePx)) ? Number(livePx) : Number(t?.exitPrice)
    const rMul = calcLongRMultipleAtPrice(t, markPx)
    out.push({
      ...t,
      exitPrice: Number.isFinite(markPx) ? markPx : t?.exitPrice,
      exitOpenTime: Number.isFinite(Number(markTimeMs)) ? Number(markTimeMs) : t?.exitOpenTime,
      outcome: 'open_live',
      rMultiple: Number.isFinite(rMul) ? rMul : t?.rMultiple ?? null,
    })
  }
  return out
}

/**
 * Mark open **short** trades with latest mid prices (same shape as long mark helper).
 */
export function markOpenShortTradesWithLatestPrices(openTradesRaw, latestPriceBySymbol, markTimeMs) {
  const out = []
  for (const t of openTradesRaw ?? []) {
    const sym = String(t?.symbol ?? '').toUpperCase()
    const livePx = latestPriceBySymbol.get(sym)
    const markPx = Number.isFinite(Number(livePx)) ? Number(livePx) : Number(t?.exitPrice)
    const rMul = calcShortRMultipleAtPrice(t, markPx)
    out.push({
      ...t,
      exitPrice: Number.isFinite(markPx) ? markPx : t?.exitPrice,
      exitOpenTime: Number.isFinite(Number(markTimeMs)) ? Number(markTimeMs) : t?.exitOpenTime,
      outcome: 'open_live',
      rMultiple: Number.isFinite(rMul) ? rMul : t?.rMultiple ?? null,
    })
  }
  return out
}

export function summarizeTradeForApi(t) {
  const isShort = String(t?.side ?? '').toLowerCase() === 'short'
  const tpN = Number(t?.tpPrice)
  const slN = Number(t?.slPrice)
  return {
    symbol: t.symbol ?? null,
    side: t.side ?? 'long',
    spikeOpenTime: t.spikeOpenTime,
    entryOpenTime: t.entryOpenTime,
    exitOpenTime: t.exitOpenTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    outcome: t.outcome,
    rMultiple: t.rMultiple,
    pnlPct: isShort ? tradePriceReturnPctShort(t) : tradePriceReturnPctLong(t),
    tpPrice: Number.isFinite(tpN) ? tpN : null,
    slPrice: Number.isFinite(slN) ? slN : null,
    spikeBarIndex: t.spikeBarIndex,
    entryBarIndex: t.entryBarIndex,
    exitBarIndex: t.exitBarIndex,
  }
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

/**
 * Market-wide shadow replay: 24h quote volume rank, min volume, scanMaxSymbols from **agent1_shadow_sim_config**
 * (Supabase) + optional runtime overrides, plus `AGENT1_SHADOW_MIN_QUOTE_VOLUME_FLOOR`.
 * One kline fetch per symbol; replays long and short legs on the same candles, then merges each side’s closed
 * trades by exit time (portfolio-style cumulative %). Kline interval is shadow sim `scanInterval`.
 */
export async function runMarketWideAgent1ShadowReplay(futuresBase, settingsAgent1, barCount, settingsAgent3) {
  const minQuoteVolume = Number(settingsAgent1.scanMinQuoteVolume)
  const maxSymbols = Number(settingsAgent1.scanMaxSymbols)
  const effectiveMinQuoteVolume = Math.max(
    AGENT1_SHADOW_MIN_QUOTE_VOLUME_FLOOR,
    Number.isFinite(minQuoteVolume) && minQuoteVolume >= 0 ? minQuoteVolume : 0,
  )
  const volumeRows = await computeFutures24hVolumes(futuresBase)
  const filtered = volumeRows.filter((r) => r.quoteVolume24h >= effectiveMinQuoteVolume)
  const hardCap = 800
  const cap =
    Number.isFinite(maxSymbols) && maxSymbols > 0
      ? Math.min(hardCap, maxSymbols)
      : Math.min(hardCap, 600)
  const selected = filtered.slice(0, cap)

  const n = Math.min(1500, Math.max(50, Math.floor(barCount) || AGENT1_SHADOW_DEFAULT_BAR_COUNT))
  const concRaw = Number.parseInt(
    process.env.AGENT1_SHADOW_CONCURRENCY ?? process.env.FIVEMIN_SCREENER_CONCURRENCY ?? '18',
    10,
  )
  const CONCURRENCY = Math.min(
    24,
    Math.max(4, Number.isFinite(concRaw) && concRaw > 0 ? concRaw : 18),
  )

  const tradeOptsA1 = {
    thresholdPct: settingsAgent1.scanThresholdPct,
    maxSlPct: settingsAgent1.maxSlPct,
    spikeMetric: settingsAgent1.scanSpikeMetric,
    scanDirection: settingsAgent1.scanDirection,
    tpR: AGENT1_SHADOW_REPLAY_TP_R,
  }
  const a3 = settingsAgent3 && typeof settingsAgent3 === 'object' ? settingsAgent3 : {}
  const tradeOptsA3 = {
    thresholdPct: a3.scanThresholdPct,
    maxSlPct: a3.maxSlPct,
    spikeMetric: a3.scanSpikeMetric,
    scanDirection: a3.scanDirection,
    tpR: AGENT1_SHADOW_REPLAY_TP_R,
  }

  const raw = await mapPool(selected, CONCURRENCY, async (row) => {
    try {
      const candles = await fetchAgent1ShadowKlines(
        futuresBase,
        row.symbol,
        settingsAgent1.scanInterval,
        n,
      )
      if (!candles.length) {
        return {
          symbol: row.symbol,
          candlesLen: 0,
          lastOpen: null,
          tradesLong: [],
          tradesShort: [],
          error: null,
        }
      }
      const tradesLong = replayAgent1ShadowLongTrades(candles, tradeOptsA1).map((t) => ({
        ...t,
        symbol: row.symbol,
      }))
      const tradesShort = replayAgent3ShadowShortTrades(candles, tradeOptsA3).map((t) => ({
        ...t,
        symbol: row.symbol,
      }))
      const last = candles[candles.length - 1]
      return {
        symbol: row.symbol,
        candlesLen: candles.length,
        lastOpen: last.openTime,
        tradesLong,
        tradesShort,
        error: null,
      }
    } catch (e) {
      return {
        symbol: row.symbol,
        candlesLen: 0,
        lastOpen: null,
        tradesLong: [],
        tradesShort: [],
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })

  const allClosedTrades = []
  const allOpenTrades = []
  const allClosedTradesA3 = []
  const allOpenTradesA3 = []
  let symbolsErrored = 0
  let symbolsWithData = 0
  let maxLastBar = null
  for (const r of raw) {
    if (r.error) {
      symbolsErrored += 1
      continue
    }
    if (r.candlesLen > 0) symbolsWithData += 1
    const splitL = splitClosedAndOpenShadowTrades(r.tradesLong, r.lastOpen)
    const splitS = splitClosedAndOpenShadowTrades(r.tradesShort, r.lastOpen)
    allClosedTrades.push(...splitL.closedTrades)
    allOpenTrades.push(...splitL.openTrades)
    allClosedTradesA3.push(...splitS.closedTrades)
    allOpenTradesA3.push(...splitS.openTrades)
    if (r.lastOpen != null && (maxLastBar == null || r.lastOpen > maxLastBar)) {
      maxLastBar = r.lastOpen
    }
  }

  const sortChron = (a, b) => {
    const ta = a.exitOpenTime ?? 0
    const tb = b.exitOpenTime ?? 0
    if (ta !== tb) return ta - tb
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
  }
  allClosedTrades.sort(sortChron)
  allClosedTradesA3.sort(sortChron)
  allOpenTrades.sort((a, b) => String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')))
  allOpenTradesA3.sort((a, b) => String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')))

  const curve = buildAgent1ShadowCurveClosedTrades(allClosedTrades)
  const liveCurve = buildLiveCurveWithOpenTrades(curve, allOpenTrades, maxLastBar)
  const curveAgent3 = buildAgent3ShadowCurveClosedTrades(allClosedTradesA3)
  const liveCurveAgent3 = buildLiveCurveWithOpenTradesShort(curveAgent3, allOpenTradesA3, maxLastBar)

  return {
    universe: {
      symbolsRequested: selected.length,
      symbolsWithData,
      symbolsErrored,
      barCountPerSymbol: n,
      effectiveMinQuoteVolume,
      klineInterval: settingsAgent1.scanInterval,
    },
    closedTrades: allClosedTrades,
    openTrades: allOpenTrades,
    closedTradesAgent3: allClosedTradesA3,
    openTradesAgent3: allOpenTradesA3,
    curve,
    liveCurve,
    curveAgent3,
    liveCurveAgent3,
    lastBarOpenTime: maxLastBar,
  }
}
