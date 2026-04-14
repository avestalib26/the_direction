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
import {
  agent1SchedulerState,
  startAgent1ScanScheduler,
} from './agent1ScanScheduler.js'
import {
  AGENT1_INTERVAL_MS,
  AGENT1_SCAN_INTERVALS,
  clampScanSecondsBeforeClose,
} from './agent1ScanIntervals.js'

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
const SUPABASE_URL = String(process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

const AGENT1_DEFAULT_SETTINGS = Object.freeze({
  agentName: 'agent1',
  tradeSizeUsd: 1,
  leverage: 10,
  marginMode: 'cross',
  maxTpPct: 1.5,
  maxSlPct: 1.0,
  scanSecondsBeforeClose: 20,
  scanThresholdPct: 3,
  scanMinQuoteVolume: 0,
  scanMaxSymbols: 800,
  scanSpikeMetric: 'body',
  scanDirection: 'both',
  scanInterval: '5m',
  agentEnabled: true,
})

class BinanceApiError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.name = 'BinanceApiError'
    this.statusCode = statusCode
  }
}

class SupabaseConfigError extends Error {}

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
  const minNotionalFilter = row.filters?.find((f) => f?.filterType === 'MIN_NOTIONAL')
  const notionalFilter = row.filters?.find((f) => f?.filterType === 'NOTIONAL')
  const stepSize = toNum(lot?.stepSize) ?? 0.001
  const minQty = toNum(lot?.minQty) ?? stepSize
  const tickSize = toNum(priceFilter?.tickSize) ?? 0.01
  const minNotional =
    toNum(notionalFilter?.minNotional) ??
    toNum(minNotionalFilter?.notional) ??
    toNum(minNotionalFilter?.minNotional) ??
    0
  return {
    stepSize,
    minQty,
    tickSize,
    minNotional,
    orderTypes: Array.isArray(row.orderTypes) ? row.orderTypes : [],
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
  if (
    e instanceof BinanceApiError &&
    e.statusCode === 400 &&
    /position side does not match user's setting/i.test(String(e.message))
  ) {
    return res.status(400).json({
      code: 'BINANCE_POSITION_SIDE_MISMATCH',
      error:
        'Position mode mismatch on Binance Futures. Your account is likely in Hedge Mode, but the order was sent without the expected position side (LONG/SHORT), or your current mode expects ONE-WAY. Align your Binance position mode and order side settings, then try again.',
    })
  }
  if (
    e instanceof BinanceApiError &&
    e.statusCode === 400 &&
    /notional must be no smaller than/i.test(String(e.message))
  ) {
    return res.status(400).json({
      code: 'BINANCE_MIN_NOTIONAL',
      error:
        'Order rejected: minimum notional not met. Increase trade size or leverage so trade size × leverage satisfies Binance minimum notional for this symbol.',
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

function ensureSupabaseConfigured() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new SupabaseConfigError(
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server .env to use Agent 1 settings storage.',
    )
  }
}

async function supabaseRest(path, init = {}) {
  ensureSupabaseConfigured()
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...init.headers,
  }
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers,
  })
  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`Supabase invalid JSON (${res.status}): ${text.slice(0, 240)}`)
    }
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || text || `Supabase ${res.status}`
    throw new Error(`Supabase ${res.status}: ${msg}`)
  }
  return data
}

function parseAgent1Bool(v, defaultVal) {
  if (v == null) return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return defaultVal
}

function normalizeAgent1Settings(raw = {}) {
  const tradeSizeUsd = Number.parseFloat(String(raw.tradeSizeUsd ?? raw.trade_size_usd ?? AGENT1_DEFAULT_SETTINGS.tradeSizeUsd))
  const leverage = Number.parseInt(String(raw.leverage ?? AGENT1_DEFAULT_SETTINGS.leverage), 10)
  const marginMode = String(raw.marginMode ?? raw.margin_mode ?? AGENT1_DEFAULT_SETTINGS.marginMode)
    .trim()
    .toLowerCase()
  const maxTpPct = Number.parseFloat(String(raw.maxTpPct ?? raw.max_tp_pct ?? AGENT1_DEFAULT_SETTINGS.maxTpPct))
  const maxSlPct = Number.parseFloat(String(raw.maxSlPct ?? raw.max_sl_pct ?? AGENT1_DEFAULT_SETTINGS.maxSlPct))

  const scanIntervalRaw = String(
    raw.scanInterval ?? raw.scan_interval ?? AGENT1_DEFAULT_SETTINGS.scanInterval,
  ).trim()
  if (!AGENT1_SCAN_INTERVALS.has(scanIntervalRaw)) {
    throw new Error(
      `scanInterval must be one of: ${[...AGENT1_SCAN_INTERVALS].sort().join(', ')}`,
    )
  }
  const scanInterval = scanIntervalRaw
  const intervalMs = AGENT1_INTERVAL_MS[scanInterval] ?? AGENT1_INTERVAL_MS['5m']
  const scanSecondsBeforeClose = clampScanSecondsBeforeClose(
    raw.scanSecondsBeforeClose ?? raw.scan_seconds_before_close ?? AGENT1_DEFAULT_SETTINGS.scanSecondsBeforeClose,
    intervalMs,
  )
  const scanThresholdPct = Number.parseFloat(
    String(raw.scanThresholdPct ?? raw.scan_threshold_pct ?? AGENT1_DEFAULT_SETTINGS.scanThresholdPct),
  )
  const scanMinQuoteVolume = Number.parseFloat(
    String(raw.scanMinQuoteVolume ?? raw.scan_min_quote_volume ?? AGENT1_DEFAULT_SETTINGS.scanMinQuoteVolume),
  )
  const scanMaxSymbols = Number.parseInt(
    String(raw.scanMaxSymbols ?? raw.scan_max_symbols ?? AGENT1_DEFAULT_SETTINGS.scanMaxSymbols),
    10,
  )
  const scanSpikeMetric = String(raw.scanSpikeMetric ?? raw.scan_spike_metric ?? AGENT1_DEFAULT_SETTINGS.scanSpikeMetric)
    .trim()
    .toLowerCase()
  const scanDirection = String(raw.scanDirection ?? raw.scan_direction ?? AGENT1_DEFAULT_SETTINGS.scanDirection)
    .trim()
    .toLowerCase()
  const agentEnabledRaw = raw.agentEnabled ?? raw.agent_enabled
  const agentEnabled = parseAgent1Bool(
    agentEnabledRaw,
    AGENT1_DEFAULT_SETTINGS.agentEnabled,
  )

  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) {
    throw new Error('tradeSizeUsd must be a positive number')
  }
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) {
    throw new Error('leverage must be between 1 and 125')
  }
  if (marginMode !== 'cross' && marginMode !== 'isolated') {
    throw new Error("marginMode must be 'cross' or 'isolated'")
  }
  if (!Number.isFinite(maxTpPct) || maxTpPct <= 0) {
    throw new Error('maxTpPct must be a positive number')
  }
  if (!Number.isFinite(maxSlPct) || maxSlPct <= 0) {
    throw new Error('maxSlPct must be a positive number')
  }
  if (!Number.isFinite(scanThresholdPct) || scanThresholdPct <= 0) {
    throw new Error('scanThresholdPct must be a positive number')
  }
  if (!Number.isFinite(scanMinQuoteVolume) || scanMinQuoteVolume < 0) {
    throw new Error('scanMinQuoteVolume must be a non-negative number')
  }
  if (!Number.isFinite(scanMaxSymbols) || scanMaxSymbols < 1 || scanMaxSymbols > 800) {
    throw new Error('scanMaxSymbols must be between 1 and 800')
  }
  if (scanSpikeMetric !== 'body' && scanSpikeMetric !== 'wick') {
    throw new Error("scanSpikeMetric must be 'body' or 'wick'")
  }
  if (!['up', 'down', 'both'].includes(scanDirection)) {
    throw new Error("scanDirection must be 'up', 'down', or 'both'")
  }

  return {
    agentName: AGENT1_DEFAULT_SETTINGS.agentName,
    tradeSizeUsd,
    leverage,
    marginMode,
    maxTpPct,
    maxSlPct,
    scanSecondsBeforeClose,
    scanThresholdPct,
    scanMinQuoteVolume,
    scanMaxSymbols,
    scanSpikeMetric,
    scanDirection,
    scanInterval,
    agentEnabled,
  }
}

const AGENT1_SETTINGS_SELECT =
  'agent_name,trade_size_usd,leverage,margin_mode,max_tp_pct,max_sl_pct,updated_at,' +
  'scan_seconds_before_close,scan_threshold_pct,scan_min_quote_volume,scan_max_symbols,scan_spike_metric,scan_direction,scan_interval,agent_enabled'

async function readAgent1Settings() {
  const p =
    `/rest/v1/agent_settings?select=${AGENT1_SETTINGS_SELECT}` +
    '&agent_name=eq.agent1' +
    '&limit=1'
  const rows = await supabaseRest(p)
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ...AGENT1_DEFAULT_SETTINGS,
      updatedAt: null,
    }
  }
  const row = rows[0]
  const s = normalizeAgent1Settings(row)
  return {
    ...s,
    updatedAt: row.updated_at ?? null,
  }
}

async function upsertAgent1Settings(input) {
  const s = normalizeAgent1Settings(input)
  const body = {
    agent_name: s.agentName,
    trade_size_usd: s.tradeSizeUsd,
    leverage: s.leverage,
    margin_mode: s.marginMode,
    max_tp_pct: s.maxTpPct,
    max_sl_pct: s.maxSlPct,
    scan_seconds_before_close: s.scanSecondsBeforeClose,
    scan_threshold_pct: s.scanThresholdPct,
    scan_min_quote_volume: s.scanMinQuoteVolume,
    scan_max_symbols: s.scanMaxSymbols,
    scan_spike_metric: s.scanSpikeMetric,
    scan_direction: s.scanDirection,
    scan_interval: s.scanInterval,
    agent_enabled: s.agentEnabled,
  }
  const rows = await supabaseRest('/rest/v1/agent_settings?on_conflict=agent_name&select=*', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(body),
  })
  const row = Array.isArray(rows) && rows[0] ? rows[0] : body
  const out = normalizeAgent1Settings(row)
  return {
    ...out,
    updatedAt: row.updated_at ?? null,
  }
}

const SPIKE_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function persistAgent1ScanResult(scanResult) {
  const events = scanResult.spikeEventsChronological ?? []
  if (events.length === 0) {
    return { spikeCount: 0 }
  }
  const scanRunAt = new Date().toISOString()
  const volMap = new Map()
  for (const r of scanResult.rows ?? []) {
    if (r?.symbol != null && r.quoteVolume24h != null) {
      volMap.set(r.symbol, r.quoteVolume24h)
    }
  }
  const rows = events.map((ev) => ({
    candle_open_time_ms: ev.openTime,
    symbol: ev.symbol,
    direction: ev.direction,
    spike_pct: ev.spikePct,
    quote_volume_24h: volMap.get(ev.symbol) ?? null,
    scan_run_at: scanRunAt,
    trade_taken: false,
  }))
  await supabaseRest('/rest/v1/agent1_spikes?on_conflict=candle_open_time_ms,symbol,direction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
  return { spikeCount: events.length }
}

async function fetchPositionMode(apiKey, apiSecret) {
  const data = await signedFuturesJson(apiKey, apiSecret, '/fapi/v1/positionSide/dual', {})
  return Boolean(data?.dualSidePosition)
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

app.get('/api/agents/agent1/settings', async (_req, res) => {
  try {
    const settings = await readAgent1Settings()
    return res.json({ settings, fetchedAt: new Date().toISOString() })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load Agent 1 settings',
    })
  }
})

app.put('/api/agents/agent1/settings', async (req, res) => {
  try {
    const body = req.body ?? {}
    const current = await readAgent1Settings()
    const merged = { ...current, ...body }
    if (typeof body.agentEnabled !== 'boolean') {
      merged.agentEnabled = current.agentEnabled
    }
    if (typeof body.scanInterval !== 'string' && typeof body.scan_interval !== 'string') {
      merged.scanInterval = current.scanInterval
    }
    const { updatedAt: _u, ...forUpsert } = merged
    const settings = await upsertAgent1Settings(forUpsert)
    return res.json({ ok: true, settings, fetchedAt: new Date().toISOString() })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    if (e instanceof Error && /must be/i.test(e.message)) {
      return res.status(400).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to save Agent 1 settings',
    })
  }
})

app.patch('/api/agents/agent1/enabled', async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include enabled: boolean' })
    }
    const current = await readAgent1Settings()
    const { updatedAt: _upd, ...rest } = current
    const settings = await upsertAgent1Settings({
      ...rest,
      agentEnabled: req.body.enabled,
    })
    return res.json({ ok: true, settings, fetchedAt: new Date().toISOString() })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    if (e instanceof Error && /must be/i.test(e.message)) {
      return res.status(400).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to update Agent 1 enabled flag',
    })
  }
})

app.get('/api/agents/agent1/scan-status', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const st = agent1SchedulerState
    const settings = await readAgent1Settings()
    const enabled =
      Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) &&
      process.env.AGENT1_SCAN_SCHEDULER !== 'false'
    return res.json({
      schedulerEnabled: enabled,
      agentEnabled: settings.agentEnabled,
      scanInterval: settings.scanInterval,
      nextFireAt: st.nextFireAt,
      nextFireAtIso: st.nextFireAt != null ? new Date(st.nextFireAt).toISOString() : null,
      lastRunAt: st.lastRunAt,
      lastRunAtIso: st.lastRunAt != null ? new Date(st.lastRunAt).toISOString() : null,
      lastSpikeCount: st.lastSpikeCount,
      lastError: st.lastError,
      running: st.running,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'scan-status failed' })
  }
})

app.get('/api/agents/agent1/spikes', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const limitRaw = Number.parseInt(String(req.query.limit ?? '200'), 10)
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200))
    const rows = await supabaseRest(
      `/rest/v1/agent1_spikes?select=*&order=created_at.desc&limit=${limit}`,
    )
    return res.json({
      spikes: Array.isArray(rows) ? rows : [],
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load spikes',
    })
  }
})

app.patch('/api/agents/agent1/spikes/:id', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const id = String(req.params.id ?? '').trim()
    if (!SPIKE_ROW_UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid spike id' })
    }
    if (typeof req.body?.tradeTaken !== 'boolean') {
      return res.status(400).json({ error: 'Body must include tradeTaken: boolean' })
    }
    const rows = await supabaseRest(`/rest/v1/agent1_spikes?id=eq.${id}&select=*`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ trade_taken: req.body.tradeTaken }),
    })
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    if (!row) {
      return res.status(404).json({ error: 'Spike not found' })
    }
    return res.json({ ok: true, spike: row })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to update spike',
    })
  }
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
  const verboseDebug = req.body?.debug !== false
  const debug = {
    inputs: { symbol, side, tradeSizeUsd, leverage, tpPct, slPct },
    timeline: [],
  }
  const addDebug = (step, data = {}) => {
    if (!verboseDebug) return
    debug.timeline.push({
      at: new Date().toISOString(),
      step,
      ...data,
    })
  }
  const errInfo = (e) => ({
    name: e instanceof Error ? e.name : 'Error',
    message: e instanceof Error ? e.message : String(e ?? 'Unknown error'),
    statusCode: e instanceof BinanceApiError ? e.statusCode : null,
  })

  if (!Number.isFinite(tpPct) || tpPct <= 0) {
    return res.status(400).json({ error: 'tpPct must be a positive number' })
  }
  if (!Number.isFinite(slPct) || slPct <= 0) {
    return res.status(400).json({ error: 'slPct must be a positive number' })
  }

  try {
    addDebug('start')
    const spec = await getSymbolSpec(symbol)
    addDebug('symbol_spec_loaded', {
      stepSize: spec.stepSize,
      minQty: spec.minQty,
      tickSize: spec.tickSize,
      minNotional: spec.minNotional,
      supportedOrderTypes: spec.orderTypes,
      quantityPrecision: spec.quantityPrecision,
      pricePrecision: spec.pricePrecision,
    })
    const isHedgeMode = await fetchPositionMode(apiKey, apiSecret)
    const entryPositionSide = side === 'BUY' ? 'LONG' : 'SHORT'
    addDebug('position_mode', {
      positionMode: isHedgeMode ? 'HEDGE' : 'ONE_WAY',
      positionSide: isHedgeMode ? entryPositionSide : 'BOTH',
    })

    await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/leverage', {
      symbol,
      leverage,
    })
    addDebug('leverage_set', { leverage })

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
    addDebug('mark_price_loaded', { markPrice })

    const effectiveNotionalUsd = tradeSizeUsd * leverage
    addDebug('notional_computed', { effectiveNotionalUsd })
    if (spec.minNotional > 0 && effectiveNotionalUsd < spec.minNotional) {
      return res.status(400).json({
        code: 'BINANCE_MIN_NOTIONAL',
        error:
          `Order notional too small for ${symbol}. Required min notional is ${spec.minNotional} USDT. ` +
          `Current trade size × leverage = ${effectiveNotionalUsd.toFixed(4)} USDT.`,
        debug: verboseDebug
          ? { ...debug, failure: { step: 'min_notional_check', required: spec.minNotional, current: effectiveNotionalUsd } }
          : undefined,
      })
    }
    const rawQty = effectiveNotionalUsd / markPrice
    const qty = quantizeToStep(rawQty, spec.stepSize, 'floor')
    addDebug('quantity_computed', { rawQty, roundedQty: qty })
    if (!Number.isFinite(qty) || qty <= 0 || qty < spec.minQty) {
      return res.status(400).json({
        error: `tradeSizeUsd × leverage is too small for ${symbol}. Minimum quantity is ${spec.minQty}.`,
        debug: verboseDebug
          ? { ...debug, failure: { step: 'quantity_check', minQty: spec.minQty, roundedQty: qty } }
          : undefined,
      })
    }
    const quantity = fmtByStep(qty, spec.stepSize, spec.quantityPrecision)

    const entryOrderParams = {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    }
    if (isHedgeMode) {
      entryOrderParams.positionSide = entryPositionSide
    }
    addDebug('entry_order_request', { params: entryOrderParams })
    const entryOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/order', entryOrderParams)
    addDebug('entry_order_response', {
      orderId: entryOrder?.orderId ?? null,
      status: entryOrder?.status ?? null,
      avgPrice: entryOrder?.avgPrice ?? null,
      executedQty: entryOrder?.executedQty ?? null,
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
    addDebug('tp_sl_computed', { tpPrice, slPrice, tpPriceRaw, slPriceRaw })

    let tpOrder = null
    let slOrder = null
    const warnings = []
    const tpParams = {
      algoType: 'CONDITIONAL',
      symbol,
      side: exitSide,
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: tpPrice,
      workingType: 'MARK_PRICE',
      priceProtect: 'true',
      closePosition: 'true',
      newOrderRespType: 'RESULT',
    }
    const slParams = {
      algoType: 'CONDITIONAL',
      symbol,
      side: exitSide,
      type: 'STOP_MARKET',
      triggerPrice: slPrice,
      workingType: 'MARK_PRICE',
      priceProtect: 'true',
      closePosition: 'true',
      newOrderRespType: 'RESULT',
    }
    if (isHedgeMode) {
      tpParams.positionSide = entryPositionSide
      slParams.positionSide = entryPositionSide
    }
    addDebug('protective_order_requests', { tpParams, slParams })
    try {
      tpOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/algoOrder', tpParams)
      addDebug('tp_order_response', {
        algoId: tpOrder?.algoId ?? null,
        algoStatus: tpOrder?.algoStatus ?? null,
      })
    } catch (e) {
      warnings.push(`TP order failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
      addDebug('tp_order_error', errInfo(e))
    }
    try {
      slOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/algoOrder', slParams)
      addDebug('sl_order_response', {
        algoId: slOrder?.algoId ?? null,
        algoStatus: slOrder?.algoStatus ?? null,
      })
    } catch (e) {
      warnings.push(`SL order failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
      addDebug('sl_order_error', errInfo(e))
    }
    addDebug('finish', { protectionPlaced: Boolean(tpOrder && slOrder), warningsCount: warnings.length })

    return res.json({
      ok: true,
      symbol,
      side,
      positionMode: isHedgeMode ? 'HEDGE' : 'ONE_WAY',
      positionSide: isHedgeMode ? entryPositionSide : 'BOTH',
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
      protectionPlaced: Boolean(tpOrder && slOrder),
      supportedOrderTypes: spec.orderTypes,
      warnings,
      debug: verboseDebug ? debug : undefined,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    addDebug('fatal_error', errInfo(e))
    if (verboseDebug) {
      if (e instanceof BinanceApiError && e.statusCode >= 400 && e.statusCode < 500) {
        return res.status(e.statusCode).json({
          error: e.message,
          debug,
        })
      }
      if (e instanceof BinanceApiError && e.statusCode === 451) {
        return res.status(451).json({
          code: 'BINANCE_GEO_BLOCKED',
          error:
            'Binance Futures API rejected this request because of server location (HTTP 451). ' +
            `Details: ${e.message}`,
          debug,
        })
      }
    }
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
  const spikeMetric = String(req.query.spikeMetric ?? 'body').toLowerCase()
  if (!['body', 'wick'].includes(spikeMetric)) {
    return res.status(400).json({
      error: 'spikeMetric must be body or wick',
    })
  }
  const maxSymbolsRaw = req.query.maxSymbols
  const maxSymbols =
    maxSymbolsRaw === undefined || maxSymbolsRaw === ''
      ? undefined
      : Number.parseInt(String(maxSymbolsRaw), 10)
  if (maxSymbols !== undefined && (!Number.isFinite(maxSymbols) || maxSymbols < 1)) {
    return res.status(400).json({
      error: 'maxSymbols must be a positive integer (optional, cap 800)',
    })
  }
  try {
    const t0 = Date.now()
    const result = await computeFiveMinScreener(FUTURES_BASE, {
      candleCount,
      minQuoteVolume,
      thresholdPct,
      interval,
      spikeDirections,
      spikeMetric,
      maxSymbols,
    })
    res.json({
      ...result,
      elapsedMs: Date.now() - t0,
    })
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

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && process.env.AGENT1_SCAN_SCHEDULER !== 'false') {
  startAgent1ScanScheduler({
    futuresBase: FUTURES_BASE,
    isEnabled: () => true,
    readSettings: readAgent1Settings,
    persistScan: persistAgent1ScanResult,
    logger: console,
  })
}
