/**
 * V2: single UTC trade day; universe = symbols whose *previous* UTC day 1d quote volume ≥ min;
 * intraday backtest runs only on the selected day. (v1 unchanged in spikeTpSlBacktest.js.)
 *
 * Universe backtest: volume-filtered USDT-M perps, green-body spikes.
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
import {
  attachBtcCloseToEquityPoints,
  candlesToBtcCloseMap,
} from './spikeTpSlEquityBtc.js'

/** Single-day mode only (one trade date per request). */
export const SPIKE_TPSL_V2_MAX_RANGE_DAYS = 1

const KLINES_PAGE_LIMIT = 1500
const RANGE_FETCH_MAX_PAGES = 48

/** Keep HTTP JSON small so the UI does not freeze parsing/rendering huge arrays. */
const API_EQUITY_CURVE_MAX_POINTS = 2500
const API_PER_TRADE_PCT_MAX = 3500

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

function subsampleFloatSeries(arr, maxLen) {
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
 * Trade on UTC calendar day `tradeDate` (YYYY-MM-DD). Volume filter uses the prior UTC day’s 1d kline quote volume.
 * @returns {{ tradeDayStart: number, tradeDayEnd: number, tradeDate: string, volumeDayStart: number, volumeDate: string }}
 */
export function parseV2SingleTradeDate(tradeDateYmd) {
  const d = String(tradeDateYmd ?? '').trim()
  const tradeDayStart = parseUtcDayStart(d)
  if (tradeDayStart == null) {
    throw new Error('date must be a valid UTC calendar date as YYYY-MM-DD')
  }
  const tradeDayEnd = tradeDayStart + 86400000 - 1
  const volumeDayStart = tradeDayStart - 86400000
  if (volumeDayStart < 0) {
    throw new Error('trade date is too early (no previous UTC day for volume)')
  }
  return {
    tradeDayStart,
    tradeDayEnd,
    tradeDate: d,
    volumeDayStart,
    volumeDate: formatUtcYmd(volumeDayStart),
  }
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
 * Prior UTC day 1d kline: quote volume (USDT) and open→close % (same candle as volume filter).
 * @returns {{ quoteVolume: number, volumeDayChangePct: number | null } | null}
 */
async function fetchKline1dVolumeAndDayChange(futuresBase, symbol, dayStartMs, headers = {}) {
  const endMs = dayStartMs + 86400000 - 1
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(1))
  const q = new URLSearchParams({
    symbol,
    interval: '1d',
    limit: '1',
    startTime: String(dayStartMs),
    endTime: String(endMs),
  })
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
  if (!Array.isArray(data) || data.length === 0) return null
  const row = data[0]
  const qv = parseFloat(row[7])
  if (!Number.isFinite(qv)) return null
  const o = parseFloat(row[1])
  const c = parseFloat(row[4])
  const volumeDayChangePct =
    Number.isFinite(o) && o !== 0 && Number.isFinite(c) ? ((c - o) / o) * 100 : null
  return { quoteVolume: qv, volumeDayChangePct }
}

/**
 * All candles with openTime in [startTime, endTime], paginated (max KLINES_PAGE_LIMIT per request).
 */
async function fetchKlinesOHLCInRange(futuresBase, symbol, interval, startTime, endTime, headers = {}) {
  const byTime = new Map()
  let cursor = startTime
  const pageDelayMs = Number.parseInt(
    process.env.SPIKE_TPSL_V2_PAGE_DELAY_MS ?? process.env.SPIKE_TPSL_PAGE_DELAY_MS ?? '0',
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
 * Summary, equity curve, and trade tables from a full trade list (post-process / filtered views).
 * @param {object[]} perSymbolRows — pre-sorted rows for the per-symbol table
 */
function computeAggregatesBundle(allTrades, perSymbolRows, btcByOpenTime) {
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

  const chron = [...allTrades].sort((a, b) => {
    if (a.entryOpenTime !== b.entryOpenTime) return a.entryOpenTime - b.entryOpenTime
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
  })
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

  const tradesDesc = [...allTrades].sort((a, b) => b.entryOpenTime - a.entryOpenTime)

  return {
    summary: {
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
      finalEquityPct: lastPt?.equityPct ?? 100,
      finalPnlPctFromStart: lastPt?.pnlPctFromStart ?? 0,
    },
    equityCurve,
    equityCurveDownsampled,
    perTradePricePctChron,
    perTradePricePctSubsampled,
    perSymbol: perSymbolRows,
    symbolCount: perSymbolRows.length,
    trades: tradesDesc.slice(0, 400),
    tradesTruncated: allTrades.length > 400,
    totalTradeRows: allTrades.length,
  }
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

/**
 * @param {string} futuresBase
 * @param {object} opts
 * @param {number} opts.minQuoteVolume24h
 * @param {string} opts.interval
 * @param {number} opts.thresholdPct
 * @param {'long'|'shortSpikeLow'|'shortRedSpike'} [opts.strategy]
 * @param {string} opts.tradeDate YYYY-MM-DD UTC — backtest this day only; universe uses prior UTC day 1d quote volume
 */
export async function computeSpikeTpSlBacktestV2(futuresBase, opts) {
  const { minQuoteVolume24h, interval, thresholdPct, strategy = 'long', tradeDate } = opts
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

  const dayCtx = parseV2SingleTradeDate(tradeDate)
  const maxSymRaw = Number.parseInt(
    process.env.SPIKE_TPSL_V2_MAX_SYMBOLS ?? process.env.SPIKE_TPSL_MAX_SYMBOLS ?? '300',
    10,
  )
  const maxSymbols = Number.isFinite(maxSymRaw) && maxSymRaw > 0 ? maxSymRaw : 300
  const concRaw = Number.parseInt(
    process.env.SPIKE_TPSL_V2_CONCURRENCY ?? process.env.SPIKE_TPSL_CONCURRENCY ?? '4',
    10,
  )
  const CONCURRENCY =
    Number.isFinite(concRaw) && concRaw > 0 ? Math.min(16, concRaw) : 4

  const publicHeaders = binanceFuturesPublicHeaders()
  const binancePublicApiKeySent = Object.keys(publicHeaders).length > 0

  const allSyms = await fetchUsdmPerpetualSymbols(futuresBase, { headers: publicHeaders })
  const volumeRows = await mapPool(allSyms, CONCURRENCY, async (symbol) => {
    try {
      const d1 = await fetchKline1dVolumeAndDayChange(
        futuresBase,
        symbol,
        dayCtx.volumeDayStart,
        publicHeaders,
      )
      return {
        symbol,
        quoteVolume24h: d1?.quoteVolume ?? null,
        volumeDayChangePct: d1?.volumeDayChangePct ?? null,
        error: null,
      }
    } catch (e) {
      return {
        symbol,
        quoteVolume24h: null,
        volumeDayChangePct: null,
        error: e instanceof Error ? e.message : 'volume fetch failed',
      }
    }
  })

  const volFiltered = volumeRows.filter(
    (r) =>
      r.error == null &&
      r.quoteVolume24h != null &&
      Number.isFinite(r.quoteVolume24h) &&
      r.quoteVolume24h >= minQuoteVolume24h,
  )
  volFiltered.sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
  const requestedSymbols = volFiltered.length
  const selected = volFiltered.slice(0, maxSymbols)

  const raw = await mapPool(selected, CONCURRENCY, async (row) => {
    try {
      const candles = await fetchKlinesOHLCInRange(
        futuresBase,
        row.symbol,
        interval,
        dayCtx.tradeDayStart,
        dayCtx.tradeDayEnd,
        publicHeaders,
      )
      if (candles.length < 3) {
        return {
          symbol: row.symbol,
          quoteVolume24h: row.quoteVolume24h,
          volumeDayChangePct: row.volumeDayChangePct,
          error: 'not enough candles',
          trades: [],
        }
      }
      const trades = runSymbolTrades(candles, thresholdPct, strat)
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        volumeDayChangePct: row.volumeDayChangePct,
        candleCount: candles.length,
        error: null,
        trades,
      }
    } catch (e) {
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        volumeDayChangePct: row.volumeDayChangePct,
        error: e instanceof Error ? e.message : 'failed',
        trades: [],
      }
    }
  })

  let skipped = 0
  const allTrades = []
  const perSymbol = []
  for (const r of raw) {
    if (r.error) {
      skipped += 1
      continue
    }
    const sumR = r.trades.reduce((s, t) => s + t.rMultiple, 0)
    const tpN = r.trades.filter((t) => t.outcome === 'tp').length
    const slN = r.trades.filter((t) => t.outcome === 'sl').length
    const eodN = r.trades.filter((t) => t.outcome === 'eod').length
    perSymbol.push({
      symbol: r.symbol,
      quoteVolume24h: r.quoteVolume24h,
      volumeDayChangePct: r.volumeDayChangePct,
      candleCount: r.candleCount,
      tradeCount: r.trades.length,
      tpCount: tpN,
      slCount: slN,
      eodCount: eodN,
      sumR,
    })
    for (const t of r.trades) {
      allTrades.push({
        symbol: r.symbol,
        volumeDayChangePct: r.volumeDayChangePct,
        ...t,
      })
    }
  }

  perSymbol.sort((a, b) => {
    if (b.sumR !== a.sumR) return b.sumR - a.sumR
    return b.tradeCount - a.tradeCount
  })

  const maxSymbolBarCount =
    perSymbol.length > 0 ? Math.max(...perSymbol.map((p) => p.candleCount ?? 0)) : 0

  let btcByOpenTime = new Map()
  try {
    const btcCandles = await fetchKlinesOHLCInRange(
      futuresBase,
      'BTCUSDT',
      interval,
      dayCtx.tradeDayStart,
      dayCtx.tradeDayEnd,
      publicHeaders,
    )
    btcByOpenTime = candlesToBtcCloseMap(btcCandles)
  } catch (e) {
    console.error('BTCUSDT klines for equity overlay failed:', e)
  }

  const mainBundle = computeAggregatesBundle(allTrades, perSymbol, btcByOpenTime)

  const allTradesPriorDayUp = allTrades.filter(
    (t) =>
      t.volumeDayChangePct != null &&
      Number.isFinite(t.volumeDayChangePct) &&
      t.volumeDayChangePct > 0,
  )
  const perSymbolPriorDayUp = perSymbol.filter(
    (p) =>
      p.volumeDayChangePct != null &&
      Number.isFinite(p.volumeDayChangePct) &&
      p.volumeDayChangePct > 0,
  )
  perSymbolPriorDayUp.sort((a, b) => {
    if (b.sumR !== a.sumR) return b.sumR - a.sumR
    return b.tradeCount - a.tradeCount
  })
  const filteredBundle = computeAggregatesBundle(
    allTradesPriorDayUp,
    perSymbolPriorDayUp,
    btcByOpenTime,
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
    interval,
    rangeMode: true,
    singleDayMode: true,
    tradeDate: dayCtx.tradeDate,
    volumeFilterDate: dayCtx.volumeDate,
    fromDate: dayCtx.tradeDate,
    toDate: dayCtx.tradeDate,
    utcRangeStartMs: dayCtx.tradeDayStart,
    utcRangeEndMs: dayCtx.tradeDayEnd,
    maxRangeDaysUtc: SPIKE_TPSL_V2_MAX_RANGE_DAYS,
    candleCount: maxSymbolBarCount,
    candleCountTail: null,
    universeNote:
      'Symbols ranked by prior UTC day 1d kline quote volume (not live24h ticker). volumeDayChangePct is open→close % on that same 1d candle.',
    thresholdPct,
    minQuoteVolume24h,
    binancePublicApiKeySent,
    ...meta,
    equityCurveMode: 'summedPricePct',
    intrabarRule: 'Pessimistic: SL before TP if both touched same bar',
    requestedSymbols,
    symbolCount: mainBundle.symbolCount,
    symbolsCapped: requestedSymbols > maxSymbols,
    cappedAt: maxSymbols,
    skipped,
    summary: mainBundle.summary,
    equityCurve: mainBundle.equityCurve,
    equityCurveDownsampled: mainBundle.equityCurveDownsampled,
    perTradePricePctChron: mainBundle.perTradePricePctChron,
    perTradePricePctSubsampled: mainBundle.perTradePricePctSubsampled,
    perSymbol: mainBundle.perSymbol,
    trades: mainBundle.trades,
    tradesTruncated: mainBundle.tradesTruncated,
    totalTradeRows: mainBundle.totalTradeRows,
    filteredPositiveVolumeDay: {
      summary: filteredBundle.summary,
      equityCurve: filteredBundle.equityCurve,
      equityCurveDownsampled: filteredBundle.equityCurveDownsampled,
      perTradePricePctChron: filteredBundle.perTradePricePctChron,
      perTradePricePctSubsampled: filteredBundle.perTradePricePctSubsampled,
      perSymbol: filteredBundle.perSymbol,
      trades: filteredBundle.trades,
      tradesTruncated: filteredBundle.tradesTruncated,
      totalTradeRows: filteredBundle.totalTradeRows,
      symbolCount: filteredBundle.symbolCount,
    },
    fetchedAt: new Date().toISOString(),
  }
}
