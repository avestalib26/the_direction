/**
 * Universe backtest: volume-filtered USDT-M perps, green-body spikes.
 *
 * Long (default): next open long, R = spike close − spike low, SL = entry − R, TP = entry + 2R.
 * Short (shortRedSpike): next open short after red-body spike, R = spike high − spike close, SL = entry + R, TP = entry − 2R.
 * Short (shortSpikeLow): next open short, same R as long on green spike, SL = entry + 2R, TP = spike low (cover when low tags).
 *
 * Optional: maxSlPct caps adverse stop distance as % of entry (tighter stop if model SL is wider).
 * Optional: slAtSpikeOpen — R and TP still from spike body/low rules; stop price is spike open (when valid vs entry).
 *
 * Risk unit for R-multiples: long uses R; short uses 2R (stop width). Pessimistic intrabar: SL before TP.
 * Unclosed trades exit at last close (EOD).
 */

import { computeFutures24hVolumes } from './volumeScreener.js'
import { binanceFuturesPublicHeaders } from './binancePublicHeaders.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'
import {
  attachBtcCloseToEquityPoints,
  candlesToBtcCloseMap,
} from './spikeTpSlEquityBtc.js'

/** Max UTC calendar-day span (inclusive) for fromDate → toDate. */
export const SPIKE_TPSL_MAX_RANGE_DAYS = 3

const KLINES_PAGE_LIMIT = 1500
const RANGE_FETCH_MAX_PAGES = 48

/** Keep HTTP JSON small so the UI does not freeze parsing/rendering huge arrays. */
const API_EQUITY_CURVE_MAX_POINTS = 2500
const API_PER_TRADE_PCT_MAX = 3500

/** Optional OHLC payloads for per-symbol candlestick charts (only symbols with ≥1 trade). */
const CHART_CANDLES_PER_SYMBOL_DEFAULT = 600
const CHART_SYMBOLS_MAX_DEFAULT = 48

/** Binance-style bar duration (ms) for aligning 5m EMA to the main backtest interval. */
const INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
})

const EMA_LONG_FILTER_PERIOD = 96
const EMA_LONG_FILTER_INTERVAL = '5m'
/** Extra 5m bars to load before the main window so EMA(96) is seeded for early spikes (not null). */
const EMA_5M_WARMUP_EXTRA_BARS = 100

function mainIntervalMs(interval) {
  const k = String(interval ?? '5m').trim()
  return INTERVAL_MS[k] ?? 300_000
}

/**
 * EMA with SMA seed on first `period` closes (standard). Returns array parallel to `candles`; null until seeded.
 */
function computeEmaArray(candles, period) {
  const out = candles.map(() => null)
  if (!Array.isArray(candles) || candles.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += candles[i].close
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

/** Largest j with candles5m[j].openTime <= mainOpenTime (5m bar that has started at or before this main open). */
function find5mIndexForMainOpenTime(candles5m, mainOpenTime) {
  if (!Array.isArray(candles5m) || candles5m.length === 0) return -1
  let lo = 0
  let hi = candles5m.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (candles5m[mid].openTime <= mainOpenTime) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function ema5mWarmupBarCount(mainCandles) {
  const n = mainCandles?.length ?? 0
  return Math.max(EMA_LONG_FILTER_PERIOD + EMA_5M_WARMUP_EXTRA_BARS, n + EMA_5M_WARMUP_EXTRA_BARS)
}

/** 5m candles with openTime in [firstMainOpen − warmup, firstMainOpen − 1], for EMA history before the backtest window. */
async function fetch5mPrefixBeforeMain(
  futuresBase,
  symbol,
  firstMainOpen,
  warmupBarCount,
  publicHeaders,
) {
  const ms5 = INTERVAL_MS['5m']
  const startTime = firstMainOpen - warmupBarCount * ms5
  const endTime = firstMainOpen - 1
  if (!Number.isFinite(firstMainOpen) || endTime < startTime) return []
  return fetchKlinesOHLCInRange(
    futuresBase,
    symbol,
    EMA_LONG_FILTER_INTERVAL,
    Math.max(0, startTime),
    endTime,
    publicHeaders,
  )
}

async function fetch5mOhlcAlignedToMain(
  futuresBase,
  symbol,
  mainCandles,
  interval,
  utcRange,
  publicHeaders,
) {
  if (!mainCandles?.length) return []
  const ivMs = mainIntervalMs(interval)
  const rangeStart = utcRange ? utcRange.startTime : mainCandles[0].openTime
  const last = mainCandles[mainCandles.length - 1]
  const endTime = utcRange ? utcRange.endTime : last.openTime + ivMs - 1
  if (endTime < rangeStart) return []
  const warmupBarCount = ema5mWarmupBarCount(mainCandles)
  const fetchStart = rangeStart - warmupBarCount * INTERVAL_MS['5m']
  return fetchKlinesOHLCInRange(
    futuresBase,
    symbol,
    EMA_LONG_FILTER_INTERVAL,
    Math.max(0, fetchStart),
    endTime,
    publicHeaders,
  )
}

function downsampleEquityCurvePoints(pts, maxPts) {
  if (!Array.isArray(pts) || pts.length === 0) return { points: pts ?? [], downsampled: false }
  if (pts.length <= maxPts) return { points: pts, downsampled: false }
  const out = []
  const last = pts.length - 1
  for (let i = 0; i < maxPts; i++) {
    const idx = Math.round((i / (maxPts - 1)) * last)
    out.push(pts[idx])
  }
  return { points: out, downsampled: true }
}

/** Same index picks as subsampleFloatSeries — use to keep parallel series aligned (e.g. OHLC + %). */
function subsampleArraySeries(arr, maxLen) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { values: arr ?? [], subsampled: false }
  }
  if (arr.length <= maxLen) {
    return { values: arr, subsampled: false }
  }
  const values = []
  const n = arr.length
  for (let k = 0; k < maxLen; k++) {
    const idx = Math.floor((k / (maxLen - 1)) * (n - 1))
    values.push(arr[idx])
  }
  return { values, subsampled: true }
}

function subsampleFloatSeries(arr, maxLen) {
  return subsampleArraySeries(arr, maxLen)
}

function parseUtcDayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (![y, mo, d].every((n) => Number.isFinite(n))) return null
  const t = Date.UTC(y, mo - 1, d)
  if (
    new Date(t).getUTCFullYear() !== y ||
    new Date(t).getUTCMonth() !== mo - 1 ||
    new Date(t).getUTCDate() !== d
  ) {
    return null
  }
  return t
}

/**
 * @returns {{ startTime: number, endTime: number, fromDate: string, toDate: string } | null}
 */
export function parseSpikeTpSlUtcRange(fromDate, toDate) {
  const f = String(fromDate ?? '').trim()
  const t = String(toDate ?? '').trim()
  if (!f && !t) return null
  if (!f || !t) {
    throw new Error('fromDate and toDate must both be set (YYYY-MM-DD, interpreted as UTC) or both omitted')
  }
  const fromMs = parseUtcDayStart(f)
  const toDayStart = parseUtcDayStart(t)
  if (fromMs == null || toDayStart == null) {
    throw new Error('fromDate and toDate must be valid UTC calendar dates as YYYY-MM-DD')
  }
  const toMsEnd = toDayStart + 86400000 - 1
  if (fromMs > toMsEnd) {
    throw new Error('fromDate must be on or before toDate')
  }
  const spanDays = (toDayStart + 86400000 - fromMs) / 86400000
  if (spanDays > SPIKE_TPSL_MAX_RANGE_DAYS) {
    throw new Error(`Historical range cannot exceed ${SPIKE_TPSL_MAX_RANGE_DAYS} UTC days (inclusive)`)
  }
  return { startTime: fromMs, endTime: toMsEnd, fromDate: f, toDate: t }
}

function mapKlineRow(k) {
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }
}

async function fetchKlinesOHLC(futuresBase, symbol, interval, limit, headers = {}) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) })
  const r = await fetch(`${futuresBase}/fapi/v1/klines?${q}`, { headers })
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Binance klines: invalid JSON (${r.status})`)
  }
  if (!r.ok) {
    const msg = data.msg || data.message || text
    throw new Error(`Binance ${r.status}: ${msg}`)
  }
  if (!Array.isArray(data)) throw new Error('Unexpected klines response')
  return data.map(mapKlineRow)
}

/**
 * All candles with openTime in [startTime, endTime], paginated (max KLINES_PAGE_LIMIT per request).
 */
async function fetchKlinesOHLCInRange(futuresBase, symbol, interval, startTime, endTime, headers = {}) {
  const byTime = new Map()
  let cursor = startTime
  const pageDelayMs = Number.parseInt(process.env.SPIKE_TPSL_PAGE_DELAY_MS ?? '0', 10)

  for (let page = 0; page < RANGE_FETCH_MAX_PAGES; page++) {
    const q = new URLSearchParams({
      symbol,
      interval,
      limit: String(KLINES_PAGE_LIMIT),
      startTime: String(cursor),
      endTime: String(endTime),
    })
    await acquireFuturesRestWeight(futuresKlinesRequestWeight(KLINES_PAGE_LIMIT))
    const r = await fetch(`${futuresBase}/fapi/v1/klines?${q}`, { headers })
    const text = await r.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`Binance klines: invalid JSON (${r.status})`)
    }
    if (!r.ok) {
      const msg = data.msg || data.message || text
      throw new Error(`Binance ${r.status}: ${msg}`)
    }
    if (!Array.isArray(data) || data.length === 0) break

    for (const k of data) {
      const ot = k[0]
      if (ot < startTime || ot > endTime) continue
      byTime.set(ot, mapKlineRow(k))
    }

    const lastOpen = data[data.length - 1][0]
    if (lastOpen >= endTime) break
    if (data.length < KLINES_PAGE_LIMIT) break
    cursor = lastOpen + 1
    if (cursor > endTime) break
    if (pageDelayMs > 0) await new Promise((res) => setTimeout(res, pageDelayMs))
  }

  return [...byTime.keys()]
    .sort((a, b) => a - b)
    .map((t) => byTime.get(t))
}

function isGreenBodySpike(c, thresholdPct) {
  if (!c || !Number.isFinite(c.open) || c.open === 0) return false
  if (!(c.close > c.open)) return false
  const bodyPct = ((c.close - c.open) / c.open) * 100
  return bodyPct >= thresholdPct
}

/** Red candle; body size vs open is at least thresholdPct (same convention as green). */
function isRedBodySpike(c, thresholdPct) {
  if (!c || !Number.isFinite(c.open) || c.open === 0) return false
  if (!(c.close < c.open)) return false
  const bodyPct = ((c.open - c.close) / c.open) * 100
  return bodyPct >= thresholdPct
}

function spikeBodyPct(sp) {
  if (!sp || !Number.isFinite(sp.open) || sp.open === 0) return null
  return ((sp.close - sp.open) / sp.open) * 100
}

function spikeSnapshot(sp) {
  return {
    spikeOpen: sp.open,
    spikeHigh: sp.high,
    spikeLow: sp.low,
    spikeClose: sp.close,
    spikeBodyPct: spikeBodyPct(sp),
  }
}

/** Inclusive candle count from entry bar (spikeIndex+1) through exit bar. 1 = exit on entry candle. */
function tradeBarMeta(spikeIndex, exitBarIndex) {
  const i = spikeIndex
  return {
    spikeBarIndex: i,
    entryBarIndex: i + 1,
    barsInTrade: exitBarIndex - i,
  }
}

/** Long: if both SL and TP are touched in the bar, assume SL first (conservative). */
function longBarOutcome(low, high, slPrice, tpPrice) {
  const hitSl = low <= slPrice
  const hitTp = high >= tpPrice
  if (hitSl && hitTp) return 'sl'
  if (hitSl) return 'sl'
  if (hitTp) return 'tp'
  return null
}

/** Long: cap how far below entry the stop may sit (max adverse % of entry). */
function capStopLong(entry, slPrice, maxSlPct) {
  if (maxSlPct == null || !Number.isFinite(maxSlPct) || maxSlPct <= 0) return slPrice
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(slPrice)) return slPrice
  const maxDist = entry * (maxSlPct / 100)
  const dist = entry - slPrice
  if (!(dist > 0)) return slPrice
  if (dist <= maxDist) return slPrice
  return entry - maxDist
}

/** Short: cap how far above entry the stop may sit (max adverse % of entry). */
function capStopShort(entry, slPrice, maxSlPct) {
  if (maxSlPct == null || !Number.isFinite(maxSlPct) || maxSlPct <= 0) return slPrice
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(slPrice)) return slPrice
  const maxDist = entry * (maxSlPct / 100)
  const dist = slPrice - entry
  if (!(dist > 0)) return slPrice
  if (dist <= maxDist) return slPrice
  return entry + maxDist
}

/** Short: SL above entry, TP below (spike low). If both touched same bar, SL first (conservative). */
function shortBarOutcome(low, high, slPrice, tpPrice) {
  const hitSl = high >= slPrice
  const hitTp = low <= tpPrice
  if (hitSl && hitTp) return 'sl'
  if (hitSl) return 'sl'
  if (hitTp) return 'tp'
  return null
}

function normalizeTpR(tradeOpts) {
  const raw = tradeOpts?.tpR
  const v = raw != null && raw !== '' ? Number(raw) : 2
  if (!Number.isFinite(v) || v <= 0) return 2
  return Math.min(Math.max(v, 0.1), 100)
}

function emaLastOnNumberSeries(values, period) {
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

export function simulateLongTrade(candles, spikeIndex, tradeOpts = {}) {
  const maxSlPct = tradeOpts.maxSlPct
  const slAtSpikeOpen = Boolean(tradeOpts.slAtSpikeOpen)
  const tpR = normalizeTpR(tradeOpts)
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.close - sp.low
  if (!(R > 0) || !Number.isFinite(R)) return null

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  let slPrice = slAtSpikeOpen ? sp.open : entry - R
  if (!Number.isFinite(slPrice) || !(slPrice < entry)) return null
  slPrice = capStopLong(entry, slPrice, maxSlPct)
  if (!Number.isFinite(slPrice) || !(slPrice < entry)) return null
  const tpPrice = entry + tpR * R

  for (let j = i + 1; j < candles.length; j++) {
    const { low, high, openTime } = candles[j]
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue
    const o = longBarOutcome(low, high, slPrice, tpPrice)
    if (o === 'sl') {
      return {
        side: 'long',
        spikeOpenTime: sp.openTime,
        entryOpenTime: candles[i + 1].openTime,
        entryPrice: entry,
        exitPrice: slPrice,
        entry,
        R,
        slPrice,
        tpPrice,
        outcome: 'sl',
        rMultiple: -1,
        exitOpenTime: openTime,
        exitBarIndex: j,
        ...tradeBarMeta(i, j),
        ...spikeSnapshot(sp),
      }
    }
    if (o === 'tp') {
      return {
        side: 'long',
        spikeOpenTime: sp.openTime,
        entryOpenTime: candles[i + 1].openTime,
        entryPrice: entry,
        exitPrice: tpPrice,
        entry,
        R,
        slPrice,
        tpPrice,
        outcome: 'tp',
        rMultiple: tpR,
        exitOpenTime: openTime,
        exitBarIndex: j,
        ...tradeBarMeta(i, j),
        ...spikeSnapshot(sp),
      }
    }
  }

  const last = candles[candles.length - 1]
  const close = last.close
  const rMultiple = Number.isFinite(close) ? (close - entry) / R : 0
  const exitIdx = candles.length - 1
  return {
    side: 'long',
    spikeOpenTime: sp.openTime,
    entryOpenTime: candles[i + 1].openTime,
    entryPrice: entry,
    exitPrice: Number.isFinite(close) ? close : null,
    entry,
    R,
    slPrice,
    tpPrice,
    outcome: 'eod',
    rMultiple,
    exitOpenTime: last.openTime,
    exitBarIndex: exitIdx,
    ...tradeBarMeta(i, exitIdx),
    ...spikeSnapshot(sp),
  }
}

/**
 * Short at next open after red-body spike. R = spike high − spike close. SL = entry + R, TP = entry − 2R.
 * Mirror of long green-spike 2R/1R; pessimistic intrabar uses shortBarOutcome.
 */
function simulateShortRedSpikeTrade(candles, spikeIndex, tradeOpts = {}) {
  const maxSlPct = tradeOpts.maxSlPct
  const slAtSpikeOpen = Boolean(tradeOpts.slAtSpikeOpen)
  const tpR = normalizeTpR(tradeOpts)
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.high - sp.close
  if (!(R > 0) || !Number.isFinite(R)) return null

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  let slPrice = slAtSpikeOpen ? sp.open : entry + R
  if (!Number.isFinite(slPrice) || !(slPrice > entry)) return null
  slPrice = capStopShort(entry, slPrice, maxSlPct)
  if (!Number.isFinite(slPrice) || !(slPrice > entry)) return null
  const tpPrice = entry - tpR * R

  for (let j = i + 1; j < candles.length; j++) {
    const { low, high, openTime } = candles[j]
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue
    const o = shortBarOutcome(low, high, slPrice, tpPrice)
    if (o === 'sl') {
      return {
        side: 'short',
        spikeOpenTime: sp.openTime,
        entryOpenTime: candles[i + 1].openTime,
        entryPrice: entry,
        exitPrice: slPrice,
        entry,
        R,
        slPrice,
        tpPrice,
        outcome: 'sl',
        rMultiple: -1,
        exitOpenTime: openTime,
        exitBarIndex: j,
        ...tradeBarMeta(i, j),
        ...spikeSnapshot(sp),
      }
    }
    if (o === 'tp') {
      return {
        side: 'short',
        spikeOpenTime: sp.openTime,
        entryOpenTime: candles[i + 1].openTime,
        entryPrice: entry,
        exitPrice: tpPrice,
        entry,
        R,
        slPrice,
        tpPrice,
        outcome: 'tp',
        rMultiple: tpR,
        exitOpenTime: openTime,
        exitBarIndex: j,
        ...tradeBarMeta(i, j),
        ...spikeSnapshot(sp),
      }
    }
  }

  const last = candles[candles.length - 1]
  const close = last.close
  const rMultiple = Number.isFinite(close) ? (entry - close) / R : 0
  const exitIdx = candles.length - 1
  return {
    side: 'short',
    spikeOpenTime: sp.openTime,
    entryOpenTime: candles[i + 1].openTime,
    entryPrice: entry,
    exitPrice: Number.isFinite(close) ? close : null,
    entry,
    R,
    slPrice,
    tpPrice,
    outcome: 'eod',
    rMultiple,
    exitOpenTime: last.openTime,
    exitBarIndex: exitIdx,
    ...tradeBarMeta(i, exitIdx),
    ...spikeSnapshot(sp),
  }
}

/**
 * Short at next open after green spike. R = spike close − spike low. Stop entry + tpR×R. TP = spike low.
 * Risk unit = 2R (full stop width): SL → −1R, TP → +(entry − spike low) / (2R). Skips if entry ≤ spike low.
 */
function simulateShortSpikeLowTrade(candles, spikeIndex, tradeOpts = {}) {
  const maxSlPct = tradeOpts.maxSlPct
  const slAtSpikeOpen = Boolean(tradeOpts.slAtSpikeOpen)
  const tpR = normalizeTpR(tradeOpts)
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.close - sp.low
  if (!(R > 0) || !Number.isFinite(R)) return null

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  const tpPrice = sp.low
  if (!(entry > tpPrice)) return null

  let riskWidth
  let slPrice
  if (slAtSpikeOpen) {
    slPrice = sp.open
    if (!Number.isFinite(slPrice) || !(slPrice > entry)) return null
    riskWidth = slPrice - entry
  } else {
    riskWidth = tpR * R
    slPrice = entry + riskWidth
  }
  slPrice = capStopShort(entry, slPrice, maxSlPct)
  riskWidth = slPrice - entry
  if (!(riskWidth > 0) || !Number.isFinite(slPrice) || !(slPrice > entry)) return null

  for (let j = i + 1; j < candles.length; j++) {
    const { low, high, openTime } = candles[j]
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue
    const o = shortBarOutcome(low, high, slPrice, tpPrice)
    if (o === 'sl') {
      return {
        side: 'short',
        spikeOpenTime: sp.openTime,
        entryOpenTime: candles[i + 1].openTime,
        entryPrice: entry,
        exitPrice: slPrice,
        entry,
        R,
        riskWidth,
        slPrice,
        tpPrice,
        outcome: 'sl',
        rMultiple: -1,
        exitOpenTime: openTime,
        exitBarIndex: j,
        ...tradeBarMeta(i, j),
        ...spikeSnapshot(sp),
      }
    }
    if (o === 'tp') {
      const rMultiple = (entry - tpPrice) / riskWidth
      return {
        side: 'short',
        spikeOpenTime: sp.openTime,
        entryOpenTime: candles[i + 1].openTime,
        entryPrice: entry,
        exitPrice: tpPrice,
        entry,
        R,
        riskWidth,
        slPrice,
        tpPrice,
        outcome: 'tp',
        rMultiple,
        exitOpenTime: openTime,
        exitBarIndex: j,
        ...tradeBarMeta(i, j),
        ...spikeSnapshot(sp),
      }
    }
  }

  const last = candles[candles.length - 1]
  const close = last.close
  const rMultiple = Number.isFinite(close) ? (entry - close) / riskWidth : 0
  const exitIdx = candles.length - 1
  return {
    side: 'short',
    spikeOpenTime: sp.openTime,
    entryOpenTime: candles[i + 1].openTime,
    entryPrice: entry,
    exitPrice: Number.isFinite(close) ? close : null,
    entry,
    R,
    riskWidth,
    slPrice,
    tpPrice,
    outcome: 'eod',
    rMultiple,
    exitOpenTime: last.openTime,
    exitBarIndex: exitIdx,
    ...tradeBarMeta(i, exitIdx),
    ...spikeSnapshot(sp),
  }
}

function spikeIndices(candles, thresholdPct, strategy = 'long') {
  const out = []
  for (let i = 0; i < candles.length - 1; i++) {
    const c = candles[i]
    if (strategy === 'shortRedSpike') {
      if (isRedBodySpike(c, thresholdPct)) out.push(i)
    } else if (isGreenBodySpike(c, thresholdPct)) {
      out.push(i)
    }
  }
  return out
}

/** Per-trade % move in price: long (exit−entry)/entry, short (entry−exit)/entry. */
function tradePriceReturnPct(t) {
  const e = t.entryPrice ?? t.entry
  const x = t.exitPrice
  if (!Number.isFinite(e) || e === 0 || !Number.isFinite(x)) return 0
  if (t.side === 'short') return ((e - x) / e) * 100
  return ((x - e) / e) * 100
}

/** Win/loss for chart: TP always win, SL always loss; EOD by signed price %. */
function tradeWinLossBucket(t) {
  if (t.outcome === 'tp') return 'win'
  if (t.outcome === 'sl') return 'loss'
  const p = tradePriceReturnPct(t)
  if (p > 0) return 'win'
  if (p < 0) return 'loss'
  return 'breakeven'
}

/**
 * Cumulative curve: running sum of per-trade price % (not compounded).
 * pnlPctFromStart = Σ tradePriceReturnPct; equityPct = 100 + that sum (reference scale only).
 */
function buildEquityCurveSummedPricePct(tradesChronAsc) {
  const pts = [
    {
      tradeIndex: 0,
      entryOpenTime: null,
      equityPct: 100,
      pnlPctFromStart: 0,
    },
  ]
  let cum = 0
  for (let k = 0; k < tradesChronAsc.length; k++) {
    const t = tradesChronAsc[k]
    cum += tradePriceReturnPct(t)
    pts.push({
      tradeIndex: k + 1,
      entryOpenTime: t.entryOpenTime,
      equityPct: 100 + cum,
      pnlPctFromStart: cum,
    })
  }
  return { points: pts }
}

/**
 * @param {object | null} emaCtx — when set and strategy is long: require entry open > EMA(96) on 5m at spike bar.
 * @param {string} emaCtx.symbol
 * @param {ReturnType<typeof mapKlineRow>[]} emaCtx.candles5m
 * @param {(number | null)[]} emaCtx.emaArr
 */
function runSymbolTrades(candles, thresholdPct, strategy = 'long', tradeOpts = {}, emaCtx = null) {
  let sim = simulateLongTrade
  if (strategy === 'shortSpikeLow') sim = simulateShortSpikeLowTrade
  else if (strategy === 'shortRedSpike') sim = simulateShortRedSpikeTrade
  const spikes = spikeIndices(candles, thresholdPct, strategy)
  let lastExitBar = -1
  const trades = []
  const emaSkipped = []

  for (const si of spikes) {
    // Entry is at open of bar si+1; allow spike si when that entry bar is after the prior exit bar.
    if (si + 1 <= lastExitBar) continue

    if (emaCtx && strategy === 'long') {
      const entryOpen = candles[si + 1].open
      const spikeOpenTime = candles[si].openTime
      const entryOpenTime = candles[si + 1].openTime
      const j = find5mIndexForMainOpenTime(emaCtx.candles5m, spikeOpenTime)
      const emaVal = j >= 0 && j < emaCtx.emaArr.length ? emaCtx.emaArr[j] : null
      if (emaVal == null || !Number.isFinite(emaVal) || !(entryOpen > emaVal)) {
        emaSkipped.push({
          symbol: emaCtx.symbol,
          spikeOpenTime,
          entryOpenTime,
          reason: 'ema96_5m',
        })
        continue
      }
    }

    const tr = sim(candles, si, tradeOpts)
    if (!tr) continue
    trades.push(tr)
    lastExitBar = tr.exitBarIndex
  }
  return { trades, emaSkipped }
}

/**
 * Regime flip mode (global):
 * - If cumulative equity is above EMA(50): take long setup.
 * - If cumulative equity is below EMA(50): take short setup (TP spike low, SL +2R style).
 * Uses green spikes as the trigger set for both branches.
 */
function runRegimeFlipTradesGlobal(rawRows, thresholdPct, tradeOpts = {}) {
  const events = []
  for (const row of rawRows) {
    if (row?.error || !Array.isArray(row?.candles)) continue
    const spikes = spikeIndices(row.candles, thresholdPct, 'long')
    for (const si of spikes) {
      const entryBar = row.candles[si + 1]
      if (!entryBar) continue
      events.push({
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        candles: row.candles,
        spikeIndex: si,
        entryOpenTime: entryBar.openTime,
      })
    }
  }
  events.sort((a, b) => {
    if (a.entryOpenTime !== b.entryOpenTime) return a.entryOpenTime - b.entryOpenTime
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
  })

  const regimeEmaPeriod = 50
  const shortTradeOpts = { ...tradeOpts, tpR: 2 }
  const lastExitBySymbol = new Map()
  const perSymbolTrades = new Map()
  const cumulativeAfterTrade = []
  let cumulativePnlPct = 0

  for (const ev of events) {
    const prevExit = lastExitBySymbol.get(ev.symbol) ?? -1
    if (ev.spikeIndex + 1 <= prevExit) continue
    const ema50 = emaLastOnNumberSeries(cumulativeAfterTrade, regimeEmaPeriod)
    const useShort = Number.isFinite(ema50) && cumulativePnlPct < ema50
    const tr = useShort
      ? simulateShortSpikeLowTrade(ev.candles, ev.spikeIndex, shortTradeOpts)
      : simulateLongTrade(ev.candles, ev.spikeIndex, tradeOpts)
    if (!tr) continue
    tr.regimeMode = useShort ? 'short_below_ema50' : 'long_above_or_no_ema50'
    tr.regimeEma50AtEntry = Number.isFinite(ema50) ? ema50 : null
    tr.regimeCumPnlPctBefore = cumulativePnlPct
    tr.regimeEmaPeriod = regimeEmaPeriod
    tr.regimeShortFixedTpR = 2
    const withSymbol = {
      symbol: ev.symbol,
      ...tr,
    }
    if (!perSymbolTrades.has(ev.symbol)) perSymbolTrades.set(ev.symbol, [])
    perSymbolTrades.get(ev.symbol).push(withSymbol)
    lastExitBySymbol.set(ev.symbol, tr.exitBarIndex)
    cumulativePnlPct += tradePriceReturnPct(withSymbol)
    cumulativeAfterTrade.push(cumulativePnlPct)
  }

  return perSymbolTrades
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
 * @param {string} futuresBase
 * @param {object} opts
 * @param {number} opts.minQuoteVolume24h
 * @param {string} opts.interval
 * @param {number} opts.candleCount
 * @param {number} opts.thresholdPct
 * @param {'long'|'shortSpikeLow'|'shortRedSpike'|'regimeFlipEma50'} [opts.strategy]
 * @param {number | null} [opts.maxSlPct] cap adverse SL distance as % of entry (omit or ≤0 = no cap)
 * @param {boolean} [opts.slAtSpikeOpen] place stop at spike open; R and TP targets unchanged
 * @param {boolean} [opts.includeChartCandles] attach OHLC for symbols with trades (for Lightweight Charts)
 * @param {boolean} [opts.emaLongFilter96_5m] long only: require entry open > EMA(96) on 5m at spike bar
 * @param {number} [opts.tpR] take-profit distance in R multiples vs 1R stop (default 2, clamped 0.1–100)
 * @param {string} [opts.fromDate] YYYY-MM-DD UTC (with toDate)
 * @param {string} [opts.toDate] YYYY-MM-DD UTC (with fromDate)
 */
export async function computeSpikeTpSlBacktest(futuresBase, opts) {
  const {
    minQuoteVolume24h,
    interval,
    candleCount,
    thresholdPct,
    strategy = 'long',
    fromDate: fromDateOpt,
    toDate: toDateOpt,
    maxSlPct: maxSlPctRaw,
    slAtSpikeOpen: slAtSpikeOpenRaw,
    includeChartCandles: includeChartCandlesRaw,
    emaLongFilter96_5m: emaLongFilterRaw,
  } = opts

  let maxSlPct = null
  if (maxSlPctRaw != null && maxSlPctRaw !== '') {
    const v = Number(maxSlPctRaw)
    if (Number.isFinite(v) && v > 0) maxSlPct = Math.min(v, 100)
  }
  const slAtSpikeOpen = Boolean(slAtSpikeOpenRaw)
  const includeChartCandles = Boolean(includeChartCandlesRaw)
  const emaLongFilter96_5m = Boolean(emaLongFilterRaw)
  const tpR = normalizeTpR({ tpR: opts?.tpR })
  const tradeOpts = { maxSlPct, slAtSpikeOpen, tpR }

  const maxChartCandles = Math.min(
    1500,
    Math.max(
      50,
      Number.parseInt(
        process.env.SPIKE_TPSL_CHART_MAX_CANDLES_PER_SYMBOL ?? String(CHART_CANDLES_PER_SYMBOL_DEFAULT),
        10,
      ) || CHART_CANDLES_PER_SYMBOL_DEFAULT,
    ),
  )
  const maxChartSyms = Math.min(
    200,
    Math.max(
      1,
      Number.parseInt(process.env.SPIKE_TPSL_CHART_MAX_SYMBOLS ?? String(CHART_SYMBOLS_MAX_DEFAULT), 10) ||
        CHART_SYMBOLS_MAX_DEFAULT,
    ),
  )
  const sNorm = String(strategy ?? 'long')
    .trim()
    .replace(/-/g, '_')
    .toLowerCase()
  let strat = 'long'
  if (sNorm === 'shortspikelow' || sNorm === 'short_spike_low') strat = 'shortSpikeLow'
  else if (
    sNorm === 'shortredspike' ||
    sNorm === 'short_red_spike' ||
    sNorm === 'negative_spike' ||
    sNorm === 'negativespike'
  ) {
    strat = 'shortRedSpike'
  } else if (
    sNorm === 'regimeflipema50' ||
    sNorm === 'regime_flip_ema50' ||
    sNorm === 'regime_flip' ||
    sNorm === 'regime'
  ) {
    strat = 'regimeFlipEma50'
  }

  const emaFilterActive = emaLongFilter96_5m && strat === 'long'

  const utcRange = parseSpikeTpSlUtcRange(fromDateOpt, toDateOpt)
  const n = Math.max(50, Math.min(1500, Math.floor(candleCount)))
  const maxSymRaw = Number.parseInt(process.env.SPIKE_TPSL_MAX_SYMBOLS ?? '300', 10)
  const maxSymbols = Number.isFinite(maxSymRaw) && maxSymRaw > 0 ? maxSymRaw : 300
  const concRaw = Number.parseInt(process.env.SPIKE_TPSL_CONCURRENCY ?? '4', 10)
  const CONCURRENCY =
    Number.isFinite(concRaw) && concRaw > 0 ? Math.min(16, concRaw) : 4

  const publicHeaders = binanceFuturesPublicHeaders()
  const binancePublicApiKeySent = Object.keys(publicHeaders).length > 0

  const volumeRows = await computeFutures24hVolumes(futuresBase, { headers: publicHeaders })
  const volFiltered = volumeRows.filter((r) => r.quoteVolume24h >= minQuoteVolume24h)
  const requestedSymbols = volFiltered.length
  const selected = volFiltered.slice(0, maxSymbols)

  const btcCandlesPromise = utcRange
    ? fetchKlinesOHLCInRange(
        futuresBase,
        'BTCUSDT',
        interval,
        utcRange.startTime,
        utcRange.endTime,
        publicHeaders,
      )
    : fetchKlinesOHLC(futuresBase, 'BTCUSDT', interval, n, publicHeaders)

  const raw = await mapPool(selected, CONCURRENCY, async (row) => {
    try {
      const candles = utcRange
        ? await fetchKlinesOHLCInRange(
            futuresBase,
            row.symbol,
            interval,
            utcRange.startTime,
            utcRange.endTime,
            publicHeaders,
          )
        : await fetchKlinesOHLC(futuresBase, row.symbol, interval, n, publicHeaders)
      if (candles.length < 3) {
        return {
          symbol: row.symbol,
          quoteVolume24h: row.quoteVolume24h,
          error: 'not enough candles',
          trades: [],
          emaSkipped: [],
        }
      }

      let candles5m = null
      let ema5mArr = null
      if (emaFilterActive) {
        if (interval === '5m') {
          const warmupN = ema5mWarmupBarCount(candles)
          const prefix = await fetch5mPrefixBeforeMain(
            futuresBase,
            row.symbol,
            candles[0].openTime,
            warmupN,
            publicHeaders,
          )
          candles5m = [...prefix, ...candles]
        } else {
          candles5m = await fetch5mOhlcAlignedToMain(
            futuresBase,
            row.symbol,
            candles,
            interval,
            utcRange,
            publicHeaders,
          )
        }
        ema5mArr = computeEmaArray(candles5m, EMA_LONG_FILTER_PERIOD)
      }

      const emaCtx =
        emaFilterActive && candles5m?.length && ema5mArr
          ? { symbol: row.symbol, candles5m, emaArr: ema5mArr }
          : null

      const useLegacyPerSymbolSim = strat !== 'regimeFlipEma50'
      const { trades, emaSkipped } = useLegacyPerSymbolSim
        ? runSymbolTrades(candles, thresholdPct, strat, tradeOpts, emaCtx)
        : { trades: [], emaSkipped: [] }

      const rowOut = {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        candleCount: candles.length,
        error: null,
        trades,
        emaSkipped,
        ...(strat === 'regimeFlipEma50' ? { candles } : {}),
      }

      const chartWorthy =
        includeChartCandles &&
        (strat === 'regimeFlipEma50' || trades.length > 0 || (emaSkipped?.length ?? 0) > 0)
      if (chartWorthy) {
        const slice =
          candles.length > maxChartCandles ? candles.slice(-maxChartCandles) : candles
        rowOut.chartCandles = slice.map((c) => ({
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
        if (emaFilterActive && emaCtx) {
          rowOut.chartEma = slice.map((c) => {
            const j = find5mIndexForMainOpenTime(emaCtx.candles5m, c.openTime)
            const ema = j >= 0 ? emaCtx.emaArr[j] : null
            return {
              openTime: c.openTime,
              ema: ema != null && Number.isFinite(ema) ? ema : null,
            }
          })
        }
      }
      return rowOut
    } catch (e) {
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        error: e instanceof Error ? e.message : 'failed',
        trades: [],
        emaSkipped: [],
      }
    }
  })

  const regimeTradesBySymbol =
    strat === 'regimeFlipEma50' ? runRegimeFlipTradesGlobal(raw, thresholdPct, tradeOpts) : null
  let skipped = 0
  const allTrades = []
  const allEmaSkipped = []
  const perSymbol = []
  const effectiveTradeCountBySymbol = new Map()
  for (const r of raw) {
    if (r.error) {
      skipped += 1
      continue
    }
    const rowTrades = regimeTradesBySymbol?.get(r.symbol) ?? r.trades
    if (Array.isArray(r.emaSkipped)) {
      for (const ev of r.emaSkipped) allEmaSkipped.push(ev)
    }
    const sumR = rowTrades.reduce((s, t) => s + t.rMultiple, 0)
    const tpN = rowTrades.filter((t) => t.outcome === 'tp').length
    const slN = rowTrades.filter((t) => t.outcome === 'sl').length
    const eodN = rowTrades.filter((t) => t.outcome === 'eod').length
    perSymbol.push({
      symbol: r.symbol,
      quoteVolume24h: r.quoteVolume24h,
      candleCount: r.candleCount,
      tradeCount: rowTrades.length,
      emaSkipCount: r.emaSkipped?.length ?? 0,
      tpCount: tpN,
      slCount: slN,
      eodCount: eodN,
      sumR,
    })
    effectiveTradeCountBySymbol.set(r.symbol, rowTrades.length)
    for (const t of rowTrades) {
      allTrades.push(t?.symbol ? t : { symbol: r.symbol, ...t })
    }
  }

  perSymbol.sort((a, b) => {
    if (b.sumR !== a.sumR) return b.sumR - a.sumR
    return b.tradeCount - a.tradeCount
  })

  let chartCandlesBySymbol = null
  let chartEmaBySymbol = null
  let chartSymbolsWithTradesTotal = 0
  let chartSymbolsReturned = 0
  if (includeChartCandles) {
    const candidates = raw.filter(
      (r) =>
        !r.error &&
        r.chartCandles?.length &&
        ((effectiveTradeCountBySymbol.get(r.symbol) ?? 0) > 0 || (r.emaSkipped?.length ?? 0) > 0),
    )
    chartSymbolsWithTradesTotal = candidates.length
    candidates.sort(
      (a, b) =>
        (effectiveTradeCountBySymbol.get(b.symbol) ?? 0) +
        (b.emaSkipped?.length ?? 0) -
        ((effectiveTradeCountBySymbol.get(a.symbol) ?? 0) + (a.emaSkipped?.length ?? 0)),
    )
    const acc = {}
    const emaAcc = {}
    for (const r of candidates.slice(0, maxChartSyms)) {
      acc[r.symbol] = r.chartCandles
      if (r.chartEma?.length) emaAcc[r.symbol] = r.chartEma
    }
    chartSymbolsReturned = Object.keys(acc).length
    chartCandlesBySymbol = chartSymbolsReturned > 0 ? acc : null
    chartEmaBySymbol = Object.keys(emaAcc).length > 0 ? emaAcc : null
  }

  const totalTrades = allTrades.length
  const tpHits = allTrades.filter((t) => t.outcome === 'tp').length
  const slHits = allTrades.filter((t) => t.outcome === 'sl').length
  const eodHits = allTrades.filter((t) => t.outcome === 'eod').length
  const sumR = allTrades.reduce((s, t) => s + t.rMultiple, 0)
  const decided = tpHits + slHits
  const winRateTpVsSl = decided > 0 ? (100 * tpHits) / decided : null

  let winningTrades = 0
  let losingTrades = 0
  let breakevenTrades = 0
  for (const t of allTrades) {
    const b = tradeWinLossBucket(t)
    if (b === 'win') winningTrades += 1
    else if (b === 'loss') losingTrades += 1
    else breakevenTrades += 1
  }

  const maxSymbolBarCount =
    perSymbol.length > 0 ? Math.max(...perSymbol.map((p) => p.candleCount ?? 0)) : 0

  const chron = [...allTrades].sort((a, b) => {
    if (a.entryOpenTime !== b.entryOpenTime) return a.entryOpenTime - b.entryOpenTime
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
  })
  let btcByOpenTime = new Map()
  try {
    const btcCandles = await btcCandlesPromise
    btcByOpenTime = candlesToBtcCloseMap(btcCandles)
  } catch (e) {
    console.error('BTCUSDT klines for equity overlay failed:', e)
  }
  const { points: equityCurveFull } = buildEquityCurveSummedPricePct(chron)
  attachBtcCloseToEquityPoints(equityCurveFull, btcByOpenTime)
  const lastPt = equityCurveFull[equityCurveFull.length - 1]
  const perTradePricePctChronFull = chron.map((t) => tradePriceReturnPct(t))

  const { points: equityCurve, downsampled: equityCurveDownsampled } = downsampleEquityCurvePoints(
    equityCurveFull,
    API_EQUITY_CURVE_MAX_POINTS,
  )
  const { values: perTradePricePctChron, subsampled: perTradePricePctSubsampled } =
    subsampleFloatSeries(perTradePricePctChronFull, API_PER_TRADE_PCT_MAX)
  const perTradeRChronFull = chron.map((t) => t.rMultiple)
  const { values: perTradeRChron } = subsampleArraySeries(perTradeRChronFull, API_PER_TRADE_PCT_MAX)
  const perTradeOutcomeChronFull = chron.map((t) => t.outcome)
  const { values: perTradeOutcomeChron } = subsampleArraySeries(
    perTradeOutcomeChronFull,
    API_PER_TRADE_PCT_MAX,
  )

  allTrades.sort((a, b) => b.entryOpenTime - a.entryOpenTime)

  const tpRStr = String(tpR)
  let meta =
    strat === 'regimeFlipEma50'
      ? {
          strategy: 'regimeFlipEma50',
          riskReward: `Regime flip: long ${tpRStr}R/1R above EMA50, short TP spike low with fixed SL +2R below EMA50`,
          entryRule:
            'Green spike trigger only. Regime uses cumulative Σ price % vs EMA(50) of that curve: above/no EMA => long; below => short. Short branch uses TP at spike low with fixed stop width 2R.',
          tpStatLabel: 'TP (mixed by regime)',
          slStatLabel: 'SL (mixed by regime)',
        }
      : strat === 'shortSpikeLow'
      ? {
          strategy: 'shortSpikeLow',
          riskReward: `TP at spike low / SL ${tpRStr}R (risk unit = ${tpRStr}R)`,
          entryRule: `Short next open after green spike; R = spike close − spike low; SL = entry + ${tpRStr}R; TP = spike low`,
          tpStatLabel: 'TP (spike low)',
          slStatLabel: `SL (-1R @ ${tpRStr}×R)`,
        }
      : strat === 'shortRedSpike'
        ? {
            strategy: 'shortRedSpike',
            riskReward: `${tpRStr}R TP / 1R SL (short, R above)`,
            entryRule: `Short next open after red-body spike; R = spike high − spike close; SL = entry + R; TP = entry − ${tpRStr}R`,
            tpStatLabel: `TP (${tpRStr}R)`,
            slStatLabel: 'SL (-1R)',
          }
        : {
            strategy: 'long',
            riskReward: `${tpRStr}R TP / 1R SL`,
            entryRule: `Long next open after green-body spike; R = spike close − spike low; SL = entry − R; TP = entry + ${tpRStr}R`,
            tpStatLabel: `TP (${tpRStr}R)`,
            slStatLabel: 'SL (-1R)',
          }

  if (slAtSpikeOpen) {
    const extra =
      strat === 'regimeFlipEma50'
        ? ' SL at spike open is applied to both branches when valid (long requires spike open below entry; short requires spike open above entry). Short branch still keeps TP at spike low.'
        : strat === 'shortSpikeLow'
        ? ' SL price = spike open (above entry); risk width = entry→SL; R for TP distance unchanged.'
        : strat === 'shortRedSpike'
          ? ` SL price = spike open (above entry); TP still entry − ${tpRStr}R from body R.`
          : ` SL price = spike open (below entry); TP still entry + ${tpRStr}R from body R.`
    meta = { ...meta, entryRule: `${meta.entryRule}.${extra}` }
  }
  if (maxSlPct != null) {
    meta = {
      ...meta,
      entryRule: `${meta.entryRule} Max adverse stop distance capped at ${maxSlPct}% of entry.`,
    }
  }
  if (emaFilterActive) {
    meta = {
      ...meta,
      entryRule: `${meta.entryRule} Long filter: next open must be above EMA(${EMA_LONG_FILTER_PERIOD}) on ${EMA_LONG_FILTER_INTERVAL} at spike bar (5m series aligned to main window).`,
    }
  }

  const chartTradeMarkers =
    includeChartCandles && allTrades.length > 0
      ? allTrades.map((t) => ({
          symbol: t.symbol,
          spikeOpenTime: t.spikeOpenTime,
          entryOpenTime: t.entryOpenTime,
        }))
      : undefined

  const chartSkippedMarkers =
    includeChartCandles && allEmaSkipped.length > 0 ? allEmaSkipped : undefined

  return {
    interval,
    tpR,
    maxSlPct,
    slAtSpikeOpen,
    emaLongFilter96_5m: emaLongFilter96_5m,
    emaLongFilterApplied: emaFilterActive,
    includeChartCandles,
    chartCandlesBySymbol,
    chartEmaBySymbol,
    chartSkippedMarkers,
    chartTradeMarkers,
    chartMaxCandlesPerSymbol: includeChartCandles ? maxChartCandles : null,
    chartMaxSymbols: includeChartCandles ? maxChartSyms : null,
    chartSymbolsReturned: includeChartCandles ? chartSymbolsReturned : null,
    chartSymbolsWithTradesTotal: includeChartCandles ? chartSymbolsWithTradesTotal : null,
    rangeMode: Boolean(utcRange),
    fromDate: utcRange?.fromDate ?? null,
    toDate: utcRange?.toDate ?? null,
    utcRangeStartMs: utcRange?.startTime ?? null,
    utcRangeEndMs: utcRange?.endTime ?? null,
    maxRangeDaysUtc: SPIKE_TPSL_MAX_RANGE_DAYS,
    candleCount: utcRange ? maxSymbolBarCount : n,
    candleCountTail: utcRange ? null : n,
    thresholdPct,
    minQuoteVolume24h,
    binancePublicApiKeySent,
    ...meta,
    equityCurveMode: 'summedPricePct',
    intrabarRule: 'Pessimistic: SL before TP if both touched same bar',
    requestedSymbols,
    symbolCount: perSymbol.length,
    symbolsCapped: requestedSymbols > maxSymbols,
    cappedAt: maxSymbols,
    skipped,
    summary: {
      totalTrades,
      tpHits,
      slHits,
      eodHits,
      emaFilterSkips: allEmaSkipped.length,
      winningTrades,
      losingTrades,
      breakevenTrades,
      sumR,
      avgR: totalTrades > 0 ? sumR / totalTrades : null,
      winRateTpVsSlPct: winRateTpVsSl,
      finalEquityPct: lastPt?.equityPct ?? 100,
      finalPnlPctFromStart: lastPt?.pnlPctFromStart ?? 0,
    },
    equityCurve,
    equityCurveDownsampled,
    perTradePricePctChron,
    perTradePricePctSubsampled,
    perTradeRChron,
    perTradeOutcomeChron,
    perSymbol,
    trades: allTrades.slice(0, 400),
    tradesTruncated: allTrades.length > 400,
    totalTradeRows: allTrades.length,
    fetchedAt: new Date().toISOString(),
  }
}
