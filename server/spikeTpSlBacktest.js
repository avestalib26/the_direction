/**
 * Universe backtest: volume-filtered USDT-M perps, green-body spikes.
 *
 * Long (default): next open long, R = spike close − spike low, SL = entry − R, TP = entry + 2R.
 * Long (longRedSpikeTpHigh): next open long after red-body spike; TP = spike high; SL = entry − 2×(TP−entry) → 0.5R reward vs 1R risk.
 * Short (shortRedSpike): next open short after red-body spike, R = spike high − spike close, SL = entry + R, TP = entry − 2R.
 * Short (shortSpikeLow): next open short, same R as long on green spike, SL = entry + 2R, TP = spike low (cover when low tags).
 * Short (shortGreenSpike2R): next open short on green spike, R = spike close − spike low, SL = entry + R, TP = entry − 2R.
 * Short (shortGreenRetestLow): wait for touch of spike low after green spike; short at touch price, SL = spike close, TP = 1R.
 * Long (longGreenRetestLow): wait for touch of spike low after green spike; long at touch price, SL = 1R below entry (R = spike close − spike low), TP = tpR×R or TP = spike high when longRetestTpAtSpikeHigh.
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

/**
 * Long EMA gate: optional level (entry open > EMA at spike 5m bar) and/or slope (EMA > prior 5m EMA).
 * @returns {null | { symbol, spikeOpenTime, entryOpenTime, reason }}
 */
function longEmaSkipIfAny(emaCtx, replayOpts, { symbol, spikeOpenTime, entryOpenTime, entryOpen }) {
  if (!emaCtx || !replayOpts) return null
  const level = replayOpts.emaLongLevel === true
  const slope = replayOpts.emaLongSlopePositive === true
  if (!level && !slope) return null
  const j = find5mIndexForMainOpenTime(emaCtx.candles5m, spikeOpenTime)
  const emaVal = j >= 0 && j < emaCtx.emaArr.length ? emaCtx.emaArr[j] : null
  const prevEma = j > 0 ? emaCtx.emaArr[j - 1] : null
  if (level) {
    if (emaVal == null || !Number.isFinite(emaVal) || !Number.isFinite(entryOpen) || !(entryOpen > emaVal)) {
      return { symbol, spikeOpenTime, entryOpenTime, reason: 'ema96_5m_long' }
    }
  }
  if (slope) {
    if (
      prevEma == null ||
      !Number.isFinite(prevEma) ||
      emaVal == null ||
      !Number.isFinite(emaVal) ||
      !(emaVal > prevEma)
    ) {
      return { symbol, spikeOpenTime, entryOpenTime, reason: 'ema96_5m_slope_long' }
    }
  }
  return null
}

/**
 * Short EMA level gate: entry open < EMA at spike 5m bar.
 * @returns {null | { symbol, spikeOpenTime, entryOpenTime, reason }}
 */
function shortEmaSkipIfAny(emaCtx, replayOpts, { symbol, spikeOpenTime, entryOpenTime, entryOpen }) {
  if (!emaCtx || !replayOpts || replayOpts.emaShortLevel !== true) return null
  const j = find5mIndexForMainOpenTime(emaCtx.candles5m, spikeOpenTime)
  const emaVal = j >= 0 && j < emaCtx.emaArr.length ? emaCtx.emaArr[j] : null
  if (emaVal == null || !Number.isFinite(emaVal) || !Number.isFinite(entryOpen) || !(entryOpen < emaVal)) {
    return { symbol, spikeOpenTime, entryOpenTime, reason: 'ema96_5m_short' }
  }
  return null
}

/** Map main-interval bars to 5m EMA(96) at each open; forward-fill after first seeded value (chart display only). */
function chartEmaAlignedToMainSlice(emaCtx, slice) {
  let lastGood = null
  return slice.map((c) => {
    const j = find5mIndexForMainOpenTime(emaCtx.candles5m, c.openTime)
    let ema = null
    if (j >= 0 && j < emaCtx.emaArr.length) {
      const v = emaCtx.emaArr[j]
      if (v != null && Number.isFinite(v)) {
        ema = v
        lastGood = v
      } else if (lastGood != null) {
        ema = lastGood
      }
    }
    return {
      openTime: c.openTime,
      ema: ema != null && Number.isFinite(ema) ? ema : null,
    }
  })
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

/**
 * Per-trade bar indexing. Default entry bar is spikeIndex+1 (next-open entries).
 * Retest strategies pass `entryBarIndex` explicitly (touch bar may be far after the spike).
 * barsInTrade = inclusive bars from entry through exit (1 = SL/TP on entry candle).
 */
function tradeBarMeta(spikeIndex, exitBarIndex, entryBarIndex = null) {
  const eb = entryBarIndex != null ? entryBarIndex : spikeIndex + 1
  return {
    spikeBarIndex: spikeIndex,
    entryBarIndex: eb,
    barsInTrade: exitBarIndex - eb + 1,
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
/**
 * Long at next open after red-body spike. TP = spike high. SL distance = 2×(TP−entry) below entry (0.5R vs 1R if R = stop width).
 * Skipped when next open is not below spike high. Pessimistic intrabar: SL before TP.
 */
function simulateLongRedSpikeTpHighTrade(candles, spikeIndex, tradeOpts = {}) {
  const maxSlPct = tradeOpts.maxSlPct
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  const tpPrice = sp.high
  if (!Number.isFinite(tpPrice) || !(tpPrice > entry)) return null

  const reward = tpPrice - entry
  let slPrice = entry - 2 * reward
  if (!Number.isFinite(slPrice) || !(slPrice < entry)) return null
  slPrice = capStopLong(entry, slPrice, maxSlPct)
  if (!Number.isFinite(slPrice) || !(slPrice < entry)) return null

  const R = entry - slPrice
  if (!(R > 0)) return null

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
      const rMult = (tpPrice - entry) / R
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
        rMultiple: rMult,
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
 * Short at next open after green-body spike. R = spike close − spike low. SL = entry + R, TP = entry − 2R (fixed).
 * Stop-at-spike-open may override SL when valid. Pessimistic intrabar: SL before TP.
 */
function simulateShortGreenSpike2RTrade(candles, spikeIndex, tradeOpts = {}) {
  const maxSlPct = tradeOpts.maxSlPct
  const slAtSpikeOpen = Boolean(tradeOpts.slAtSpikeOpen)
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.close - sp.low
  if (!(R > 0) || !Number.isFinite(R)) return null

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  let slPrice = slAtSpikeOpen ? sp.open : entry + R
  if (!Number.isFinite(slPrice) || !(slPrice > entry)) return null
  slPrice = capStopShort(entry, slPrice, maxSlPct)
  const riskWidth = slPrice - entry
  if (!(riskWidth > 0) || !Number.isFinite(slPrice) || !(slPrice > entry)) return null

  const tpPrice = entry - 2 * R

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

/**
 * Setup logic for short-on-retest:
 * - Detect green spike candle (body >= threshold).
 * - Wait for future bar to touch that spike low; short at spike low touch price.
 * - If a newer green spike appears before touch, replace pending setup with latest spike.
 * - Fixed exits: SL at spike high, TP at 1R below entry.
 * - To avoid same-candle hindsight bias, TP/SL checks start from the bar after the retest-entry bar.
 */
function runShortGreenRetestLowTrades(candles, thresholdPct, tradeOpts = {}, emaCtx = null, replayOpts = null) {
  const maxSlPct = tradeOpts.maxSlPct
  const trades = []
  const emaSkipped = []
  let pending = null

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue

    if (
      pending &&
      i > pending.spikeIndex &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.high) &&
      bar.low <= pending.spikeLow &&
      bar.high >= pending.spikeLow
    ) {
      const entry = pending.spikeLow
      const entryOpenTime = bar.openTime
      const entryOpen = bar.open
      if (emaCtx && replayOpts) {
        const skip = shortEmaSkipIfAny(emaCtx, replayOpts, {
          symbol: emaCtx.symbol,
          spikeOpenTime: pending.spikeOpenTime,
          entryOpenTime,
          entryOpen,
        })
        if (skip) {
          emaSkipped.push(skip)
          pending = null
          continue
        }
      }
      let slPrice = pending.spikeClose
      if (Number.isFinite(entry) && Number.isFinite(slPrice) && slPrice > entry) {
        slPrice = capStopShort(entry, slPrice, maxSlPct)
        const riskWidth = slPrice - entry
        if (Number.isFinite(riskWidth) && riskWidth > 0) {
          const tpPrice = entry - riskWidth
          let closed = false
          for (let j = i + 1; j < candles.length; j++) {
            const bj = candles[j]
            if (!Number.isFinite(bj?.low) || !Number.isFinite(bj?.high)) continue
            const o = shortBarOutcome(bj.low, bj.high, slPrice, tpPrice)
            if (o === 'sl') {
              trades.push({
                side: 'short',
                spikeOpenTime: pending.spikeOpenTime,
                entryOpenTime,
                entryPrice: entry,
                exitPrice: slPrice,
                entry,
                R: riskWidth,
                riskWidth,
                slPrice,
                tpPrice,
                outcome: 'sl',
                rMultiple: -1,
                exitOpenTime: bj.openTime,
                exitBarIndex: j,
                ...tradeBarMeta(pending.spikeIndex, j, i),
                ...spikeSnapshot(pending.spikeBar),
              })
              i = j
              closed = true
              break
            }
            if (o === 'tp') {
              trades.push({
                side: 'short',
                spikeOpenTime: pending.spikeOpenTime,
                entryOpenTime,
                entryPrice: entry,
                exitPrice: tpPrice,
                entry,
                R: riskWidth,
                riskWidth,
                slPrice,
                tpPrice,
                outcome: 'tp',
                rMultiple: 1,
                exitOpenTime: bj.openTime,
                exitBarIndex: j,
                ...tradeBarMeta(pending.spikeIndex, j, i),
                ...spikeSnapshot(pending.spikeBar),
              })
              i = j
              closed = true
              break
            }
          }
          if (!closed) {
            const last = candles[candles.length - 1]
            const close = last?.close
            const rMultiple = Number.isFinite(close) ? (entry - close) / riskWidth : 0
            const exitIdx = candles.length - 1
            trades.push({
              side: 'short',
              spikeOpenTime: pending.spikeOpenTime,
              entryOpenTime,
              entryPrice: entry,
              exitPrice: Number.isFinite(close) ? close : null,
              entry,
              R: riskWidth,
              riskWidth,
              slPrice,
              tpPrice,
              outcome: 'eod',
              rMultiple,
              exitOpenTime: last?.openTime,
              exitBarIndex: exitIdx,
              ...tradeBarMeta(pending.spikeIndex, exitIdx, i),
              ...spikeSnapshot(pending.spikeBar),
            })
            break
          }
          pending = null
          continue
        }
      }
      pending = null
    }

    if (i < candles.length - 1 && isGreenBodySpike(bar, thresholdPct)) {
      pending = {
        spikeIndex: i,
        spikeOpenTime: bar.openTime,
        spikeLow: bar.low,
        spikeClose: bar.close,
        spikeBar: bar,
      }
    }
  }

  return { trades, emaSkipped }
}

/**
 * Setup logic for long-on-retest:
 * - Detect green spike candle (body >= threshold).
 * - Wait for future bar to touch that spike low; long at spike low touch price.
 * - If a newer green spike appears before touch, replace pending setup with latest spike.
 * - Exits: SL is 1R below entry where R = spike close − spike low; TP = tpR×R above entry, or spike high if longRetestTpAtSpikeHigh.
 * - To avoid same-candle hindsight bias, TP/SL checks start from the bar after the retest-entry bar.
 */
function runLongGreenRetestLowTrades(candles, thresholdPct, tradeOpts = {}, emaCtx = null, replayOpts = null) {
  const maxSlPct = tradeOpts.maxSlPct
  const tpR = normalizeTpR(tradeOpts)
  const tpAtSpikeHigh = Boolean(tradeOpts.longRetestTpAtSpikeHigh)
  const trades = []
  const emaSkipped = []
  let pending = null

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue

    if (
      pending &&
      i > pending.spikeIndex &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.high) &&
      bar.low <= pending.spikeLow &&
      bar.high >= pending.spikeLow
    ) {
      const entry = pending.spikeLow
      const entryOpenTime = bar.openTime
      const entryOpen = bar.open
      if (emaCtx && replayOpts) {
        const skip = longEmaSkipIfAny(emaCtx, replayOpts, {
          symbol: emaCtx.symbol,
          spikeOpenTime: pending.spikeOpenTime,
          entryOpenTime,
          entryOpen,
        })
        if (skip) {
          emaSkipped.push(skip)
          pending = null
          continue
        }
      }
      let slPrice = entry - pending.baseR
      if (Number.isFinite(entry) && Number.isFinite(slPrice) && slPrice < entry) {
        slPrice = capStopLong(entry, slPrice, maxSlPct)
        const riskWidth = entry - slPrice
        if (Number.isFinite(riskWidth) && riskWidth > 0) {
          let tpPrice
          if (tpAtSpikeHigh) {
            const sh = pending.spikeBar?.high
            if (!Number.isFinite(sh) || !(sh > entry)) {
              pending = null
              continue
            }
            tpPrice = sh
          } else {
            tpPrice = entry + tpR * riskWidth
          }
          let closed = false
          for (let j = i + 1; j < candles.length; j++) {
            const bj = candles[j]
            if (!Number.isFinite(bj?.low) || !Number.isFinite(bj?.high)) continue
            const o = longBarOutcome(bj.low, bj.high, slPrice, tpPrice)
            if (o === 'sl') {
              trades.push({
                side: 'long',
                spikeOpenTime: pending.spikeOpenTime,
                entryOpenTime,
                entryPrice: entry,
                exitPrice: slPrice,
                entry,
                R: riskWidth,
                slPrice,
                tpPrice,
                outcome: 'sl',
                rMultiple: -1,
                exitOpenTime: bj.openTime,
                exitBarIndex: j,
                ...tradeBarMeta(pending.spikeIndex, j, i),
                ...spikeSnapshot(pending.spikeBar),
              })
              i = j
              closed = true
              break
            }
            if (o === 'tp') {
              const rMultTp = tpAtSpikeHigh ? (tpPrice - entry) / riskWidth : tpR
              trades.push({
                side: 'long',
                spikeOpenTime: pending.spikeOpenTime,
                entryOpenTime,
                entryPrice: entry,
                exitPrice: tpPrice,
                entry,
                R: riskWidth,
                slPrice,
                tpPrice,
                outcome: 'tp',
                rMultiple: rMultTp,
                exitOpenTime: bj.openTime,
                exitBarIndex: j,
                ...tradeBarMeta(pending.spikeIndex, j, i),
                ...spikeSnapshot(pending.spikeBar),
              })
              i = j
              closed = true
              break
            }
          }
          if (!closed) {
            const last = candles[candles.length - 1]
            const close = last?.close
            const rMultiple = Number.isFinite(close) ? (close - entry) / riskWidth : 0
            const exitIdx = candles.length - 1
            trades.push({
              side: 'long',
              spikeOpenTime: pending.spikeOpenTime,
              entryOpenTime,
              entryPrice: entry,
              exitPrice: Number.isFinite(close) ? close : null,
              entry,
              R: riskWidth,
              slPrice,
              tpPrice,
              outcome: 'eod',
              rMultiple,
              exitOpenTime: last?.openTime,
              exitBarIndex: exitIdx,
              ...tradeBarMeta(pending.spikeIndex, exitIdx, i),
              ...spikeSnapshot(pending.spikeBar),
            })
            break
          }
          pending = null
          continue
        }
      }
      pending = null
    }

    if (i < candles.length - 1 && isGreenBodySpike(bar, thresholdPct)) {
      const baseR = bar.close - bar.low
      if (!(Number.isFinite(baseR) && baseR > 0)) continue
      pending = {
        spikeIndex: i,
        spikeOpenTime: bar.openTime,
        spikeLow: bar.low,
        spikeBar: bar,
        baseR,
      }
    }
  }

  return { trades, emaSkipped }
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
    if (strategy === 'shortRedSpike' || strategy === 'longRedSpikeTpHigh') {
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

function summarizeBySide(allTrades, side) {
  const sideTrades = allTrades.filter((t) => t?.side === side)
  const totalTrades = sideTrades.length
  const tpHits = sideTrades.filter((t) => t.outcome === 'tp').length
  const slHits = sideTrades.filter((t) => t.outcome === 'sl').length
  const eodHits = sideTrades.filter((t) => t.outcome === 'eod').length
  const decided = tpHits + slHits
  const sumR = sideTrades.reduce((s, t) => s + t.rMultiple, 0)

  let winningTrades = 0
  let losingTrades = 0
  let breakevenTrades = 0
  for (const t of sideTrades) {
    const b = tradeWinLossBucket(t)
    if (b === 'win') winningTrades += 1
    else if (b === 'loss') losingTrades += 1
    else breakevenTrades += 1
  }

  return {
    totalTrades,
    tpHits,
    slHits,
    eodHits,
    winningTrades,
    losingTrades,
    breakevenTrades,
    sumR,
    avgR: totalTrades > 0 ? sumR / totalTrades : null,
    winRateTpVsSlPct: decided > 0 ? (100 * tpHits) / decided : null,
  }
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

/** Max peak-to-trough drop in cumulative Σ price % (full trade sequence). */
function maxDrawdownSummedPnlPct(equityPoints) {
  if (!Array.isArray(equityPoints) || equityPoints.length < 2) return null
  let peak = -Infinity
  let maxDd = 0
  for (const p of equityPoints) {
    const v = Number(p.pnlPctFromStart)
    if (!Number.isFinite(v)) continue
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDd) maxDd = dd
  }
  return Number.isFinite(maxDd) ? maxDd : null
}

/**
 * @param {object | null} emaCtx — when set and strategy is long: require entry open > EMA(96) on 5m at spike bar.
 * @param {string} emaCtx.symbol
 * @param {ReturnType<typeof mapKlineRow>[]} emaCtx.candles5m
 * @param {(number | null)[]} emaCtx.emaArr
 * @param {object} replayOpts
 * @param {boolean} replayOpts.allowOverlap — when true in long mode, allow same-symbol overlapping trades.
 * @param {boolean} [replayOpts.emaLongLevel] long: require entry open > EMA at spike 5m bar
 * @param {boolean} [replayOpts.emaLongSlopePositive] long: require EMA at spike 5m bar > prior 5m EMA
 * @param {boolean} [replayOpts.emaShortLevel] short: require entry open < EMA at spike 5m bar
 */
function runSymbolTrades(candles, thresholdPct, strategy = 'long', tradeOpts = {}, emaCtx = null, replayOpts = {}) {
  if (strategy === 'shortGreenRetestLow') {
    return runShortGreenRetestLowTrades(candles, thresholdPct, tradeOpts, emaCtx, replayOpts)
  }
  if (strategy === 'longGreenRetestLow') {
    return runLongGreenRetestLowTrades(candles, thresholdPct, tradeOpts, emaCtx, replayOpts)
  }
  let sim = simulateLongTrade
  if (strategy === 'shortSpikeLow') sim = simulateShortSpikeLowTrade
  else if (strategy === 'shortRedSpike') sim = simulateShortRedSpikeTrade
  else if (strategy === 'shortGreenSpike2R') sim = simulateShortGreenSpike2RTrade
  else if (strategy === 'longRedSpikeTpHigh') sim = simulateLongRedSpikeTpHighTrade
  const spikes = spikeIndices(candles, thresholdPct, strategy)
  const allowOverlap =
    (strategy === 'long' || strategy === 'longRedSpikeTpHigh') && replayOpts?.allowOverlap === true
  let lastExitBar = -1
  const trades = []
  const emaSkipped = []

  for (const si of spikes) {
    // Entry is at open of bar si+1; allow spike si when that entry bar is after the prior exit bar.
    if (!allowOverlap && si + 1 <= lastExitBar) continue

    if (emaCtx) {
      const entryOpen = candles[si + 1].open
      const spikeOpenTime = candles[si].openTime
      const entryOpenTime = candles[si + 1].openTime
      const isLongStratBlock = strategy === 'long' || strategy === 'longRedSpikeTpHigh'
      if (isLongStratBlock) {
        const skip = longEmaSkipIfAny(emaCtx, replayOpts, {
          symbol: emaCtx.symbol,
          spikeOpenTime,
          entryOpenTime,
          entryOpen,
        })
        if (skip) {
          emaSkipped.push(skip)
          continue
        }
      } else if (replayOpts?.emaShortLevel) {
        const skip = shortEmaSkipIfAny(emaCtx, replayOpts, {
          symbol: emaCtx.symbol,
          spikeOpenTime,
          entryOpenTime,
          entryOpen,
        })
        if (skip) {
          emaSkipped.push(skip)
          continue
        }
      }
    }

    const tr = sim(candles, si, tradeOpts)
    if (!tr) continue
    trades.push(tr)
    if (!allowOverlap) lastExitBar = tr.exitBarIndex
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
 * @param {'long'|'longRedSpikeTpHigh'|'longGreenRetestLow'|'shortSpikeLow'|'shortRedSpike'|'shortGreenSpike2R'|'shortGreenRetestLow'|'regimeFlipEma50'} [opts.strategy]
 * @param {number | null} [opts.maxSlPct] cap adverse SL distance as % of entry (omit or ≤0 = no cap)
 * @param {boolean} [opts.slAtSpikeOpen] place stop at spike open; R and TP targets unchanged
 * @param {boolean} [opts.includeChartCandles] attach OHLC for symbols with trades (for Lightweight Charts)
 * @param {boolean} [opts.emaLongFilter96_5m] long only: require entry open > EMA(96) on 5m at spike bar
 * @param {boolean} [opts.emaLongSlopePositive96_5m] long (incl. retest): require EMA(96) on 5m rising at spike bar (vs prior 5m EMA)
 * @param {boolean} [opts.emaShortFilter96_5m] short only: require entry open < EMA(96) on 5m at spike bar
 * @param {boolean} [opts.allowOverlap] long only: allow same-symbol overlapping trades
 * @param {number} [opts.tpR] take-profit distance in R multiples vs 1R stop (default 2, clamped 0.1–100)
 * @param {boolean} [opts.longRetestTpAtSpikeHigh] longGreenRetestLow only: TP = spike candle high; tpR ignored
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
    emaLongSlopePositive96_5m: emaLongSlopeRaw,
    emaShortFilter96_5m: emaShortFilterRaw,
    allowOverlap: allowOverlapRaw,
    longRetestTpAtSpikeHigh: longRetestTpAtSpikeHighRaw,
  } = opts

  let maxSlPct = null
  if (maxSlPctRaw != null && maxSlPctRaw !== '') {
    const v = Number(maxSlPctRaw)
    if (Number.isFinite(v) && v > 0) maxSlPct = Math.min(v, 100)
  }
  const slAtSpikeOpen = Boolean(slAtSpikeOpenRaw)
  const includeChartCandles = Boolean(includeChartCandlesRaw)
  const emaLongFilter96_5m = Boolean(emaLongFilterRaw)
  const emaLongSlopePositive96_5m = Boolean(emaLongSlopeRaw)
  const emaShortFilter96_5m = Boolean(emaShortFilterRaw)
  const allowOverlap = Boolean(allowOverlapRaw)
  const tpR = normalizeTpR({ tpR: opts?.tpR })
  const longRetestTpAtSpikeHigh = Boolean(longRetestTpAtSpikeHighRaw)
  const tradeOpts = { maxSlPct, slAtSpikeOpen, tpR, longRetestTpAtSpikeHigh }

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
  else if (sNorm === 'short') strat = 'shortRedSpike'
  else if (
    sNorm === 'shortgreenspike2r' ||
    sNorm === 'short_green_spike_2r' ||
    sNorm === 'short_green_spike' ||
    sNorm === 'short_long_spike'
  ) {
    strat = 'shortGreenSpike2R'
  } else if (
    sNorm === 'shortgreenretestlow' ||
    sNorm === 'short_green_retest_low' ||
    sNorm === 'shortretestspikelow' ||
    sNorm === 'short_spike_retest_low'
  ) {
    strat = 'shortGreenRetestLow'
  } else if (
    sNorm === 'longgreenretestlow' ||
    sNorm === 'long_green_retest_low' ||
    sNorm === 'longretestspikelow' ||
    sNorm === 'long_spike_retest_low'
  ) {
    strat = 'longGreenRetestLow'
  }
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
  } else if (
    sNorm === 'longredspiketphigh' ||
    sNorm === 'long_red_spike_tp_high' ||
    sNorm === 'longredspikehigh' ||
    sNorm === 'redspike_long_tp_high'
  ) {
    strat = 'longRedSpikeTpHigh'
  }

  const isLongStrat = strat === 'long' || strat === 'longRedSpikeTpHigh'
  const isLongForEmaSlope =
    strat === 'long' || strat === 'longRedSpikeTpHigh' || strat === 'longGreenRetestLow'
  const isShortStrat =
    strat === 'shortSpikeLow' ||
    strat === 'shortRedSpike' ||
    strat === 'shortGreenSpike2R' ||
    strat === 'shortGreenRetestLow'
  const emaLongFilterActive = emaLongFilter96_5m && isLongStrat
  const emaLongSlopeActive = emaLongSlopePositive96_5m && isLongForEmaSlope
  const emaShortFilterActive = emaShortFilter96_5m && isShortStrat
  const emaFilterActive = emaLongFilterActive || emaShortFilterActive || emaLongSlopeActive

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
      const emaReplayOpts = {
        emaLongLevel: emaLongFilterActive,
        emaLongSlopePositive: emaLongSlopeActive,
        emaShortLevel: emaShortFilterActive,
      }
      const { trades, emaSkipped } = useLegacyPerSymbolSim
        ? runSymbolTrades(candles, thresholdPct, strat, tradeOpts, emaCtx, {
            allowOverlap: allowOverlap && (strat === 'long' || strat === 'longRedSpikeTpHigh'),
            ...emaReplayOpts,
          })
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
          rowOut.chartEma = chartEmaAlignedToMainSlice(emaCtx, slice)
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
  const longSummary = summarizeBySide(allTrades, 'long')
  const shortSummary = summarizeBySide(allTrades, 'short')

  const maxSymbolBarCount =
    perSymbol.length > 0 ? Math.max(...perSymbol.map((p) => p.candleCount ?? 0)) : 0

  const chron = [...allTrades].sort((a, b) => {
    if (a.entryOpenTime !== b.entryOpenTime) return a.entryOpenTime - b.entryOpenTime
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
  })
  let btcByOpenTime = new Map()
  let btcCandlesRaw = null
  try {
    btcCandlesRaw = await btcCandlesPromise
    btcByOpenTime = candlesToBtcCloseMap(btcCandlesRaw)
  } catch (e) {
    console.error('BTCUSDT klines for equity overlay failed:', e)
  }
  const { points: equityCurveFull } = buildEquityCurveSummedPricePct(chron)
  attachBtcCloseToEquityPoints(equityCurveFull, btcByOpenTime)
  const lastPt = equityCurveFull[equityCurveFull.length - 1]
  const maxDrawdownPnlPct = maxDrawdownSummedPnlPct(equityCurveFull)
  const avgPnlPctPerTrade =
    totalTrades > 0 && Number.isFinite(Number(lastPt?.pnlPctFromStart))
      ? Number(lastPt.pnlPctFromStart) / totalTrades
      : null
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
        : strat === 'shortGreenSpike2R'
          ? {
              strategy: 'shortGreenSpike2R',
              riskReward: '2R TP / 1R SL (short on green spike, fixed)',
              entryRule:
                'Short next open after green-body spike; R = spike close − spike low; SL = entry + R; TP = entry − 2R (fixed).',
              tpStatLabel: 'TP (2R fixed)',
              slStatLabel: 'SL (-1R)',
            }
        : strat === 'shortGreenRetestLow'
          ? {
              strategy: 'shortGreenRetestLow',
              riskReward: 'Retest entry, 1R TP / 1R SL (short on green spike low touch)',
              entryRule:
                'After a green-body spike, wait until price touches that spike low; short at that touch price. If a newer green spike appears before touch, older setup is dropped. SL = spike close. TP = 1R below entry.',
              tpStatLabel: 'TP (1R)',
              slStatLabel: 'SL (-1R @ spike close)',
            }
        : strat === 'longGreenRetestLow'
          ? longRetestTpAtSpikeHigh
            ? {
                strategy: 'longGreenRetestLow',
                riskReward: 'TP at spike high / 1R SL (long on green spike low retest)',
                entryRule:
                  'After a green-body spike, wait until price touches that spike low; long at that touch price. If a newer green spike appears before touch, older setup is dropped. Exits are judged from the next bar only. R = spike close − spike low; SL = entry − 1R; TP = spike candle high. tpR setting does not apply.',
                tpStatLabel: 'TP (spike high)',
                slStatLabel: 'SL (-1R)',
              }
            : {
                strategy: 'longGreenRetestLow',
                riskReward: `${tpRStr}R TP / 1R SL (long on green spike low retest)`,
                entryRule:
                  `After a green-body spike, wait until price touches that spike low; long at that touch price. If a newer green spike appears before touch, older setup is dropped. Exits are judged from the next bar only. R = spike close − spike low; SL = entry − 1R; TP = entry + ${tpRStr}R.`,
                tpStatLabel: `TP (${tpRStr}R)`,
                slStatLabel: 'SL (-1R)',
              }
        : strat === 'longRedSpikeTpHigh'
          ? {
              strategy: 'longRedSpikeTpHigh',
              riskReward:
                'TP at spike high / SL = 2×(TP−entry) below entry (+0.5R vs −1R when uncapped)',
              entryRule:
                'Long next open after red-body spike (same body threshold as other modes). TP = spike candle high. SL = entry − 2×(TP−entry). Skipped if next open ≥ spike high. tpR setting does not apply.',
              tpStatLabel: 'TP (spike high)',
              slStatLabel: 'SL (-1R; 1R = entry - SL)',
        }
      : {
          strategy: 'long',
              riskReward: `${tpRStr}R TP / 1R SL`,
              entryRule: `Long next open after green-body spike; R = spike close − spike low; SL = entry − R; TP = entry + ${tpRStr}R`,
              tpStatLabel: `TP (${tpRStr}R)`,
          slStatLabel: 'SL (-1R)',
        }

  if (slAtSpikeOpen && strat !== 'longRedSpikeTpHigh') {
    const extra =
      strat === 'regimeFlipEma50'
        ? ' SL at spike open is applied to both branches when valid (long requires spike open below entry; short requires spike open above entry). Short branch still keeps TP at spike low.'
        : strat === 'shortSpikeLow'
        ? ' SL price = spike open (above entry); risk width = entry→SL; R for TP distance unchanged.'
        : strat === 'shortRedSpike'
          ? ` SL price = spike open (above entry); TP still entry − ${tpRStr}R from body R.`
          : strat === 'shortGreenSpike2R'
            ? ' SL price = spike open (above entry); TP remains entry − 2R from body R.'
            : strat === 'shortGreenRetestLow'
              ? ' Stop-at-spike-open is ignored in this mode (SL is fixed at spike close).'
            : strat === 'longGreenRetestLow'
              ? ' Stop-at-spike-open is ignored in this mode (entry waits for spike-low retest; SL stays entry − 1R).'
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
    const parts = []
    if (emaLongFilterActive) {
      parts.push(
        `Long level filter: entry open must be above EMA(${EMA_LONG_FILTER_PERIOD}) on ${EMA_LONG_FILTER_INTERVAL} at the spike bar (5m series aligned to main window).`,
      )
    }
    if (emaLongSlopeActive) {
      parts.push(
        `Long slope filter: EMA(${EMA_LONG_FILTER_PERIOD}) on ${EMA_LONG_FILTER_INTERVAL} must be rising at the spike bar (current 5m EMA > previous 5m EMA).`,
      )
    }
    if (emaShortFilterActive) {
      parts.push(
        `Short filter: entry open must be below EMA(${EMA_LONG_FILTER_PERIOD}) on ${EMA_LONG_FILTER_INTERVAL} at the spike bar (5m series aligned to main window).`,
      )
    }
    meta = {
      ...meta,
      entryRule: `${meta.entryRule} ${parts.join(' ')}`,
    }
  }
  if (allowOverlap && (strat === 'long' || strat === 'longRedSpikeTpHigh')) {
    meta = {
      ...meta,
      entryRule: `${meta.entryRule} Overlap mode: do not block a new long on the same symbol while a prior one is still open.`,
    }
  }

  const chartTradeMarkers =
    includeChartCandles && allTrades.length > 0
      ? allTrades.map((t) => ({
          symbol: t.symbol,
          spikeOpenTime: t.spikeOpenTime,
          entryOpenTime: t.entryOpenTime,
          exitOpenTime: t.exitOpenTime,
          occurrenceOpenTime: t.flipOccurrence ? t.occurrenceOpenTime ?? t.entryOpenTime : null,
        }))
      : undefined

  const chartSkippedMarkers =
    includeChartCandles && allEmaSkipped.length > 0 ? allEmaSkipped : undefined

  const btcChartCandles =
    includeChartCandles && Array.isArray(btcCandlesRaw) && btcCandlesRaw.length > 0
      ? (btcCandlesRaw.length > maxChartCandles
          ? btcCandlesRaw.slice(-maxChartCandles)
          : btcCandlesRaw
        ).map((c) => ({
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
      : null

  return {
    interval,
    tpR,
    longRetestTpAtSpikeHigh: strat === 'longGreenRetestLow' ? longRetestTpAtSpikeHigh : false,
    maxSlPct,
    slAtSpikeOpen,
    allowOverlap: allowOverlap && (strat === 'long' || strat === 'longRedSpikeTpHigh'),
    emaLongFilter96_5m: emaLongFilter96_5m,
    emaLongSlopePositive96_5m: emaLongSlopePositive96_5m,
    emaShortFilter96_5m: emaShortFilter96_5m,
    emaLongFilterApplied: emaLongFilterActive,
    emaLongSlopeApplied: emaLongSlopeActive,
    emaShortFilterApplied: emaShortFilterActive,
    emaFilterApplied: emaFilterActive,
    includeChartCandles,
    chartCandlesBySymbol,
    chartEmaBySymbol,
    chartSkippedMarkers,
    chartTradeMarkers,
    chartMaxCandlesPerSymbol: includeChartCandles ? maxChartCandles : null,
    chartMaxSymbols: includeChartCandles ? maxChartSyms : null,
    chartSymbolsReturned: includeChartCandles ? chartSymbolsReturned : null,
    chartSymbolsWithTradesTotal: includeChartCandles ? chartSymbolsWithTradesTotal : null,
    btcChartCandles,
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
      bySide: {
        long: longSummary,
        short: shortSummary,
      },
      finalEquityPct: lastPt?.equityPct ?? 100,
      finalPnlPctFromStart: lastPt?.pnlPctFromStart ?? 0,
      avgPnlPctPerTrade,
      maxDrawdownPnlPct,
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
