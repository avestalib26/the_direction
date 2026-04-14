import crypto from 'node:crypto'
import cors from 'cors'
import express from 'express'
import {
  ALLOWED_INTERVALS,
  computeMarketBreadth,
} from './breadth.js'
import { computeMarketRegimeBreadth } from './marketRegimeBreadth.js'
import { computeClosedPositionPnl } from './closedPositions.js'
import { computeFutures24hVolumes } from './volumeScreener.js'
import { computeBacktest3Dataset } from './backtest3Data.js'
import { computeFiveMinScreener } from './fiveMinScreener.js'
import { computeZoneHedgeBacktest } from './zoneHedgeBacktest.js'
import { computeHourlySpikesBacktest } from './hourlySpikesBacktest.js'
import { mountHftRaveSse } from './hftRaveSse.js'
import { runGptBacktest } from './gptBacktest.js'
import { computeSpikeFilter, computeSpikeFilterUniverse } from './spikeFilterBacktest.js'
import {
  computeSpikeTpSlBacktest,
  parseSpikeTpSlUtcRange,
} from './spikeTpSlBacktest.js'
import {
  computeSpikeTpSlBacktestV2,
  parseV2SingleTradeDate,
} from './spikeTpSlBacktestV2.js'
import {
  computeSpikeTpSlBacktestV3,
  parseSpikeTpSlV3UtcRange,
} from './spikeTpSlBacktestV3.js'
import {
  acquireFuturesRestWeight,
  FUTURES_EXCHANGE_INFO_WEIGHT,
  futuresKlinesRequestWeight,
  futuresSignedPathWeight,
  FUTURES_TIME_WEIGHT,
} from './binanceFuturesRestThrottle.js'

const USE_TESTNET = process.env.BINANCE_USE_TESTNET === 'true'
const FUTURES_BASE =
  process.env.BINANCE_FUTURES_BASE ||
  (USE_TESTNET
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com')
/** Spot + SAPI (same API key as futures for typical Binance accounts). */
const SPOT_BASE =
  process.env.BINANCE_SPOT_BASE ||
  (USE_TESTNET ? 'https://testnet.binance.vision' : 'https://api.binance.com')
const FUTURES_WS_BASE =
  process.env.BINANCE_FUTURES_WS ||
  (USE_TESTNET ? 'wss://stream.binancefuture.com' : 'wss://fstream.binance.com')

class BinanceApiError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.name = 'BinanceApiError'
    this.statusCode = statusCode
  }
}

function signQuery(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

let serverTimeOffsetMs = 0
let serverTimeOffsetFetchedAt = 0
const SERVER_TIME_TTL_MS = 60_000

let spotServerTimeOffsetMs = 0
let spotServerTimeOffsetFetchedAt = 0

async function fetchSpotServerTimeOffset(force = false) {
  const now = Date.now()
  if (!force && now - spotServerTimeOffsetFetchedAt < SERVER_TIME_TTL_MS) {
    return spotServerTimeOffsetMs
  }
  try {
    const res = await fetch(`${SPOT_BASE}/api/v3/time`)
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    const serverTime = Number.parseInt(String(data.serverTime ?? ''), 10)
    if (res.ok && Number.isFinite(serverTime)) {
      spotServerTimeOffsetMs = serverTime - Date.now()
      spotServerTimeOffsetFetchedAt = Date.now()
    }
  } catch {
    // keep previous
  }
  return spotServerTimeOffsetMs
}

async function fetchServerTimeOffset(force = false) {
  const now = Date.now()
  if (!force && now - serverTimeOffsetFetchedAt < SERVER_TIME_TTL_MS) {
    return serverTimeOffsetMs
  }
  try {
    await acquireFuturesRestWeight(FUTURES_TIME_WEIGHT)
    const res = await fetch(`${FUTURES_BASE}/fapi/v1/time`)
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    const serverTime = Number.parseInt(String(data.serverTime ?? ''), 10)
    if (res.ok && Number.isFinite(serverTime)) {
      serverTimeOffsetMs = serverTime - Date.now()
      serverTimeOffsetFetchedAt = Date.now()
    }
  } catch {
    // Keep previous offset if time sync fails.
  }
  return serverTimeOffsetMs
}

/** Binance expects query params sorted by name for the signed payload. */
async function signedFuturesUrl(path, apiSecret, params, forceTimeSync = false) {
  const offsetMs = await fetchServerTimeOffset(forceTimeSync)
  const recvWindowRaw = Number.parseInt(String(process.env.BINANCE_RECV_WINDOW_MS ?? '10000'), 10)
  const recvWindow = Number.isFinite(recvWindowRaw) && recvWindowRaw > 0
    ? recvWindowRaw
    : 10_000
  const merged = {
    recvWindow,
    timestamp: Date.now() + offsetMs,
    ...params,
  }
  const qs = Object.keys(merged)
    .sort()
    .map((k) => `${k}=${merged[k]}`)
    .join('&')
  const signature = signQuery(apiSecret, qs)
  return `${FUTURES_BASE}${path}?${qs}&signature=${signature}`
}

async function signedSpotUrl(path, apiSecret, params, forceTimeSync = false) {
  const offsetMs = await fetchSpotServerTimeOffset(forceTimeSync)
  const recvWindowRaw = Number.parseInt(String(process.env.BINANCE_RECV_WINDOW_MS ?? '10000'), 10)
  const recvWindow = Number.isFinite(recvWindowRaw) && recvWindowRaw > 0
    ? recvWindowRaw
    : 10_000
  const merged = {
    recvWindow,
    timestamp: Date.now() + offsetMs,
    ...params,
  }
  const qs = Object.keys(merged)
    .sort()
    .map((k) => `${k}=${merged[k]}`)
    .join('&')
  const signature = signQuery(apiSecret, qs)
  return `${SPOT_BASE}${path}?${qs}&signature=${signature}`
}

async function signedSpotJson(apiKey, apiSecret, path, params) {
  const url = await signedSpotUrl(path, apiSecret, params)
  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new BinanceApiError(
      `Invalid JSON from Binance Spot (${res.status}): ${text.slice(0, 240)}`,
      res.status,
    )
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    if (res.status === 400 && /timestamp|recvWindow/i.test(String(msg))) {
      const retryUrl = await signedSpotUrl(path, apiSecret, params, true)
      const retryRes = await fetch(retryUrl, {
        headers: { 'X-MBX-APIKEY': apiKey },
      })
      const retryText = await retryRes.text()
      let retryData
      try {
        retryData = retryText ? JSON.parse(retryText) : {}
      } catch {
        throw new BinanceApiError(
          `Invalid JSON from Binance (${retryRes.status}): ${retryText.slice(0, 240)}`,
          retryRes.status,
        )
      }
      if (retryRes.ok) return retryData
      const retryMsg = retryData.msg || retryData.message || retryText
      throw new BinanceApiError(`Binance ${retryRes.status}: ${retryMsg}`, retryRes.status)
    }
    throw new BinanceApiError(`Binance ${res.status}: ${msg}`, res.status)
  }
  return data
}

async function signedSpotJsonPost(apiKey, apiSecret, path, params) {
  const url = await signedSpotUrl(path, apiSecret, params)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new BinanceApiError(
      `Invalid JSON from Binance Spot POST (${res.status}): ${text.slice(0, 240)}`,
      res.status,
    )
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    throw new BinanceApiError(`Binance ${res.status}: ${msg}`, res.status)
  }
  return data
}

async function signedFuturesJson(apiKey, apiSecret, path, params) {
  const url = await signedFuturesUrl(path, apiSecret, params)
  await acquireFuturesRestWeight(futuresSignedPathWeight(path))
  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new BinanceApiError(
      `Invalid JSON from Binance (${res.status}): ${text.slice(0, 240)}`,
      res.status,
    )
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    // Auto-recover from clock drift once by force-refreshing server time offset.
    if (res.status === 400 && /timestamp|recvWindow/i.test(String(msg))) {
      const retryUrl = await signedFuturesUrl(path, apiSecret, params, true)
      await acquireFuturesRestWeight(futuresSignedPathWeight(path))
      const retryRes = await fetch(retryUrl, {
        headers: { 'X-MBX-APIKEY': apiKey },
      })
      const retryText = await retryRes.text()
      let retryData
      try {
        retryData = retryText ? JSON.parse(retryText) : {}
      } catch {
        throw new BinanceApiError(
          `Invalid JSON from Binance (${retryRes.status}): ${retryText.slice(0, 240)}`,
          retryRes.status,
        )
      }
      if (retryRes.ok) return retryData
      const retryMsg = retryData.msg || retryData.message || retryText
      throw new BinanceApiError(`Binance ${retryRes.status}: ${retryMsg}`, retryRes.status)
    }
    throw new BinanceApiError(`Binance ${res.status}: ${msg}`, res.status)
  }
  return data
}

async function signedFuturesJsonPost(apiKey, apiSecret, path, params) {
  const url = await signedFuturesUrl(path, apiSecret, params)
  await acquireFuturesRestWeight(futuresSignedPathWeight(path))
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new BinanceApiError(
      `Invalid JSON from Binance (${res.status}): ${text.slice(0, 240)}`,
      res.status,
    )
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    if (res.status === 400 && /timestamp|recvWindow/i.test(String(msg))) {
      const retryUrl = await signedFuturesUrl(path, apiSecret, params, true)
      await acquireFuturesRestWeight(futuresSignedPathWeight(path))
      const retryRes = await fetch(retryUrl, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': apiKey },
      })
      const retryText = await retryRes.text()
      let retryData
      try {
        retryData = retryText ? JSON.parse(retryText) : {}
      } catch {
        throw new BinanceApiError(
          `Invalid JSON from Binance (${retryRes.status}): ${retryText.slice(0, 240)}`,
          retryRes.status,
        )
      }
      if (retryRes.ok) return retryData
      const retryMsg = retryData.msg || retryData.message || retryText
      throw new BinanceApiError(`Binance ${retryRes.status}: ${retryMsg}`, retryRes.status)
    }
    throw new BinanceApiError(`Binance ${res.status}: ${msg}`, res.status)
  }
  return data
}

let exchangeInfoCache = null
let exchangeInfoCacheAt = 0
const EXCHANGE_INFO_TTL_MS = 5 * 60_000

function toNum(x) {
  const n = Number.parseFloat(String(x ?? ''))
  return Number.isFinite(n) ? n : null
}

function decimalPlaces(step) {
  const s = String(step ?? '').trim()
  if (!s || !s.includes('.')) return 0
  return s.replace(/0+$/, '').split('.')[1]?.length ?? 0
}

function quantizeToStep(value, step, mode = 'floor') {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value
  const u = value / step
  let units
  if (mode === 'ceil') {
    units = Math.ceil(u - Number.EPSILON)
  } else if (mode === 'round') {
    units = Math.round(u)
  } else {
    units = Math.floor(u + Number.EPSILON)
  }
  return units * step
}

function fmtByStep(value, step, precisionCap = null) {
  const d = decimalPlaces(step)
  let use = Math.max(0, d)
  if (Number.isFinite(precisionCap) && precisionCap >= 0) {
    use = Math.min(use, Math.floor(precisionCap))
  }
  return value.toFixed(Math.min(12, use))
}

async function getFuturesExchangeInfo() {
  const now = Date.now()
  if (exchangeInfoCache && now - exchangeInfoCacheAt < EXCHANGE_INFO_TTL_MS) {
    return exchangeInfoCache
  }
  await acquireFuturesRestWeight(FUTURES_EXCHANGE_INFO_WEIGHT)
  const r = await fetch(`${FUTURES_BASE}/fapi/v1/exchangeInfo`)
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Invalid exchangeInfo JSON (${r.status})`)
  }
  if (!r.ok || !Array.isArray(data?.symbols)) {
    const msg = data?.msg || data?.message || text
    throw new Error(`Binance ${r.status}: ${msg}`)
  }
  exchangeInfoCache = data
  exchangeInfoCacheAt = now
  return data
}

async function getSymbolSpec(symbol) {
  const info = await getFuturesExchangeInfo()
  const row = info.symbols.find((s) => s?.symbol === symbol)
  if (!row) {
    throw new Error(`Symbol not found on Binance Futures: ${symbol}`)
  }
  const lot = row.filters?.find((f) => f?.filterType === 'LOT_SIZE')
  const priceFilter = row.filters?.find((f) => f?.filterType === 'PRICE_FILTER')
  const stepSize = toNum(lot?.stepSize) ?? 0.001
  const minQty = toNum(lot?.minQty) ?? stepSize
  const tickSize = toNum(priceFilter?.tickSize) ?? 0.01
  return {
    stepSize,
    minQty,
    tickSize,
    quantityPrecision: row.quantityPrecision,
    pricePrecision: row.pricePrecision,
  }
}

/** Signed Binance routes: map 451 geo-block and other Binance statuses to HTTP response. */
function sendBinanceRouteError(res, e) {
  console.error(e)
  if (e instanceof BinanceApiError && e.statusCode === 451) {
    return res.status(451).json({
      code: 'BINANCE_GEO_BLOCKED',
      error:
        'Binance Futures API rejected this request because of server location (HTTP 451). ' +
        'Hosting on Vercel often uses an outbound IP in a restricted region. ' +
        'Options: run the API on a small VPS in a region where Binance Futures is allowed, ' +
        'or run the app locally (npm run dev) from your home network. ' +
        `Details: ${e.message}`,
    })
  }
  if (e instanceof BinanceApiError && e.statusCode >= 400 && e.statusCode < 500) {
    return res.status(e.statusCode).json({ error: e.message })
  }
  return res.status(502).json({
    error: e instanceof Error ? e.message : 'Binance request failed',
  })
}

async function fetchPositionRisk(apiKey, apiSecret) {
  return signedFuturesJson(apiKey, apiSecret, '/fapi/v2/positionRisk', {})
}

/**
 * USDT-M futures wallet (USDT) — Binance sometimes omits or zeros
 * totalWalletBalance; fall back to assets[] then /fapi/v2/balance.
 */
async function getFuturesUsdtWalletTotal(apiKey, apiSecret) {
  const acc = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
  const top = parseFloat(acc.totalWalletBalance ?? '')
  if (Number.isFinite(top) && top !== 0) {
    return top
  }
  const assets = acc.assets
  if (Array.isArray(assets)) {
    const usdt = assets.find((a) => a.asset === 'USDT')
    if (usdt) {
      const w = parseFloat(
        usdt.walletBalance ?? usdt.crossWalletBalance ?? usdt.marginBalance ?? '',
      )
      if (Number.isFinite(w)) return w
    }
  }
  const bal = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/balance', {})
  if (Array.isArray(bal)) {
    const row = bal.find((b) => b.asset === 'USDT')
    if (row) {
      const w = parseFloat(
        row.crossWalletBalance ?? row.walletBalance ?? row.balance ?? '',
      )
      if (Number.isFinite(w)) return w
    }
  }
  return Number.isFinite(top) ? top : 0
}

/** Spot wallet USDT (free + locked), excluding futures & funding wallets. */
async function getSpotUsdtTotal(apiKey, apiSecret) {
  const acc = await signedSpotJson(apiKey, apiSecret, '/api/v3/account', {})
  if (!Array.isArray(acc.balances)) return 0
  const row = acc.balances.find((b) => b.asset === 'USDT')
  if (!row) return 0
  const free = parseFloat(row.free ?? '')
  const locked = parseFloat(row.locked ?? '')
  return (Number.isFinite(free) ? free : 0) + (Number.isFinite(locked) ? locked : 0)
}

/**
 * Funding wallet USDT (optional; fails silently if API disabled for key).
 * POST /sapi/v1/asset/get-funding-asset
 */
async function getFundingUsdtTotal(apiKey, apiSecret) {
  try {
    const data = await signedSpotJsonPost(
      apiKey,
      apiSecret,
      '/sapi/v1/asset/get-funding-asset',
      {},
    )
    if (!Array.isArray(data)) return 0
    const row = data.find((x) => x.asset === 'USDT')
    if (!row) return 0
    const free = parseFloat(row.free ?? '')
    const locked = parseFloat(row.locked ?? '')
    return (Number.isFinite(free) ? free : 0) + (Number.isFinite(locked) ? locked : 0)
  } catch {
    return 0
  }
}

export const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '512kb' }))

mountHftRaveSse(app, { futuresWsBase: FUTURES_WS_BASE })

/** No Binance call — use to verify `/api` routing on Vercel (should return JSON quickly). */
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, t: Date.now() })
})

app.get('/api/binance/futures-wallet', async (_req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  try {
    const totalWalletBalance = await getFuturesUsdtWalletTotal(
      apiKey,
      apiSecret,
    )
    res.json({
      totalWalletBalance,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    return sendBinanceRouteError(res, e)
  }
})

/**
 * Combined USDT: spot + USDT-M futures + funding (when available).
 * Used by The 100k progress (whole account, not futures-only).
 */
app.get('/api/binance/total-account-wallet', async (_req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  try {
    const [spotUsdt, futuresUsdt, fundingUsdt] = await Promise.all([
      getSpotUsdtTotal(apiKey, apiSecret),
      getFuturesUsdtWalletTotal(apiKey, apiSecret),
      getFundingUsdtTotal(apiKey, apiSecret),
    ])
    const totalWalletBalance = spotUsdt + futuresUsdt + fundingUsdt
    res.json({
      totalWalletBalance,
      spotUsdt,
      futuresUsdt,
      fundingUsdt,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    return sendBinanceRouteError(res, e)
  }
})

app.get('/api/binance/open-positions', async (_req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  try {
    const all = await fetchPositionRisk(apiKey, apiSecret)
    const positions = Array.isArray(all)
      ? all.filter((p) => Math.abs(parseFloat(p.positionAmt || 0)) > 0)
      : []
    res.json({ positions, fetchedAt: new Date().toISOString() })
  } catch (e) {
    return sendBinanceRouteError(res, e)
  }
})

app.post('/api/binance/test-order', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }

  let symbol = String(req.body?.symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!symbol.length || symbol.length > 32) {
    return res.status(400).json({ error: 'symbol required (e.g. BTC or BTCUSDT)' })
  }
  if (!symbol.endsWith('USDT')) symbol = `${symbol}USDT`

  const side = String(req.body?.side ?? 'BUY').trim().toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') {
    return res.status(400).json({ error: 'side must be BUY or SELL' })
  }

  const tradeSizeUsd = Number.parseFloat(String(req.body?.tradeSizeUsd ?? '0'))
  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) {
    return res.status(400).json({ error: 'tradeSizeUsd must be a positive number' })
  }
  const leverage = Number.parseInt(String(req.body?.leverage ?? '5'), 10)
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) {
    return res.status(400).json({ error: 'leverage must be an integer between 1 and 125' })
  }
  const tpPct = Number.parseFloat(String(req.body?.tpPct ?? '0'))
  const slPct = Number.parseFloat(String(req.body?.slPct ?? '0'))
  if (!Number.isFinite(tpPct) || tpPct <= 0) {
    return res.status(400).json({ error: 'tpPct must be a positive number' })
  }
  if (!Number.isFinite(slPct) || slPct <= 0) {
    return res.status(400).json({ error: 'slPct must be a positive number' })
  }

  try {
    const spec = await getSymbolSpec(symbol)

    await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/leverage', {
      symbol,
      leverage,
    })

    const tickerQ = new URLSearchParams({ symbol })
    const tickerRes = await fetch(`${FUTURES_BASE}/fapi/v1/ticker/price?${tickerQ}`)
    const tickerText = await tickerRes.text()
    let ticker
    try {
      ticker = tickerText ? JSON.parse(tickerText) : {}
    } catch {
      return res.status(502).json({ error: 'Invalid Binance ticker response' })
    }
    const markPrice = Number.parseFloat(String(ticker?.price ?? ''))
    if (!Number.isFinite(markPrice) || markPrice <= 0) {
      return res.status(502).json({ error: 'Could not resolve current symbol price' })
    }

    const effectiveNotionalUsd = tradeSizeUsd * leverage
    const rawQty = effectiveNotionalUsd / markPrice
    const qty = quantizeToStep(rawQty, spec.stepSize, 'floor')
    if (!Number.isFinite(qty) || qty <= 0 || qty < spec.minQty) {
      return res.status(400).json({
        error: `tradeSizeUsd × leverage is too small for ${symbol}. Minimum quantity is ${spec.minQty}.`,
      })
    }
    const quantity = fmtByStep(qty, spec.stepSize, spec.quantityPrecision)

    const entryOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    })

    let entryPrice = Number.parseFloat(String(entryOrder?.avgPrice ?? ''))
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      const risk = await fetchPositionRisk(apiKey, apiSecret)
      const row = Array.isArray(risk)
        ? risk.find((p) => String(p?.symbol ?? '') === symbol && Math.abs(parseFloat(p?.positionAmt ?? '0')) > 0)
        : null
      const rp = Number.parseFloat(String(row?.entryPrice ?? ''))
      entryPrice = Number.isFinite(rp) && rp > 0 ? rp : markPrice
    }

    const exitSide = side === 'BUY' ? 'SELL' : 'BUY'
    const tpPriceRaw = side === 'BUY'
      ? entryPrice * (1 + tpPct / 100)
      : entryPrice * (1 - tpPct / 100)
    const slPriceRaw = side === 'BUY'
      ? entryPrice * (1 - slPct / 100)
      : entryPrice * (1 + slPct / 100)
    const tpMode = side === 'BUY' ? 'ceil' : 'floor'
    const slMode = side === 'BUY' ? 'floor' : 'ceil'
    const tpPriceNum = quantizeToStep(tpPriceRaw, spec.tickSize, tpMode)
    const slPriceNum = quantizeToStep(slPriceRaw, spec.tickSize, slMode)
    if (!Number.isFinite(tpPriceNum) || tpPriceNum <= 0 || !Number.isFinite(slPriceNum) || slPriceNum <= 0) {
      return res.status(400).json({ error: 'Computed TP/SL prices are invalid for this symbol tick size.' })
    }
    const tpPrice = fmtByStep(tpPriceNum, spec.tickSize, spec.pricePrecision)
    const slPrice = fmtByStep(slPriceNum, spec.tickSize, spec.pricePrecision)

    let tpOrder = null
    let slOrder = null
    const warnings = []

    try {
      tpOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/order', {
        symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: tpPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        priceProtect: 'true',
      })
    } catch (e) {
      warnings.push(`TP order failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }

    try {
      slOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/order', {
        symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice: slPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        priceProtect: 'true',
      })
    } catch (e) {
      warnings.push(`SL order failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }

    return res.json({
      ok: true,
      symbol,
      side,
      leverage,
      tradeSizeUsd,
      effectiveNotionalUsd,
      quantity,
      entryPrice,
      tpPrice,
      slPrice,
      entryOrder,
      tpOrder,
      slOrder,
      warnings,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    return sendBinanceRouteError(res, e)
  }
})

/** Public USDT-M klines for client-side backtests (no API key). */
app.get('/api/binance/futures-klines', async (req, res) => {
  let symbol = String(req.query.symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!symbol.length || symbol.length > 32) {
    return res.status(400).json({
      error: 'symbol required (e.g. BTC or BTCUSDT)',
    })
  }
  if (!symbol.endsWith('USDT')) {
    symbol = `${symbol}USDT`
  }
  const interval = String(req.query.interval ?? '1h')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }
  const limit = Number.parseInt(String(req.query.limit ?? '200'), 10)
  if (!Number.isFinite(limit) || limit < 20 || limit > 1500) {
    return res.status(400).json({
      error: 'limit must be between 20 and 1500',
    })
  }
  const q = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  })
  try {
    const url = `${FUTURES_BASE}/fapi/v1/klines?${q}`
    await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
    const r = await fetch(url)
    const text = await r.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return res.status(502).json({
        error: `Binance klines error (${r.status}): ${text.slice(0, 200)}`,
      })
    }
    if (!r.ok) {
      const msg = data.msg || data.message || text
      return res.status(502).json({ error: `Binance ${r.status}: ${msg}` })
    }
    if (!Array.isArray(data)) {
      return res.status(502).json({ error: 'Unexpected klines response' })
    }
    const candles = data.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
    res.json({
      symbol,
      interval,
      limit: candles.length,
      candles,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Klines request failed',
    })
  }
})

/**
 * GPT backtest: 1h klines → green spike at i → 50 candles (OHLCV) ending at i →
 * OpenAI returns continuation vs reversal vs neutral for i+1 vs actual bar shape. Requires OPENAI_API_KEY in env.
 */
app.post('/api/gpt-backtest/run', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return res.status(503).json({
      error:
        'Set OPENAI_API_KEY in the project .env (server) to run GPT backtest. The key is never sent from the browser.',
    })
  }

  let symbol = String(req.body?.symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!symbol.length || symbol.length > 32) {
    return res.status(400).json({ error: 'symbol required (e.g. BTC or BTCUSDT)' })
  }
  if (!symbol.endsWith('USDT')) {
    symbol = `${symbol}USDT`
  }

  const candleCount = Number.parseInt(String(req.body?.candleCount ?? 500), 10)
  if (!Number.isFinite(candleCount) || candleCount < 60 || candleCount > 1500) {
    return res.status(400).json({
      error: 'candleCount must be between 60 and 1500',
    })
  }

  const thresholdPct = Number.parseFloat(String(req.body?.thresholdPct ?? 3))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({ error: 'thresholdPct must be a positive number' })
  }

  const maxEvents = Number.parseInt(String(req.body?.maxEvents ?? 8), 10)
  if (!Number.isFinite(maxEvents) || maxEvents < 1 || maxEvents > 40) {
    return res.status(400).json({ error: 'maxEvents must be between 1 and 40' })
  }

  const model = String(
    req.body?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  ).trim()

  try {
    const out = await runGptBacktest({
      futuresBase: FUTURES_BASE,
      symbol,
      candleCount,
      thresholdPct,
      maxEvents,
      apiKey,
      model,
    })
    res.json(out)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'GPT backtest failed',
    })
  }
})

/**
 * Daily regime framework: B1–B4, z-scores, regime score, slope, momentum picks,
 * washout/rebound, simplified sim (see server/marketRegimeBreadth.js).
 */
app.get('/api/binance/market-regime-breadth', async (req, res) => {
  const q = req.query
  const minQuoteVolume = Number.parseFloat(String(q.minQuoteVolume ?? '2000000'))
  const maxSymbols = Number.parseInt(String(q.maxSymbols ?? '150'), 10)
  const dailyLimit = Number.parseInt(String(q.dailyLimit ?? '400'), 10)
  const minHistoryDays = Number.parseInt(String(q.minHistoryDays ?? '90'), 10)
  const zWindow = Number.parseInt(String(q.zWindow ?? '20'), 10)
  const k = Number.parseInt(String(q.k ?? '5'), 10)
  const regimeThreshold = Number.parseFloat(String(q.regimeThreshold ?? '0.75'))
  if (!Number.isFinite(minQuoteVolume) || minQuoteVolume < 0) {
    return res.status(400).json({ error: 'minQuoteVolume must be >= 0' })
  }
  if (!Number.isFinite(maxSymbols) || maxSymbols < 10 || maxSymbols > 400) {
    return res.status(400).json({ error: 'maxSymbols must be between 10 and 400' })
  }
  if (!Number.isFinite(dailyLimit) || dailyLimit < 120 || dailyLimit > 1500) {
    return res.status(400).json({ error: 'dailyLimit must be between 120 and 1500' })
  }
  if (!Number.isFinite(minHistoryDays) || minHistoryDays < 30) {
    return res.status(400).json({ error: 'minHistoryDays must be >= 30' })
  }
  if (!Number.isFinite(zWindow) || zWindow < 10 || zWindow > 60) {
    return res.status(400).json({ error: 'zWindow must be between 10 and 60' })
  }
  if (!Number.isFinite(k) || k < 1 || k > 20) {
    return res.status(400).json({ error: 'k must be between 1 and 20' })
  }
  if (!Number.isFinite(regimeThreshold) || regimeThreshold <= 0 || regimeThreshold > 2) {
    return res.status(400).json({ error: 'regimeThreshold must be in (0, 2]' })
  }
  try {
    const result = await computeMarketRegimeBreadth(FUTURES_BASE, {
      minQuoteVolume,
      maxSymbols,
      dailyLimit,
      minHistoryDays,
      zWindow,
      k,
      regimeThreshold,
    })
    if (result.error) {
      return res.status(400).json({ error: result.error })
    }
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Market regime breadth failed',
    })
  }
})

app.get('/api/binance/market-breadth', async (req, res) => {
  const interval = String(req.query.interval ?? '5m')
  const limit = Number.parseInt(String(req.query.limit ?? '30'), 10)
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }
  if (!Number.isFinite(limit) || limit < 2 || limit > 1500) {
    return res.status(400).json({
      error: 'limit must be between 2 and 1500',
    })
  }
  try {
    const result = await computeMarketBreadth(FUTURES_BASE, interval, limit)
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Market breadth failed',
    })
  }
})

/** Public: volume-filtered 1h klines for all matching USDT-M perpetuals (Backtest 3). */
app.get('/api/binance/backtest3-dataset', async (req, res) => {
  const minQuoteVolume = Number.parseFloat(String(req.query.minQuoteVolume ?? '1000000'))
  if (!Number.isFinite(minQuoteVolume) || minQuoteVolume < 0) {
    return res.status(400).json({ error: 'minQuoteVolume must be a non-negative number' })
  }
  const mode = String(req.query.mode ?? 'above').toLowerCase() === 'below' ? 'below' : 'above'
  const limit = Number.parseInt(String(req.query.limit ?? '100'), 10)
  if (!Number.isFinite(limit) || limit < 20 || limit > 1500) {
    return res.status(400).json({
      error: 'limit must be between 20 and 1500 (1h candles)',
    })
  }
  if (limit % 2 !== 0) {
    return res.status(400).json({
      error: 'Use an even number of 1h candles so each 2h cycle is complete.',
    })
  }
  try {
    const result = await computeBacktest3Dataset(FUTURES_BASE, {
      minQuoteVolume,
      mode,
      limit,
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Backtest 3 dataset failed',
    })
  }
})

/** Public: USDT-M perpetual 24h quote volume (USDT) and last price for all symbols. */
app.get('/api/binance/futures-24h-volumes', async (req, res) => {
  try {
    const rows = await computeFutures24hVolumes(FUTURES_BASE)
    res.json({
      rows,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : '24h volume fetch failed',
    })
  }
})

function parseQueryBool(v) {
  const s = String(v ?? '').toLowerCase().trim()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/**
 * Green body spikes (+ optional red / negative body spikes) + next candle + optional filters.
 * Omit symbol (or empty) to scan all USDT-M perpetuals with 24h volume ≥ minQuoteVolume24h.
 */
app.get('/api/binance/spike-filter', async (req, res) => {
  let symbol = String(req.query.symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const useUniverse = symbol.length === 0
  if (!useUniverse) {
    if (symbol.length > 32) {
      return res.status(400).json({ error: 'invalid symbol' })
    }
    if (!symbol.endsWith('USDT')) {
      symbol = `${symbol}USDT`
    }
  }

  const interval = String(req.query.interval ?? '1h')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }

  const limit = Number.parseInt(String(req.query.limit ?? '500'), 10)
  if (!Number.isFinite(limit) || limit < 20 || limit > 1500) {
    return res.status(400).json({ error: 'limit must be between 20 and 1500' })
  }

  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({ error: 'thresholdPct must be a positive number' })
  }

  const minSpikeQuoteVolume = Number.parseFloat(String(req.query.minSpikeQuoteVolume ?? '0'))
  if (!Number.isFinite(minSpikeQuoteVolume) || minSpikeQuoteVolume < 0) {
    return res.status(400).json({ error: 'minSpikeQuoteVolume must be >= 0' })
  }

  const minQuoteVolume24h = Number.parseFloat(String(req.query.minQuoteVolume24h ?? '1000000'))
  if (useUniverse && (!Number.isFinite(minQuoteVolume24h) || minQuoteVolume24h < 0)) {
    return res.status(400).json({
      error: 'minQuoteVolume24h must be >= 0 for universe scan',
    })
  }

  const trendFilterEnabled = parseQueryBool(req.query.trendFilter)
  const trendLookback = Number.parseInt(String(req.query.trendLookback ?? '15'), 10)
  if (!Number.isFinite(trendLookback) || trendLookback < 1 || trendLookback > 500) {
    return res.status(400).json({ error: 'trendLookback must be between 1 and 500' })
  }

  let trendDirection = String(req.query.trendDirection ?? 'up').toLowerCase()
  if (trendDirection !== 'up' && trendDirection !== 'down') {
    trendDirection = 'up'
  }

  const volumeRatioFilterEnabled = parseQueryBool(req.query.volumeRatioFilter)
  const volumeLookback = Number.parseInt(String(req.query.volumeLookback ?? '15'), 10)
  if (!Number.isFinite(volumeLookback) || volumeLookback < 1 || volumeLookback > 500) {
    return res.status(400).json({ error: 'volumeLookback must be between 1 and 500' })
  }

  const volumeMultiplier = Number.parseFloat(String(req.query.volumeMultiplier ?? '2'))
  if (!Number.isFinite(volumeMultiplier) || volumeMultiplier <= 0) {
    return res.status(400).json({ error: 'volumeMultiplier must be a positive number' })
  }

  const includeNegativeSpikes = parseQueryBool(req.query.includeNegativeSpikes)

  const filterPayload = {
    interval,
    limit,
    thresholdPct,
    minSpikeQuoteVolume,
    includeNegativeSpikes,
    trendFilterEnabled,
    trendLookback,
    trendDirection,
    volumeRatioFilterEnabled,
    volumeLookback,
    volumeMultiplier,
  }

  try {
    if (useUniverse) {
      const result = await computeSpikeFilterUniverse(FUTURES_BASE, {
        ...filterPayload,
        minQuoteVolume24h,
      })
      res.json(result)
    } else {
      const result = await computeSpikeFilter(FUTURES_BASE, {
        ...filterPayload,
        symbol,
      })
      res.json(result)
    }
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Spike filter failed',
    })
  }
})

/** Public: volume-filtered universe, green-body spikes — long 2R/1R or short (TP spike low, SL 2R). */
app.get('/api/binance/spike-tpsl-backtest', async (req, res) => {
  const minQuoteVolume24h = Number.parseFloat(String(req.query.minQuoteVolume24h ?? '1000000'))
  if (!Number.isFinite(minQuoteVolume24h) || minQuoteVolume24h < 0) {
    return res.status(400).json({ error: 'minQuoteVolume24h must be >= 0' })
  }

  const interval = String(req.query.interval ?? '5m')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }

  const candleCount = Number.parseInt(String(req.query.candleCount ?? '500'), 10)
  if (!Number.isFinite(candleCount) || candleCount < 50 || candleCount > 1500) {
    return res.status(400).json({ error: 'candleCount must be between 50 and 1500' })
  }

  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({ error: 'thresholdPct must be a positive number' })
  }

  const strategyRaw = String(req.query.strategy ?? 'long').trim()
  const s = strategyRaw.toLowerCase().replace(/-/g, '_')
  let strategy
  if (s === 'long') strategy = 'long'
  else if (s === 'short' || s === 'short_spike_low' || s === 'shortspikelow') strategy = 'shortSpikeLow'
  else if (
    s === 'short_red_spike' ||
    s === 'shortredspike' ||
    s === 'negative_spike' ||
    s === 'negativespike'
  ) {
    strategy = 'shortRedSpike'
  } else {
    return res.status(400).json({
      error:
        'strategy must be long, shortSpikeLow (green spike: TP spike low), or shortRedSpike / negative_spike (red spike: short 2R/1R)',
    })
  }

  const fromQ = req.query.fromDate
  const toQ = req.query.toDate
  const fromDate =
    fromQ != null && String(fromQ).trim() !== '' ? String(fromQ).trim() : ''
  const toDate = toQ != null && String(toQ).trim() !== '' ? String(toQ).trim() : ''
  if (Boolean(fromDate) !== Boolean(toDate)) {
    return res.status(400).json({
      error:
        'Provide both fromDate and toDate (YYYY-MM-DD, UTC calendar days), or omit both to use latest candles.',
    })
  }
  if (fromDate && toDate) {
    try {
      parseSpikeTpSlUtcRange(fromDate, toDate)
    } catch (e) {
      return res.status(400).json({
        error: e instanceof Error ? e.message : 'Invalid date range',
      })
    }
  }

  try {
    const result = await computeSpikeTpSlBacktest(FUTURES_BASE, {
      minQuoteVolume24h,
      interval,
      candleCount,
      thresholdPct,
      strategy,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Spike TP/SL backtest failed',
    })
  }
})

/** V2: single UTC trade day; universe = prior UTC day 1d quote volume ≥ min (see spikeTpSlBacktestV2.js). */
app.get('/api/binance/spike-tpsl-backtest-v2', async (req, res) => {
  const minQuoteVolume24h = Number.parseFloat(String(req.query.minQuoteVolume24h ?? '1000000'))
  if (!Number.isFinite(minQuoteVolume24h) || minQuoteVolume24h < 0) {
    return res.status(400).json({ error: 'minQuoteVolume24h must be >= 0' })
  }

  const interval = String(req.query.interval ?? '5m')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }

  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({ error: 'thresholdPct must be a positive number' })
  }

  const strategyRaw = String(req.query.strategy ?? 'long').trim()
  const s = strategyRaw.toLowerCase().replace(/-/g, '_')
  let strategy
  if (s === 'long') strategy = 'long'
  else if (s === 'short' || s === 'short_spike_low' || s === 'shortspikelow') strategy = 'shortSpikeLow'
  else if (
    s === 'short_red_spike' ||
    s === 'shortredspike' ||
    s === 'negative_spike' ||
    s === 'negativespike'
  ) {
    strategy = 'shortRedSpike'
  } else {
    return res.status(400).json({
      error:
        'strategy must be long, shortSpikeLow (green spike: TP spike low), or shortRedSpike / negative_spike (red spike: short 2R/1R)',
    })
  }

  const dateRaw = req.query.date ?? req.query.tradeDate
  const tradeDate = dateRaw != null && String(dateRaw).trim() !== '' ? String(dateRaw).trim() : ''
  if (!tradeDate) {
    return res.status(400).json({
      error: 'Provide date (YYYY-MM-DD, UTC): backtest that calendar day; universe uses the previous UTC day’s 1d quote volume.',
    })
  }

  let dayCtx
  try {
    dayCtx = parseV2SingleTradeDate(tradeDate)
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : 'Invalid date',
    })
  }
  if (dayCtx.tradeDayStart > Date.now()) {
    return res.status(400).json({ error: 'trade date cannot be in the future (UTC)' })
  }

  try {
    const result = await computeSpikeTpSlBacktestV2(FUTURES_BASE, {
      minQuoteVolume24h,
      interval,
      thresholdPct,
      strategy,
      tradeDate,
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Spike TP/SL backtest v2 failed',
    })
  }
})

/** V3: no volume filter; multi-day UTC range (≤31d); daily Σ price % + metrics; BTCUSDT 1d compare. */
app.get('/api/binance/spike-tpsl-backtest-v3', async (req, res) => {
  const interval = String(req.query.interval ?? '15m')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }

  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({ error: 'thresholdPct must be a positive number' })
  }

  const strategyRaw = String(req.query.strategy ?? 'long').trim()
  const s = strategyRaw.toLowerCase().replace(/-/g, '_')
  let strategy
  if (s === 'long') strategy = 'long'
  else if (s === 'short' || s === 'short_spike_low' || s === 'shortspikelow') strategy = 'shortSpikeLow'
  else if (
    s === 'short_red_spike' ||
    s === 'shortredspike' ||
    s === 'negative_spike' ||
    s === 'negativespike'
  ) {
    strategy = 'shortRedSpike'
  } else {
    return res.status(400).json({
      error:
        'strategy must be long, shortSpikeLow (green spike: TP spike low), or shortRedSpike / negative_spike (red spike: short 2R/1R)',
    })
  }

  const fromDate =
    req.query.fromDate != null && String(req.query.fromDate).trim() !== ''
      ? String(req.query.fromDate).trim()
      : ''
  const toDate =
    req.query.toDate != null && String(req.query.toDate).trim() !== ''
      ? String(req.query.toDate).trim()
      : ''
  if (!fromDate || !toDate) {
    return res.status(400).json({
      error: 'Provide fromDate and toDate (YYYY-MM-DD, UTC), max 31 inclusive days.',
    })
  }

  try {
    parseSpikeTpSlV3UtcRange(fromDate, toDate)
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : 'Invalid date range',
    })
  }

  try {
    const result = await computeSpikeTpSlBacktestV3(FUTURES_BASE, {
      interval,
      thresholdPct,
      strategy,
      fromDate,
      toDate,
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Spike TP/SL backtest v3 failed',
    })
  }
})

/** Public: hourly (1h) wick spike scan — volume filter, spike count per hour slot & per UTC hour. */
app.get('/api/binance/hourly-spikes-backtest', async (req, res) => {
  const candleCount = Number.parseInt(String(req.query.candleCount ?? '500'), 10)
  if (!Number.isFinite(candleCount) || candleCount < 1 || candleCount > 1500) {
    return res.status(400).json({
      error: 'candleCount must be between 1 and 1500',
    })
  }
  const minQuoteVolume = Number.parseFloat(String(req.query.minQuoteVolume ?? '1000000'))
  if (!Number.isFinite(minQuoteVolume) || minQuoteVolume < 0) {
    return res.status(400).json({
      error: 'minQuoteVolume must be a non-negative number',
    })
  }
  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({
      error: 'thresholdPct must be a positive number',
    })
  }
  const spikeDirections = String(req.query.spikeDirections ?? 'up').toLowerCase()
  if (!['up', 'down', 'both'].includes(spikeDirections)) {
    return res.status(400).json({
      error: 'spikeDirections must be up, down, or both',
    })
  }
  try {
    const result = await computeHourlySpikesBacktest(FUTURES_BASE, {
      candleCount,
      minQuoteVolume,
      thresholdPct,
      spikeDirections,
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Hourly spikes backtest failed',
    })
  }
})

/** Public: 5m spike screener across USDT-M perps with 24h volume filter. */
app.get('/api/binance/5m-screener', async (req, res) => {
  const candleCount = Number.parseInt(String(req.query.candleCount ?? '120'), 10)
  if (!Number.isFinite(candleCount) || candleCount < 1 || candleCount > 1500) {
    return res.status(400).json({
      error: 'candleCount must be between 1 and 1500',
    })
  }
  const minQuoteVolume = Number.parseFloat(String(req.query.minQuoteVolume ?? '1000000'))
  if (!Number.isFinite(minQuoteVolume) || minQuoteVolume < 0) {
    return res.status(400).json({
      error: 'minQuoteVolume must be a non-negative number',
    })
  }
  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return res.status(400).json({
      error: 'thresholdPct must be a positive number',
    })
  }
  const interval = String(req.query.interval ?? '5m')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }
  const spikeDirections = String(req.query.spikeDirections ?? 'up').toLowerCase()
  if (!['up', 'down', 'both'].includes(spikeDirections)) {
    return res.status(400).json({
      error: 'spikeDirections must be up, down, or both',
    })
  }
  try {
    const result = await computeFiveMinScreener(FUTURES_BASE, {
      candleCount,
      minQuoteVolume,
      thresholdPct,
      interval,
      spikeDirections,
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : '5m screener failed',
    })
  }
})

/** Zone-hedge ladder backtest (USDT-M klines, public). */
app.get('/api/binance/zone-hedge-backtest', async (req, res) => {
  const symbol = String(req.query.symbol ?? 'BTCUSDT').toUpperCase()
  const interval = String(req.query.interval ?? '1h')
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }
  const limit = Number.parseInt(String(req.query.limit ?? '500'), 10)
  if (!Number.isFinite(limit) || limit < 50 || limit > 1500) {
    return res.status(400).json({ error: 'limit must be between 50 and 1500' })
  }
  let marginsUsd
  const m = req.query.margins
  if (m != null && String(m).trim() !== '') {
    marginsUsd = String(m)
      .split(/[, ]+/)
      .map((x) => Number.parseFloat(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  }
  const leverage = Number.parseFloat(String(req.query.leverage ?? '20'))
  const maxSteps = Number.parseInt(String(req.query.maxSteps ?? '3'), 10)
  const tpPct = Number.parseFloat(String(req.query.tpPct ?? '10'))
  const adversePct = Number.parseFloat(String(req.query.adversePct ?? '10'))
  const feeBpsPerSide = Number.parseFloat(String(req.query.feeBpsPerSide ?? '4'))
  const slippageBps = Number.parseFloat(String(req.query.slippageBps ?? '2'))
  const maintenanceMarginRate = Number.parseFloat(String(req.query.maintenanceMarginRate ?? '0.004'))
  const mode = String(req.query.mode ?? 'longFirst').toLowerCase() === 'shortfirst'
    ? 'shortFirst'
    : 'longFirst'
  const startingEquity = Number.parseFloat(String(req.query.startingEquity ?? '10000'))

  try {
    const result = await computeZoneHedgeBacktest(FUTURES_BASE, {
      symbol,
      interval,
      limit,
      marginsUsd,
      leverage,
      maxSteps,
      tpPct,
      adversePct,
      feeBpsPerSide,
      slippageBps,
      maintenanceMarginRate,
      mode,
      startingEquity,
    })
    if (result.error) {
      return res.status(400).json({ error: result.error })
    }
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Zone hedge backtest failed',
    })
  }
})

app.get('/api/binance/closed-positions', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  let limit = Number.parseInt(String(req.query.limit ?? '1000'), 10)
  if (!Number.isFinite(limit) || limit < 1) limit = 1000
  limit = Math.min(limit, 1000)
  try {
    const signed = (path, params) =>
      signedFuturesJson(apiKey, apiSecret, path, params)
    const result = await computeClosedPositionPnl(signed, { limit })
    res.json({
      ...result,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    return sendBinanceRouteError(res, e)
  }
})
