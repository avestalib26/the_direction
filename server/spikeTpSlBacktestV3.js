/**
 * V3: no volume filter — all USDT-M perps (capped). Multi-day UTC range (≤31 inclusive days).
 * Fetches klines with pagination + throttling; aggregates Σ price % and trade stats per calendar day.
 * Includes BTCUSDT daily OHLC for comparison charts.
 *
 * Long (default): next open long, R = spike close − spike low, SL = entry − R, TP = entry + 2R.
 * Short (shortRedSpike): next open short after red-body spike, R = spike high − spike close, SL = entry + R, TP = entry − 2R.
 * Short (shortSpikeLow): next open short, same R as long on green spike, SL = entry + 2R, TP = spike low (cover when low tags).
 *
 * Risk unit for R-multiples: long uses R; short uses 2R (stop width). Pessimistic intrabar: SL before TP.
 * Unclosed trades exit at last close (EOD).
 */

import { fetchUsdmPerpetualSymbols } from './breadth.js'
import { binanceFuturesPublicHeaders } from './binancePublicHeaders.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

/** Max inclusive UTC calendar-day span (fromDate → toDate). */
export const SPIKE_TPSL_V3_MAX_RANGE_DAYS = 31

const KLINES_PAGE_LIMIT = 1500
/** Enough pages for ~31d @1m (~45k bars). */
const RANGE_FETCH_MAX_PAGES = 80

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

function formatUtcYmd(dayStartMs) {
  const x = new Date(dayStartMs)
  const y = x.getUTCFullYear()
  const mo = String(x.getUTCMonth() + 1).padStart(2, '0')
  const d = String(x.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

/**
 * @returns {{ startTime: number, endTime: number, fromDate: string, toDate: string }}
 */
export function parseSpikeTpSlV3UtcRange(fromDate, toDate) {
  const f = String(fromDate ?? '').trim()
  const t = String(toDate ?? '').trim()
  if (!f || !t) {
    throw new Error('fromDate and toDate are required (YYYY-MM-DD, UTC)')
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
  if (spanDays > SPIKE_TPSL_V3_MAX_RANGE_DAYS) {
    throw new Error(`Range cannot exceed ${SPIKE_TPSL_V3_MAX_RANGE_DAYS} UTC days (inclusive)`)
  }
  return { startTime: fromMs, endTime: toMsEnd, fromDate: f, toDate: t }
}

/** BTCUSDT 1d OHLC in [startTime, endTime] (openTime ms). */
async function fetchBtcDailyOhlcInRange(futuresBase, startTime, endTime, headers = {}) {
  const symbol = 'BTCUSDT'
  const interval = '1d'
  const byTime = new Map()
  let cursor = startTime
  const pageDelayMs = Number.parseInt(
    process.env.SPIKE_TPSL_V3_PAGE_DELAY_MS ??
      process.env.SPIKE_TPSL_V2_PAGE_DELAY_MS ??
      process.env.SPIKE_TPSL_PAGE_DELAY_MS ??
      '0',
    10,
  )
  for (let page = 0; page < 10; page++) {
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
      throw new Error(`Binance BTC klines: invalid JSON (${r.status})`)
    }
    if (!r.ok) {
      const msg = data.msg || data.message || text
      throw new Error(`Binance ${r.status}: ${msg}`)
    }
    if (!Array.isArray(data) || data.length === 0) break
    for (const k of data) {
      const ot = k[0]
      if (ot < startTime || ot > endTime) continue
      byTime.set(ot, {
        time: formatUtcYmd(ot),
        openTime: ot,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
      })
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

function mapKlineRow(k) {
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }
}

/**
 * All candles with openTime in [startTime, endTime], paginated (max KLINES_PAGE_LIMIT per request).
 */
async function fetchKlinesOHLCInRange(futuresBase, symbol, interval, startTime, endTime, headers = {}) {
  const byTime = new Map()
  let cursor = startTime
  const pageDelayMs = Number.parseInt(
    process.env.SPIKE_TPSL_V3_PAGE_DELAY_MS ??
      process.env.SPIKE_TPSL_V2_PAGE_DELAY_MS ??
      process.env.SPIKE_TPSL_PAGE_DELAY_MS ??
      '0',
    10,
  )

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

/** Short: SL above entry, TP below (spike low). If both touched same bar, SL first (conservative). */
function shortBarOutcome(low, high, slPrice, tpPrice) {
  const hitSl = high >= slPrice
  const hitTp = low <= tpPrice
  if (hitSl && hitTp) return 'sl'
  if (hitSl) return 'sl'
  if (hitTp) return 'tp'
  return null
}

function simulateLongTrade(candles, spikeIndex) {
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.close - sp.low
  if (!(R > 0) || !Number.isFinite(R)) return null

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  const slPrice = entry - R
  const tpPrice = entry + 2 * R

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
        rMultiple: 2,
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
function simulateShortRedSpikeTrade(candles, spikeIndex) {
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.high - sp.close
  if (!(R > 0) || !Number.isFinite(R)) return null

  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  const slPrice = entry + R
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
        rMultiple: 2,
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
 * Short at next open after green spike. R = spike close − spike low. Stop entry + 2R. TP = spike low.
 * Risk unit = 2R (full stop width): SL → −1R, TP → +(entry − spike low) / (2R). Skips if entry ≤ spike low.
 */
function simulateShortSpikeLowTrade(candles, spikeIndex) {
  const i = spikeIndex
  if (i + 1 >= candles.length) return null
  const sp = candles[i]
  const R = sp.close - sp.low
  if (!(R > 0) || !Number.isFinite(R)) return null

  const riskWidth = 2 * R
  const entry = candles[i + 1].open
  if (!Number.isFinite(entry)) return null

  const tpPrice = sp.low
  if (!(entry > tpPrice)) return null

  const slPrice = entry + riskWidth

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

function runSymbolTrades(candles, thresholdPct, strategy = 'long') {
  let sim = simulateLongTrade
  if (strategy === 'shortSpikeLow') sim = simulateShortSpikeLowTrade
  else if (strategy === 'shortRedSpike') sim = simulateShortRedSpikeTrade
  const spikes = spikeIndices(candles, thresholdPct, strategy)
  let lastExitBar = -1
  const trades = []
  for (const si of spikes) {
    // Entry is at open of bar si+1; allow spike si when that entry bar is after the prior exit bar.
    if (si + 1 <= lastExitBar) continue
    const tr = sim(candles, si)
    if (!tr) continue
    trades.push(tr)
    lastExitBar = tr.exitBarIndex
  }
  return trades
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

function summarizeAllTrades(allTrades) {
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
  let sumPricePct = 0
  for (const t of allTrades) {
    sumPricePct += tradePriceReturnPct(t)
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
    winRateTpVsSlPct: winRateTpVsSl,
    sumPricePct,
    finalPnlPctFromStart: sumPricePct,
    finalEquityPct: 100 + sumPricePct,
  }
}

/**
 * @param {string} futuresBase
 * @param {object} opts
 * @param {string} opts.interval
 * @param {number} opts.thresholdPct
 * @param {'long'|'shortSpikeLow'|'shortRedSpike'} [opts.strategy]
 * @param {string} opts.fromDate YYYY-MM-DD UTC
 * @param {string} opts.toDate YYYY-MM-DD UTC
 */
export async function computeSpikeTpSlBacktestV3(futuresBase, opts) {
  const { interval, thresholdPct, strategy = 'long', fromDate: fromDateOpt, toDate: toDateOpt } = opts
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
  }

  const range = parseSpikeTpSlV3UtcRange(fromDateOpt, toDateOpt)

  const maxSymRaw = Number.parseInt(
    process.env.SPIKE_TPSL_V3_MAX_SYMBOLS ?? process.env.SPIKE_TPSL_MAX_SYMBOLS ?? '80',
    10,
  )
  const maxSymbols = Number.isFinite(maxSymRaw) && maxSymRaw > 0 ? maxSymRaw : 80
  const concRaw = Number.parseInt(
    process.env.SPIKE_TPSL_V3_CONCURRENCY ?? process.env.SPIKE_TPSL_CONCURRENCY ?? '2',
    10,
  )
  const CONCURRENCY = Number.isFinite(concRaw) && concRaw > 0 ? Math.min(8, concRaw) : 2

  const publicHeaders = binanceFuturesPublicHeaders()
  const binancePublicApiKeySent = Object.keys(publicHeaders).length > 0

  const allSyms = await fetchUsdmPerpetualSymbols(futuresBase, { headers: publicHeaders })
  const requestedSymbols = allSyms.length
  const selected = allSyms.slice(0, maxSymbols)

  const raw = await mapPool(selected, CONCURRENCY, async (symbol) => {
    try {
      const candles = await fetchKlinesOHLCInRange(
        futuresBase,
        symbol,
        interval,
        range.startTime,
        range.endTime,
        publicHeaders,
      )
      if (candles.length < 3) {
        return { symbol, candleCount: candles.length, error: 'not enough candles', trades: [] }
      }
      const trades = runSymbolTrades(candles, thresholdPct, strat)
      return { symbol, candleCount: candles.length, error: null, trades }
    } catch (e) {
      return {
        symbol,
        candleCount: 0,
        error: e instanceof Error ? e.message : 'failed',
        trades: [],
      }
    }
  })

  let skipped = 0
  const allTrades = []
  const perSymbol = []
  let maxSymbolBarCount = 0
  for (const r of raw) {
    if (r.error) {
      skipped += 1
      continue
    }
    if (r.candleCount > maxSymbolBarCount) maxSymbolBarCount = r.candleCount
    const sumR = r.trades.reduce((s, t) => s + t.rMultiple, 0)
    const tpN = r.trades.filter((t) => t.outcome === 'tp').length
    const slN = r.trades.filter((t) => t.outcome === 'sl').length
    const eodN = r.trades.filter((t) => t.outcome === 'eod').length
    perSymbol.push({
      symbol: r.symbol,
      candleCount: r.candleCount,
      tradeCount: r.trades.length,
      tpCount: tpN,
      slCount: slN,
      eodCount: eodN,
      sumR,
    })
    for (const t of r.trades) {
      allTrades.push({ symbol: r.symbol, ...t })
    }
  }

  perSymbol.sort((a, b) => {
    if (b.sumR !== a.sumR) return b.sumR - a.sumR
    return b.tradeCount - a.tradeCount
  })

  const dayBuckets = new Map()
  for (let t = range.startTime; t <= range.endTime; t += 86400000) {
    const key = formatUtcYmd(t)
    dayBuckets.set(key, {
      date: key,
      totalTrades: 0,
      sumPricePct: 0,
      tpHits: 0,
      slHits: 0,
      eodHits: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakevenTrades: 0,
      sumR: 0,
    })
  }

  for (const t of allTrades) {
    const dk = formatUtcYmd(t.entryOpenTime)
    const row = dayBuckets.get(dk)
    if (!row) continue
    row.totalTrades += 1
    row.sumPricePct += tradePriceReturnPct(t)
    if (t.outcome === 'tp') row.tpHits += 1
    else if (t.outcome === 'sl') row.slHits += 1
    else if (t.outcome === 'eod') row.eodHits += 1
    row.sumR += t.rMultiple
    const b = tradeWinLossBucket(t)
    if (b === 'win') row.winningTrades += 1
    else if (b === 'loss') row.losingTrades += 1
    else row.breakevenTrades += 1
  }

  let runCum = 0
  const daily = []
  for (let t = range.startTime; t <= range.endTime; t += 86400000) {
    const key = formatUtcYmd(t)
    const row = dayBuckets.get(key)
    const decided = row.tpHits + row.slHits
    const winRateTpVsSlPct = decided > 0 ? (100 * row.tpHits) / decided : null
    runCum += row.sumPricePct
    daily.push({
      date: row.date,
      totalTrades: row.totalTrades,
      sumPricePct: row.sumPricePct,
      cumulativeSumPricePct: runCum,
      referenceEquityPct: 100 + runCum,
      tpHits: row.tpHits,
      slHits: row.slHits,
      eodHits: row.eodHits,
      winningTrades: row.winningTrades,
      losingTrades: row.losingTrades,
      breakevenTrades: row.breakevenTrades,
      sumR: row.sumR,
      avgR: row.totalTrades > 0 ? row.sumR / row.totalTrades : null,
      winRateTpVsSlPct,
    })
  }

  const btcDaily = await fetchBtcDailyOhlcInRange(
    futuresBase,
    range.startTime,
    range.endTime,
    publicHeaders,
  )

  const meta =
    strat === 'shortSpikeLow'
      ? {
          strategy: 'shortSpikeLow',
          riskReward: 'TP at spike low / SL 2R (risk unit = 2R)',
          entryRule:
            'Short next open after green spike; R = spike close − spike low; SL = entry + 2R; TP = spike low',
          tpStatLabel: 'TP (spike low)',
          slStatLabel: 'SL (-1R @ 2×R)',
        }
      : strat === 'shortRedSpike'
        ? {
            strategy: 'shortRedSpike',
            riskReward: '2R TP / 1R SL (short, R above)',
            entryRule:
              'Short next open after red-body spike; R = spike high − spike close; SL = entry + R; TP = entry − 2R',
            tpStatLabel: 'TP (2R)',
            slStatLabel: 'SL (-1R)',
          }
        : {
            strategy: 'long',
            riskReward: '2R TP / 1R SL',
            entryRule: 'Long next open after green-body spike; R = spike close − spike low',
            tpStatLabel: 'TP (2R)',
            slStatLabel: 'SL (-1R)',
          }

  return {
    version: 3,
    interval,
    fromDate: range.fromDate,
    toDate: range.toDate,
    utcRangeStartMs: range.startTime,
    utcRangeEndMs: range.endTime,
    maxRangeDaysUtc: SPIKE_TPSL_V3_MAX_RANGE_DAYS,
    thresholdPct,
    binancePublicApiKeySent,
    ...meta,
    intrabarRule: 'Pessimistic: SL before TP if both touched same bar',
    universeNote:
      'No volume filter. Symbols = first N USDT-M perpetuals (alphabetical). Lower SPIKE_TPSL_V3_MAX_SYMBOLS or use coarser interval if requests time out.',
    requestedSymbols,
    symbolCount: perSymbol.length,
    symbolsCapped: requestedSymbols > maxSymbols,
    cappedAt: maxSymbols,
    skipped,
    maxSymbolBarCount,
    summaryMonth: summarizeAllTrades(allTrades),
    daily,
    btcDaily,
    perSymbol: perSymbol.slice(0, 200),
    perSymbolTruncated: perSymbol.length > 200,
    fetchedAt: new Date().toISOString(),
  }
}
