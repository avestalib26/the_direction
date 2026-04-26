import crypto from 'node:crypto'
import os from 'node:os'
import cors from 'cors'
import express from 'express'
import {
  ALLOWED_INTERVALS,
  computeMarketBreadth,
} from './breadth.js'
import { computeMarketRegimeBreadth } from './marketRegimeBreadth.js'
import { computeDailyMarketOverview } from './dailyMarketOverview.js'
import { computeClosedPositionPnl } from './closedPositions.js'
import { computeFutures24hVolumes } from './volumeScreener.js'
import { computeFiveMinScreener } from './fiveMinScreener.js'
import { mountHftRaveSse } from './hftRaveSse.js'
import { runGptBacktest } from './gptBacktest.js'
import { computeSpikeFilter, computeSpikeFilterUniverse } from './spikeFilterBacktest.js'
import { DCA_BACKTEST_INTERVALS, runDailyDcaBacktest } from './dailyDcaBacktest.js'
import {
  computeSpikeTpSlBacktest,
  parseSpikeTpSlUtcRange,
} from './spikeTpSlBacktest.js'
import { runLocalCandlesFullSync, scanLocalCandlesStatus } from './localCandleStore.js'
import { binanceFuturesPublicHeaders } from './binancePublicHeaders.js'
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
  agent3SchedulerState,
  startAgent3ScanScheduler,
} from './agent3ScanScheduler.js'
import { normalizeBinanceAccountId, resolveBinanceCredentials } from './binanceCredentials.js'
import {
  assertValidShadowSimBases,
  defaultShadowSimLongBase,
  defaultShadowSimShortBase,
  mergeShadowSimConfigPatch,
  shadowSimBasesToDbRow,
  shadowSimRowToBases,
  SHADOW_SIM_CONFIG_KEY,
} from './agent1ShadowSimConfig.js'
import {
  getAgent1ShadowSimulationPaused,
  getAgent1ShadowSnapshot,
  patchShadowSimRuntimeOverrides,
  setAgent1ShadowSimulationPaused,
  setAgent1ShadowSnapshot,
  startAgent1ShadowScheduler,
} from './agent1ShadowScheduler.js'
import {
  AGENT1_INTERVAL_MS,
  AGENT1_SCAN_INTERVALS,
  clampScanSecondsBeforeClose,
} from './agent1ScanIntervals.js'
import {
  agent2ExecutionState,
  agent2SchedulerState,
  initAgent2Context,
  listAgent2ExecutionLogRows,
  readAgent2Settings,
  runAgent2ExecutionTick,
  runAgent2ScanOnce,
  startAgent2ScanScheduler,
  upsertAgent2Settings,
} from './agent2Service.js'

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
const AGENT1_EXECUTION_ENABLED = process.env.AGENT1_EXECUTION_ENABLED !== 'false'
const AGENT1_EXECUTION_POLL_MS = Math.min(
  120_000,
  Math.max(5_000, Number.parseInt(String(process.env.AGENT1_EXECUTION_POLL_MS ?? '15000'), 10) || 15_000),
)
const AGENT1_EXECUTION_MAX_SPIKES_PER_TICK = Math.min(
  50,
  Math.max(1, Number.parseInt(String(process.env.AGENT1_EXECUTION_MAX_SPIKES_PER_TICK ?? '8'), 10) || 8),
)
const AGENT1_EXECUTION_MAX_LOGS = 200
const AGENT1_EXECUTION_SINGLE_WRITER = process.env.AGENT1_EXECUTION_SINGLE_WRITER !== 'false'
const AGENT1_EXECUTION_LOCK_NAME = String(process.env.AGENT1_EXECUTION_LOCK_NAME ?? 'agent1_execution_main').trim()
const AGENT1_EXECUTION_LOCK_TTL_SEC = Math.min(
  600,
  Math.max(15, Number.parseInt(String(process.env.AGENT1_EXECUTION_LOCK_TTL_SEC ?? '90'), 10) || 90),
)
const AGENT1_EXECUTION_WRITER_ID = String(
  process.env.AGENT1_EXECUTION_WRITER_ID ?? `${os.hostname?.() ?? 'host'}:${process.pid}`,
).replace(/[^a-zA-Z0-9._:-]/g, '_')
const AGENT3_EXECUTION_ENABLED = process.env.AGENT3_EXECUTION_ENABLED !== 'false'
const AGENT3_EXECUTION_POLL_MS = Math.min(
  120_000,
  Math.max(5_000, Number.parseInt(String(process.env.AGENT3_EXECUTION_POLL_MS ?? '15000'), 10) || 15_000),
)
const AGENT3_EXECUTION_MAX_SPIKES_PER_TICK = Math.min(
  50,
  Math.max(1, Number.parseInt(String(process.env.AGENT3_EXECUTION_MAX_SPIKES_PER_TICK ?? '8'), 10) || 8),
)
const AGENT3_EXECUTION_MAX_LOGS = 200
const AGENT3_EXECUTION_SINGLE_WRITER = process.env.AGENT3_EXECUTION_SINGLE_WRITER !== 'false'
const AGENT3_EXECUTION_LOCK_NAME = String(process.env.AGENT3_EXECUTION_LOCK_NAME ?? 'agent3_execution_main').trim()
const AGENT3_EXECUTION_LOCK_TTL_SEC = Math.min(
  600,
  Math.max(15, Number.parseInt(String(process.env.AGENT3_EXECUTION_LOCK_TTL_SEC ?? '90'), 10) || 90),
)
const AGENT3_EXECUTION_WRITER_ID = String(
  process.env.AGENT3_EXECUTION_WRITER_ID ?? `${os.hostname?.() ?? 'host'}:${process.pid}:a3`,
).replace(/[^a-zA-Z0-9._:-]/g, '_')
const AGENT2_EXECUTION_ENABLED = process.env.AGENT2_EXECUTION_ENABLED !== 'false'
const AGENT2_EXECUTION_POLL_MS = Math.min(
  120_000,
  Math.max(5_000, Number.parseInt(String(process.env.AGENT2_EXECUTION_POLL_MS ?? '15000'), 10) || 15_000),
)
/** Max ms after a scan completes to open a trade; stale cutoff uses interval + (this − scanSecondsBeforeClose). */
const SPIKE_EXECUTION_TRADE_WINDOW_MS = Math.max(
  5_000,
  Number.parseInt(String(process.env.SPIKE_EXECUTION_TRADE_WINDOW_MS ?? '60000'), 10) || 60_000,
)
const AGENT1_SHADOW_SINGLE_WRITER = process.env.AGENT1_SHADOW_SINGLE_WRITER !== 'false'
const AGENT1_SHADOW_LOCK_NAME = String(process.env.AGENT1_SHADOW_LOCK_NAME ?? 'agent1_shadow_main').trim()
const AGENT1_SHADOW_SNAPSHOT_KEY = 'main'
const AGENT1_SHADOW_LOCK_TTL_SEC = Math.min(
  600,
  Math.max(15, Number.parseInt(String(process.env.AGENT1_SHADOW_LOCK_TTL_SEC ?? '90'), 10) || 90),
)
const AGENT1_SHADOW_WRITER_ID = String(
  process.env.AGENT1_SHADOW_WRITER_ID ?? `${os.hostname?.() ?? 'host'}:${process.pid}`,
).replace(/[^a-zA-Z0-9._:-]/g, '_')

function envFallbackMinAvailableWalletPct() {
  const p = Number.parseInt(String(process.env.FUTURES_MIN_AVAILABLE_WALLET_PCT ?? '30').trim(), 10)
  return Number.isFinite(p) && p >= 0 && p <= 100 ? p : 30
}

const AGENT1_DEFAULT_SETTINGS = Object.freeze({
  agentName: 'agent1',
  tradeSizeUsd: 1,
  tradeSizeWalletPct: 0,
  leverage: 10,
  marginMode: 'cross',
  maxTpPct: 1.5,
  maxSlPct: 1.0,
  maxOpenPositions: 30,
  scanSecondsBeforeClose: 20,
  scanThresholdPct: 3,
  scanMinQuoteVolume: 0,
  scanMaxSymbols: 800,
  scanSpikeMetric: 'body',
  scanDirection: 'both',
  scanInterval: '5m',
  agentEnabled: true,
  emaGateEnabled: true,
  binanceAccount: 'master',
  minAvailableWalletPct: envFallbackMinAvailableWalletPct(),
})

const AGENT3_DEFAULT_SETTINGS = Object.freeze({
  agentName: 'agent3',
  tradeSizeUsd: 1,
  tradeSizeWalletPct: 0,
  leverage: 10,
  marginMode: 'cross',
  maxTpPct: 2,
  maxSlPct: 1.0,
  maxOpenPositions: 30,
  scanSecondsBeforeClose: 20,
  scanThresholdPct: 3,
  scanMinQuoteVolume: 0,
  scanMaxSymbols: 800,
  scanSpikeMetric: 'body',
  scanDirection: 'down',
  scanInterval: '5m',
  agentEnabled: false,
  emaGateEnabled: false,
  binanceAccount: 'master',
  minAvailableWalletPct: envFallbackMinAvailableWalletPct(),
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
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k] ?? ''))}`)
    .join('&')
  const signature = signQuery(apiSecret, qs)
  return `${FUTURES_BASE}${path}?${qs}&signature=${encodeURIComponent(signature)}`
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
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k] ?? ''))}`)
    .join('&')
  const signature = signQuery(apiSecret, qs)
  return `${SPOT_BASE}${path}?${qs}&signature=${encodeURIComponent(signature)}`
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

async function signedFuturesJsonDelete(apiKey, apiSecret, path, params) {
  const url = await signedFuturesUrl(path, apiSecret, params)
  await acquireFuturesRestWeight(futuresSignedPathWeight(path))
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new BinanceApiError(
      `Invalid JSON from Binance DELETE (${res.status}): ${text.slice(0, 240)}`,
      res.status,
    )
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    if (res.status === 400 && /timestamp|recvWindow/i.test(String(msg))) {
      const retryUrl = await signedFuturesUrl(path, apiSecret, params, true)
      await acquireFuturesRestWeight(futuresSignedPathWeight(path))
      const retryRes = await fetch(retryUrl, {
        method: 'DELETE',
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

function sleep(ms) {
  const n = Math.min(30_000, Math.max(0, Math.floor(Number(ms) || 0)))
  return new Promise((resolve) => setTimeout(resolve, n))
}

/**
 * Ensure TP/SL sit on the correct side of entry after tick rounding (Binance rejects "would trigger immediately" / invalid bracket).
 */
function enforceExitBracketAgainstEntry({ side, entryPrice, tpPriceNum, slPriceNum, tickSize }) {
  const tick = tickSize
  let tp = tpPriceNum
  let sl = slPriceNum
  let adjusted = false
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(tick) || tick <= 0) {
    return { tpPriceNum: tp, slPriceNum: sl, adjusted: false, ok: true }
  }
  if (side === 'BUY') {
    for (let i = 0; i < 64 && tp <= entryPrice; i++) {
      tp = quantizeToStep(tp + tick, tick, 'ceil')
      adjusted = true
    }
    for (let i = 0; i < 64 && sl >= entryPrice; i++) {
      const next = quantizeToStep(sl - tick, tick, 'floor')
      if (next >= sl) break
      sl = next
      adjusted = true
    }
    const ok = tp > entryPrice && sl < entryPrice && sl > 0
    return { tpPriceNum: tp, slPriceNum: sl, adjusted, ok }
  }
  for (let i = 0; i < 64 && tp >= entryPrice; i++) {
    const next = quantizeToStep(tp - tick, tick, 'floor')
    if (next <= 0 || next >= tp) break
    tp = next
    adjusted = true
  }
  for (let i = 0; i < 64 && sl <= entryPrice; i++) {
    sl = quantizeToStep(sl + tick, tick, 'ceil')
    adjusted = true
  }
  const ok = tp < entryPrice && sl > entryPrice
  return { tpPriceNum: tp, slPriceNum: sl, adjusted, ok }
}

async function closeFuturesMarketReduceOnlyBestEffort({
  apiKey,
  apiSecret,
  symbol,
  entrySide,
  entryPositionSide,
  isHedgeMode,
  spec,
  fallbackQuantityStr,
}) {
  const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY'
  const risk = await fetchPositionRisk(apiKey, apiSecret)
  let absAmt = 0
  if (Array.isArray(risk)) {
    for (const p of risk) {
      if (String(p?.symbol ?? '') !== symbol) continue
      const amt = Number.parseFloat(String(p?.positionAmt ?? '0'))
      if (!Number.isFinite(amt) || Math.abs(amt) <= 0) continue
      if (isHedgeMode && String(p?.positionSide ?? '') !== entryPositionSide) continue
      absAmt = Math.abs(amt)
      break
    }
  }
  if (!(absAmt > 0)) {
    const fb = Number.parseFloat(String(fallbackQuantityStr ?? ''))
    if (Number.isFinite(fb) && fb > 0) absAmt = fb
  }
  let q = quantizeToStep(absAmt, spec.stepSize, 'floor')
  if (!Number.isFinite(q) || q <= 0 || q < spec.minQty) {
    throw new Error('reduceOnly close: could not resolve position quantity')
  }
  const quantity = fmtByStep(q, spec.stepSize, spec.quantityPrecision)
  const params = {
    symbol,
    side: exitSide,
    type: 'MARKET',
    quantity,
    reduceOnly: 'true',
    newOrderRespType: 'RESULT',
  }
  if (isHedgeMode) params.positionSide = entryPositionSide
  return signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/order', params)
}

/**
 * Digits after decimal for Binance step/tick. Handles scientific notation (e.g. 1e-7)
 * so fmtByStep does not use toFixed(0) on sub-cent prices.
 */
function decimalPlaces(step) {
  if (!Number.isFinite(step) || step <= 0) return 0
  const s = String(step).trim()
  const lower = s.toLowerCase()
  if (lower.includes('e')) {
    const m = lower.match(/e([+-]?\d+)$/i)
    if (m) {
      const exp = Number.parseInt(m[1], 10)
      if (exp < 0) return Math.min(12, -exp)
    }
  }
  if (s.includes('.')) {
    const frac = s.split('.')[1]?.replace(/0+$/, '') ?? ''
    if (frac.length > 0) return Math.min(12, frac.length)
  }
  if (step < 1) {
    return Math.min(12, Math.max(1, Math.round(-Math.log10(step))))
  }
  return 0
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
  let d = decimalPlaces(step)
  if (d <= 0 && Number.isFinite(precisionCap) && precisionCap > 0) {
    d = Math.min(12, Math.floor(precisionCap))
  }
  let use = Math.max(0, d)
  if (Number.isFinite(precisionCap) && precisionCap >= 0) {
    use = Math.min(use, Math.floor(precisionCap))
  }
  if (use <= 0) {
    if (precisionCap === 0) {
      return value.toFixed(0)
    }
    use = Math.min(12, 8)
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

/**
 * Detect PostgREST "column missing" errors so we do not strip fields on unrelated failures
 * (e.g. check constraint messages still mention binance_account in the constraint name).
 */
function supabaseErrorIndicatesMissingColumn(message, columnSnippet) {
  const m = String(message).toLowerCase()
  const c = String(columnSnippet).toLowerCase()
  if (!m.includes(c)) return false
  if (m.includes('does not exist')) return true
  if (m.includes('could not find') && m.includes('column')) return true
  if (m.includes('unknown column')) return true
  return false
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

let agent1ShadowLeaseOwner = false
let agent1ShadowLastDbHydrateAt = 0
let agent1ExecutionLeaseOwner = false
let agent3ExecutionLeaseOwner = false
/** Last successful Agent 3 settings read included `binance_account` in the SELECT (column exists in DB). */
let agent3BinanceAccountColumnReadable = true
/** Same for Agent 1 (see readAgent1Settings / upsertAgent1Settings). */
let agent1BinanceAccountColumnReadable = true

function canUseShadowDbCoordination() {
  return AGENT1_SHADOW_SINGLE_WRITER && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
}

function canUseExecutionDbCoordination() {
  return AGENT1_EXECUTION_SINGLE_WRITER && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
}

function canUseAgent3ExecutionDbCoordination() {
  return AGENT3_EXECUTION_SINGLE_WRITER && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
}

async function tryAcquireRuntimeExecutionLease(lockName, writerId, ttlSec, useCoordination) {
  if (!useCoordination) return true
  const nowIso = new Date().toISOString()
  const leaseIso = new Date(Date.now() + ttlSec * 1000).toISOString()
  const lockNameEnc = encodeURIComponent(lockName)
  const orExpr = `(owner_id.eq.${writerId},lease_until.lt.${nowIso})`
  const orEnc = encodeURIComponent(orExpr)

  const rows = await supabaseRest(
    `/rest/v1/agent_runtime_locks?lock_name=eq.${lockNameEnc}&or=${orEnc}&select=*`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        owner_id: writerId,
        lease_until: leaseIso,
      }),
    },
  )
  if (Array.isArray(rows) && rows.length > 0) return true

  try {
    const created = await supabaseRest('/rest/v1/agent_runtime_locks?select=*', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        lock_name: lockName,
        owner_id: writerId,
        lease_until: leaseIso,
      }),
    })
    return Array.isArray(created) && created.length > 0
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('duplicate key')) return false
    throw e
  }
}

async function tryAcquireAgent1ExecutionLease() {
  return tryAcquireRuntimeExecutionLease(
    AGENT1_EXECUTION_LOCK_NAME,
    AGENT1_EXECUTION_WRITER_ID,
    AGENT1_EXECUTION_LOCK_TTL_SEC,
    canUseExecutionDbCoordination(),
  )
}

async function tryAcquireAgent3ExecutionLease() {
  return tryAcquireRuntimeExecutionLease(
    AGENT3_EXECUTION_LOCK_NAME,
    AGENT3_EXECUTION_WRITER_ID,
    AGENT3_EXECUTION_LOCK_TTL_SEC,
    canUseAgent3ExecutionDbCoordination(),
  )
}

async function tryAcquireAgent1ShadowLease() {
  if (!canUseShadowDbCoordination()) return true
  const nowIso = new Date().toISOString()
  const leaseIso = new Date(Date.now() + AGENT1_SHADOW_LOCK_TTL_SEC * 1000).toISOString()
  const lockNameEnc = encodeURIComponent(AGENT1_SHADOW_LOCK_NAME)
  const orExpr = `(owner_id.eq.${AGENT1_SHADOW_WRITER_ID},lease_until.lt.${nowIso})`
  const orEnc = encodeURIComponent(orExpr)

  const rows = await supabaseRest(
    `/rest/v1/agent_runtime_locks?lock_name=eq.${lockNameEnc}&or=${orEnc}&select=*`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        owner_id: AGENT1_SHADOW_WRITER_ID,
        lease_until: leaseIso,
      }),
    },
  )
  if (Array.isArray(rows) && rows.length > 0) return true

  try {
    const created = await supabaseRest('/rest/v1/agent_runtime_locks?select=*', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        lock_name: AGENT1_SHADOW_LOCK_NAME,
        owner_id: AGENT1_SHADOW_WRITER_ID,
        lease_until: leaseIso,
      }),
    })
    return Array.isArray(created) && created.length > 0
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('duplicate key')) return false
    throw e
  }
}

async function persistAgent1ShadowSnapshot(snapshot) {
  if (!canUseShadowDbCoordination()) return
  await supabaseRest('/rest/v1/agent1_shadow_snapshot?on_conflict=snapshot_key&select=*', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      snapshot_key: AGENT1_SHADOW_SNAPSHOT_KEY,
      writer_id: AGENT1_SHADOW_WRITER_ID,
      updated_at: new Date().toISOString(),
      payload: snapshot,
    }),
  })
}

async function loadAgent1ShadowSnapshotFromDb() {
  if (!canUseShadowDbCoordination()) return null
  const keyEnc = encodeURIComponent(AGENT1_SHADOW_SNAPSHOT_KEY)
  const rows = await supabaseRest(
    `/rest/v1/agent1_shadow_snapshot?select=payload,updated_at,writer_id&snapshot_key=eq.${keyEnc}&limit=1`,
  )
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null
  if (!row?.payload || typeof row.payload !== 'object') return null
  const payload = {
    ...row.payload,
    updatedAt: row.payload.updatedAt ?? row.updated_at ?? null,
    writerId: row.writer_id ?? null,
  }
  return payload
}

const SHADOW_SIM_CONFIG_CACHE_MS = 5000
let shadowSimConfigCache = { expires: 0, data: null }

function defaultShadowSimConfigPack() {
  return {
    long: defaultShadowSimLongBase(),
    short: defaultShadowSimShortBase(),
    updatedAt: null,
    fromDb: false,
    configKey: SHADOW_SIM_CONFIG_KEY,
  }
}

function bustShadowSimConfigCache() {
  shadowSimConfigCache = { expires: 0, data: null }
}

async function loadAgent1ShadowSimConfigFromDbCached({ force = false } = {}) {
  const now = Date.now()
  if (!force && shadowSimConfigCache.data && now < shadowSimConfigCache.expires) {
    return shadowSimConfigCache.data
  }
  const fallback = defaultShadowSimConfigPack()
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    shadowSimConfigCache = { expires: now + SHADOW_SIM_CONFIG_CACHE_MS, data: fallback }
    return fallback
  }
  try {
    const keyEnc = encodeURIComponent(SHADOW_SIM_CONFIG_KEY)
    const rows = await supabaseRest(
      `/rest/v1/agent1_shadow_sim_config?select=*&config_key=eq.${keyEnc}&limit=1`,
    )
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    if (!row) {
      shadowSimConfigCache = { expires: now + SHADOW_SIM_CONFIG_CACHE_MS, data: fallback }
      return fallback
    }
    const { long, short } = shadowSimRowToBases(row)
    const data = {
      long,
      short,
      updatedAt: row.updated_at ?? null,
      fromDb: true,
      configKey: row.config_key ?? SHADOW_SIM_CONFIG_KEY,
    }
    shadowSimConfigCache = { expires: now + SHADOW_SIM_CONFIG_CACHE_MS, data }
    return data
  } catch (e) {
    console.error('[agent1-shadow-sim-config] load failed', e)
    shadowSimConfigCache = { expires: now + SHADOW_SIM_CONFIG_CACHE_MS, data: fallback }
    return fallback
  }
}

/** Applies `simulationPaused` from shared DB so every API instance matches the latest PATCH (lease owner included). */
async function syncAgent1ShadowPausedFromDb() {
  if (!canUseShadowDbCoordination()) return
  try {
    const snap = await loadAgent1ShadowSnapshotFromDb()
    if (snap && typeof snap.simulationPaused === 'boolean') {
      setAgent1ShadowSimulationPaused(snap.simulationPaused)
    }
  } catch {
    // ignore
  }
}

async function maybeHydrateAgent1ShadowSnapshot(force = false) {
  if (!canUseShadowDbCoordination()) return
  const now = Date.now()
  if (!force && now - agent1ShadowLastDbHydrateAt < 5000) return
  agent1ShadowLastDbHydrateAt = now
  try {
    const snap = await loadAgent1ShadowSnapshotFromDb()
    if (snap) {
      setAgent1ShadowSnapshot(snap)
      if (typeof snap.simulationPaused === 'boolean') {
        setAgent1ShadowSimulationPaused(snap.simulationPaused)
      }
    }
  } catch {
    // keep local snapshot
  }
}

function parseAgent1Bool(v, defaultVal) {
  if (v == null) return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return defaultVal
}

function normalizeAgentSettingsWithDefaults(raw = {}, defaults) {
  const tradeSizeUsd = Number.parseFloat(String(raw.tradeSizeUsd ?? raw.trade_size_usd ?? defaults.tradeSizeUsd))
  const tradeSizeWalletPct = Number.parseFloat(
    String(raw.tradeSizeWalletPct ?? raw.trade_size_wallet_pct ?? defaults.tradeSizeWalletPct),
  )
  const leverage = Number.parseInt(String(raw.leverage ?? defaults.leverage), 10)
  const marginMode = String(raw.marginMode ?? raw.margin_mode ?? defaults.marginMode)
    .trim()
    .toLowerCase()
  const maxTpPct = Number.parseFloat(String(raw.maxTpPct ?? raw.max_tp_pct ?? defaults.maxTpPct))
  const maxSlPct = Number.parseFloat(String(raw.maxSlPct ?? raw.max_sl_pct ?? defaults.maxSlPct))
  const maxOpenPositions = Number.parseInt(
    String(raw.maxOpenPositions ?? raw.max_open_positions ?? defaults.maxOpenPositions),
    10,
  )

  const scanIntervalRaw = String(raw.scanInterval ?? raw.scan_interval ?? defaults.scanInterval).trim()
  if (!AGENT1_SCAN_INTERVALS.has(scanIntervalRaw)) {
    throw new Error(
      `scanInterval must be one of: ${[...AGENT1_SCAN_INTERVALS].sort().join(', ')}`,
    )
  }
  const scanInterval = scanIntervalRaw
  const intervalMs = AGENT1_INTERVAL_MS[scanInterval] ?? AGENT1_INTERVAL_MS['5m']
  const scanSecondsBeforeClose = clampScanSecondsBeforeClose(
    raw.scanSecondsBeforeClose ?? raw.scan_seconds_before_close ?? defaults.scanSecondsBeforeClose,
    intervalMs,
  )
  const scanThresholdPct = Number.parseFloat(
    String(raw.scanThresholdPct ?? raw.scan_threshold_pct ?? defaults.scanThresholdPct),
  )
  const scanMinQuoteVolume = Number.parseFloat(
    String(raw.scanMinQuoteVolume ?? raw.scan_min_quote_volume ?? defaults.scanMinQuoteVolume),
  )
  const scanMaxSymbols = Number.parseInt(
    String(raw.scanMaxSymbols ?? raw.scan_max_symbols ?? defaults.scanMaxSymbols),
    10,
  )
  const scanSpikeMetric = String(raw.scanSpikeMetric ?? raw.scan_spike_metric ?? defaults.scanSpikeMetric)
    .trim()
    .toLowerCase()
  const scanDirection = String(raw.scanDirection ?? raw.scan_direction ?? defaults.scanDirection)
    .trim()
    .toLowerCase()
  const agentEnabledRaw = raw.agentEnabled ?? raw.agent_enabled
  const agentEnabled = parseAgent1Bool(agentEnabledRaw, defaults.agentEnabled)
  const emaGateEnabledRaw = raw.emaGateEnabled ?? raw.ema_gate_enabled
  const emaGateEnabled = parseAgent1Bool(emaGateEnabledRaw, defaults.emaGateEnabled)
  const binanceAccount =
    normalizeBinanceAccountId(raw.binanceAccount ?? raw.binance_account ?? defaults.binanceAccount) ?? 'master'

  const rawMinWalletPct = raw.min_available_wallet_pct ?? raw.minAvailableWalletPct
  let minAvailableWalletPct
  if (rawMinWalletPct === null || rawMinWalletPct === undefined || rawMinWalletPct === '') {
    minAvailableWalletPct = envFallbackMinAvailableWalletPct()
  } else {
    minAvailableWalletPct = Number.parseInt(String(rawMinWalletPct), 10)
  }
  if (!Number.isFinite(minAvailableWalletPct) || minAvailableWalletPct < 0 || minAvailableWalletPct > 100) {
    throw new Error('minAvailableWalletPct must be an integer from 0 to 100 (0 disables the wallet headroom check)')
  }

  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) {
    throw new Error('tradeSizeUsd must be a positive number')
  }
  if (!Number.isFinite(tradeSizeWalletPct) || tradeSizeWalletPct < 0 || tradeSizeWalletPct > 100) {
    throw new Error('tradeSizeWalletPct must be between 0 and 100')
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
  if (!Number.isFinite(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 300) {
    throw new Error('maxOpenPositions must be between 1 and 300')
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
    agentName: defaults.agentName,
    tradeSizeUsd,
    tradeSizeWalletPct,
    leverage,
    marginMode,
    maxTpPct,
    maxSlPct,
    maxOpenPositions,
    scanSecondsBeforeClose,
    scanThresholdPct,
    scanMinQuoteVolume,
    scanMaxSymbols,
    scanSpikeMetric,
    scanDirection,
    scanInterval,
    agentEnabled,
    emaGateEnabled,
    binanceAccount,
    minAvailableWalletPct,
  }
}

function normalizeAgent1Settings(raw = {}) {
  return normalizeAgentSettingsWithDefaults(raw, AGENT1_DEFAULT_SETTINGS)
}

function normalizeAgent3Settings(raw = {}) {
  return normalizeAgentSettingsWithDefaults(raw, AGENT3_DEFAULT_SETTINGS)
}

const AGENT1_SETTINGS_SELECT =
  'agent_name,trade_size_usd,trade_size_wallet_pct,leverage,margin_mode,max_tp_pct,max_sl_pct,max_open_positions,updated_at,' +
  'scan_seconds_before_close,scan_threshold_pct,scan_min_quote_volume,scan_max_symbols,scan_spike_metric,scan_direction,scan_interval,agent_enabled,ema_gate_enabled,binance_account,min_available_wallet_pct'
const AGENT1_SETTINGS_SELECT_LEGACY =
  'agent_name,trade_size_usd,leverage,margin_mode,max_tp_pct,max_sl_pct,updated_at,' +
  'scan_seconds_before_close,scan_threshold_pct,scan_min_quote_volume,scan_max_symbols,scan_spike_metric,scan_direction,scan_interval,agent_enabled,ema_gate_enabled'

const AGENT3_SETTINGS_SELECT =
  'agent_name,trade_size_usd,trade_size_wallet_pct,leverage,margin_mode,max_tp_pct,max_sl_pct,max_open_positions,updated_at,' +
  'scan_seconds_before_close,scan_threshold_pct,scan_min_quote_volume,scan_max_symbols,scan_spike_metric,scan_direction,scan_interval,agent_enabled,ema_gate_enabled,binance_account,min_available_wallet_pct'
/** Same shape as {@link AGENT1_SETTINGS_SELECT_LEGACY}: older DB rows may lack max_open_positions and newer wallet columns. */
const AGENT3_SETTINGS_SELECT_LEGACY =
  'agent_name,trade_size_usd,leverage,margin_mode,max_tp_pct,max_sl_pct,updated_at,' +
  'scan_seconds_before_close,scan_threshold_pct,scan_min_quote_volume,scan_max_symbols,scan_spike_metric,scan_direction,scan_interval,agent_enabled,ema_gate_enabled'

async function readAgent1Settings() {
  let select = AGENT1_SETTINGS_SELECT
  let rows
  for (;;) {
    const p =
      `/rest/v1/agent_settings?select=${select}` + '&agent_name=eq.agent1' + '&limit=1'
    try {
      rows = await supabaseRest(p)
      agent1BinanceAccountColumnReadable = select.includes('binance_account')
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/trade_size_wallet_pct/i.test(msg) && select.includes('trade_size_wallet_pct')) {
        select = select.replace(',trade_size_wallet_pct', '')
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'binance_account') &&
        select.includes('binance_account')
      ) {
        select = select.replace(',binance_account', '')
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'min_available_wallet_pct') &&
        select.includes('min_available_wallet_pct')
      ) {
        select = select.replace(',min_available_wallet_pct', '')
        continue
      }
      if (/max_open_positions/i.test(msg)) {
        const legacyPath =
          `/rest/v1/agent_settings?select=${AGENT1_SETTINGS_SELECT_LEGACY}` +
          '&agent_name=eq.agent1' +
          '&limit=1'
        rows = await supabaseRest(legacyPath)
        agent1BinanceAccountColumnReadable = false
        break
      }
      throw e
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ...normalizeAgent1Settings({}),
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

async function readAgent3Settings() {
  let select = AGENT3_SETTINGS_SELECT
  let rows
  for (;;) {
    const p =
      `/rest/v1/agent_settings?select=${select}` + '&agent_name=eq.agent3' + '&limit=1'
    try {
      rows = await supabaseRest(p)
      agent3BinanceAccountColumnReadable = select.includes('binance_account')
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/trade_size_wallet_pct/i.test(msg) && select.includes('trade_size_wallet_pct')) {
        select = select.replace(',trade_size_wallet_pct', '')
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'binance_account') &&
        select.includes('binance_account')
      ) {
        select = select.replace(',binance_account', '')
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'min_available_wallet_pct') &&
        select.includes('min_available_wallet_pct')
      ) {
        select = select.replace(',min_available_wallet_pct', '')
        continue
      }
      if (/max_open_positions/i.test(msg)) {
        const legacyPath =
          `/rest/v1/agent_settings?select=${AGENT3_SETTINGS_SELECT_LEGACY}` +
          '&agent_name=eq.agent3' +
          '&limit=1'
        rows = await supabaseRest(legacyPath)
        agent3BinanceAccountColumnReadable = false
        break
      }
      throw e
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ...normalizeAgent3Settings({}),
      updatedAt: null,
    }
  }
  const row = rows[0]
  const s = normalizeAgent3Settings(row)
  return {
    ...s,
    updatedAt: row.updated_at ?? null,
  }
}

function normalizePositionSideForKey(v) {
  const s = String(v ?? '').trim().toUpperCase()
  if (s === 'LONG' || s === 'SHORT' || s === 'BOTH') return s
  return 'BOTH'
}

function buildAgentTradePositionKey(symbol, positionSide) {
  return `${String(symbol ?? '').toUpperCase()}|${normalizePositionSideForKey(positionSide)}`
}

/**
 * Hedge: LONG / SHORT are separate rows. One-way: often positionSide BOTH with signed positionAmt —
 * normalize to LONG (amt > 0) or SHORT (amt < 0) so open-key sets match per-leg checks.
 */
function positionSideForOpenKeyFromRiskRow(p) {
  const sideRaw = String(p?.positionSide ?? '').trim().toUpperCase()
  if (sideRaw === 'LONG') return 'LONG'
  if (sideRaw === 'SHORT') return 'SHORT'
  const amt = Number.parseFloat(String(p?.positionAmt ?? '0'))
  if (!Number.isFinite(amt) || amt === 0) return 'BOTH'
  return amt > 0 ? 'LONG' : 'SHORT'
}

/** Non-zero position rows from /fapi/v2/positionRisk → keys (LONG/SHORT legs; BOTH only if amt sign missing). */
function openPositionKeysFromRiskRows(rows) {
  const out = new Set()
  if (!Array.isArray(rows)) return out
  for (const p of rows) {
    const amt = Number.parseFloat(String(p?.positionAmt ?? '0'))
    if (!Number.isFinite(amt) || Math.abs(amt) <= 0) continue
    const symbol = normalizeUsdtFuturesSymbol(p?.symbol, { allowMissingSuffix: false })
    if (!symbol) continue
    const sideForKey = positionSideForOpenKeyFromRiskRow(p)
    out.add(buildAgentTradePositionKey(symbol, sideForKey))
  }
  return out
}

/** Map position key → risk row for UI / ongoing trade enrichment. */
function openPositionRowMapFromRiskRows(rows) {
  const map = new Map()
  if (!Array.isArray(rows)) return map
  for (const p of rows) {
    const amt = Number.parseFloat(String(p?.positionAmt ?? '0'))
    if (!Number.isFinite(amt) || Math.abs(amt) <= 0) continue
    const symbol = normalizeUsdtFuturesSymbol(p?.symbol, { allowMissingSuffix: false })
    if (!symbol) continue
    map.set(buildAgentTradePositionKey(symbol, p?.positionSide), p)
  }
  return map
}

/** True if this symbol already has an open leg on the given side (LONG for Agent 1, SHORT for Agent 3). Hedge: other side does not block. */
function agentHasOpenPositionOnSymbolSide(openKeys, symbol, side) {
  const sym = String(symbol ?? '').toUpperCase()
  if (!sym || !(openKeys instanceof Set) || openKeys.size === 0) return false
  const leg = side === 'SHORT' ? 'SHORT' : 'LONG'
  return openKeys.has(buildAgentTradePositionKey(sym, leg))
}

/** DB rows with position_side BOTH are one-way legacy; exchange merge supplies LONG/SHORT legs — skip BOTH keys to avoid blocking the opposite hedge leg. */
function addOpenKeysFromAgentTradeRows(openKeys, tradeRows) {
  if (!(openKeys instanceof Set) || !Array.isArray(tradeRows)) return
  for (const t of tradeRows) {
    if (normalizePositionSideForKey(t.position_side) === 'BOTH') continue
    openKeys.add(buildAgentTradePositionKey(t.symbol, t.position_side))
  }
}

/** In-memory openKeys must use LONG/SHORT legs like `openPositionKeysFromRiskRows`. ONE-WAY fills use positionSide BOTH — infer from order side. */
function openPositionKeyFromPlacement(placedOut) {
  if (!placedOut || typeof placedOut !== 'object') return null
  const symbol = normalizeUsdtFuturesSymbol(placedOut.symbol, { allowMissingSuffix: false })
  if (!symbol) return null
  const ps = String(placedOut.positionSide ?? '').trim().toUpperCase()
  if (ps === 'LONG' || ps === 'SHORT') return buildAgentTradePositionKey(symbol, ps)
  const orderSide = String(placedOut.side ?? '').trim().toUpperCase()
  if (orderSide === 'BUY') return buildAgentTradePositionKey(symbol, 'LONG')
  if (orderSide === 'SELL') return buildAgentTradePositionKey(symbol, 'SHORT')
  return buildAgentTradePositionKey(symbol, 'BOTH')
}

async function fetchAgent1OpenPositionKeys(apiKey, apiSecret) {
  const rows = await fetchPositionRisk(apiKey, apiSecret)
  return openPositionKeysFromRiskRows(rows)
}

/**
 * Binance USD-M symbol validator/normalizer.
 * Accepts only A-Z0-9 API symbols (e.g. BTCUSDT, 1000PEPEUSDT).
 */
function normalizeUsdtFuturesSymbol(raw, { allowMissingSuffix = true } = {}) {
  const s = String(raw ?? '').trim().toUpperCase()
  if (!s) return null
  if (!/^[A-Z0-9]+$/.test(s)) return null
  if (s.endsWith('USDT')) return s.length > 4 ? s : null
  if (!allowMissingSuffix) return null
  return `${s}USDT`
}

async function reconcileAgent1OpenTradesWithExchange(apiKey, apiSecret) {
  const openTrades = await listAgent1TradeRecords('open', 500)
  if (openTrades.length === 0) return { closedNow: 0 }
  const all = await fetchPositionRisk(apiKey, apiSecret)
  const openKeys = openPositionKeysFromRiskRows(all)
  let closedNow = 0
  for (const tr of openTrades) {
    const key = buildAgentTradePositionKey(tr.symbol, tr.position_side)
    if (openKeys.has(key)) continue
    if (
      normalizePositionSideForKey(tr.position_side) === 'BOTH' &&
      (agentHasOpenPositionOnSymbolSide(openKeys, tr.symbol, 'LONG') ||
        agentHasOpenPositionOnSymbolSide(openKeys, tr.symbol, 'SHORT'))
    ) {
      continue
    }
    let closeMeta = {}
    try {
      closeMeta = await fetchAgentTradeCloseAccounting(apiKey, apiSecret, tr, 'agent1')
    } catch {
      closeMeta = {}
    }
    const closed = await markAgent1TradeRecordClosed(tr.id, 'position_not_open', closeMeta)
    if (closed) closedNow += 1
  }
  return { closedNow }
}

async function markAgent3TradeRecordClosed(id, closeReason, closeMeta = {}) {
  const rid = String(id ?? '').trim()
  if (!rid) return null
  const rows = await supabaseRest(`/rest/v1/agent3_trades?id=eq.${encodeURIComponent(rid)}&status=eq.open&select=*`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      status: 'closed',
      close_reason: String(closeReason ?? 'position_closed').slice(0, 80),
      closed_at: new Date().toISOString(),
      realized_pnl_usdt: Number.isFinite(Number(closeMeta?.realized_pnl_usdt))
        ? Number(closeMeta.realized_pnl_usdt)
        : null,
      commission_usdt: Number.isFinite(Number(closeMeta?.commission_usdt))
        ? Number(closeMeta.commission_usdt)
        : null,
      funding_fee_usdt: Number.isFinite(Number(closeMeta?.funding_fee_usdt))
        ? Number(closeMeta.funding_fee_usdt)
        : null,
    }),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function reconcileAgent3OpenTradesWithExchange(apiKey, apiSecret) {
  const openTrades = await listAgent3TradeRecords('open', 500)
  if (openTrades.length === 0) return { closedNow: 0 }
  const all = await fetchPositionRisk(apiKey, apiSecret)
  const openKeys = openPositionKeysFromRiskRows(all)
  let closedNow = 0
  for (const tr of openTrades) {
    const key = buildAgentTradePositionKey(tr.symbol, tr.position_side)
    if (openKeys.has(key)) continue
    if (
      normalizePositionSideForKey(tr.position_side) === 'BOTH' &&
      (agentHasOpenPositionOnSymbolSide(openKeys, tr.symbol, 'LONG') ||
        agentHasOpenPositionOnSymbolSide(openKeys, tr.symbol, 'SHORT'))
    ) {
      continue
    }
    let closeMeta = {}
    try {
      closeMeta = await fetchAgentTradeCloseAccounting(apiKey, apiSecret, tr, 'agent3')
    } catch {
      closeMeta = {}
    }
    const closed = await markAgent3TradeRecordClosed(tr.id, 'position_not_open', closeMeta)
    if (closed) closedNow += 1
  }
  return { closedNow }
}

async function runAgent1ExecutionTick() {
  if (agent1ExecutionState.running) return
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  if (canUseExecutionDbCoordination()) {
    try {
      const owner = await tryAcquireAgent1ExecutionLease()
      agent1ExecutionLeaseOwner = owner
      agent1ExecutionState.leaseOwner = owner
      if (!owner) return
    } catch (e) {
      agent1ExecutionLeaseOwner = false
      agent1ExecutionState.leaseOwner = false
      const msg = e instanceof Error ? e.message : String(e)
      agent1ExecutionState.lastError = `lease error: ${msg}`
      pushAgent1ExecutionLog('error', `lease error: ${msg}`)
      return
    }
  } else {
    agent1ExecutionLeaseOwner = true
    agent1ExecutionState.leaseOwner = true
  }
  agent1ExecutionState.running = true
  agent1ExecutionState.lastError = null
  let processed = 0
  let placed = 0
  try {
    const settings = await readAgent1Settings()
    if (settings.emaGateEnabled !== false) {
      await maybeHydrateAgent1ShadowSnapshot()
    }
    const { apiKey, apiSecret, accountId } = resolveBinanceCredentials(settings.binanceAccount)
    if (!apiKey || !apiSecret) {
      agent1ExecutionState.lastError = `Binance API keys missing for account "${accountId}"`
      pushAgent1ExecutionLog('error', agent1ExecutionState.lastError)
      return
    }
    if (!settings.agentEnabled) {
      try {
        const rec = await reconcileAgent1OpenTradesWithExchange(apiKey, apiSecret)
        if (rec.closedNow > 0) {
          pushAgent1ExecutionLog('info', `closed detected: ${rec.closedNow}`)
        }
      } catch (e) {
        pushAgent1ExecutionLog(
          'warn',
          `reconcile (agent off): ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      return
    }
    try {
      const recStart = await reconcileAgent1OpenTradesWithExchange(apiKey, apiSecret)
      if (recStart.closedNow > 0) {
        pushAgent1ExecutionLog('info', `closed at tick start: ${recStart.closedNow}`)
      }
    } catch (e) {
      pushAgent1ExecutionLog(
        'warn',
        `reconcile (tick start): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    const fetchCap = Math.min(500, Math.max(50, AGENT1_EXECUTION_MAX_SPIKES_PER_TICK * 25))
    const pendingCandidates = await fetchPendingAgent1Spikes(fetchCap)
    const pending = []
    for (const spike of pendingCandidates) {
      if (pending.length >= AGENT1_EXECUTION_MAX_SPIKES_PER_TICK) break
      const symbol = String(spike?.symbol ?? '').toUpperCase()
      const staleInfo = getAgent1SpikeStalenessInfo(
        spike,
        settings.scanInterval,
        settings.scanSecondsBeforeClose,
      )
      if (staleInfo.stale) {
        try {
          await markAgent1SpikeSkipped(spike.id, 'stale spike')
        } catch (e) {
          pushAgent1ExecutionLog(
            'warn',
            `stale spike DB skip failed ${symbol || 'UNKNOWN'}: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        const logKey = spikeExecutionLogKey(spike, symbol)
        if (!agent1StaleSpikeLogIds.has(logKey)) {
          const agePart =
            staleInfo.ageMs != null && staleInfo.maxAgeMs != null
              ? ` ageMs=${Math.round(staleInfo.ageMs)} maxMs=${staleInfo.maxAgeMs} iv=${staleInfo.scanInterval} sbc=${staleInfo.scanSecondsBeforeClose}${staleInfo.usedEnvMaxAge ? ` env=${staleInfo.envMaxAgeKey}` : ''}`
              : ''
          pushAgent1ExecutionLog('info', `skip ${symbol || 'UNKNOWN'}: stale spike${agePart}`)
          agent1StaleSpikeLogIds.add(logKey)
          if (agent1StaleSpikeLogIds.size > 5000) {
            agent1StaleSpikeLogIds.clear()
          }
        }
        continue
      }
      pending.push(spike)
    }
    const emaGateEnabled = settings.emaGateEnabled !== false
    const regime = getAgent1ShadowSnapshot()?.regime ?? null
    if (emaGateEnabled && (!regime || regime.gateAllowLong !== true)) {
      agent1ExecutionState.lastGateBlockAt = Date.now()
      const nextGateState = regime == null ? 'blocked_unavailable' : 'blocked_below_ema'
      if (pending.length > 0) {
        const reason =
          nextGateState === 'blocked_unavailable'
            ? 'regime unavailable'
            : 'regime blocked'
        for (const spike of pending) {
          processed += 1
          const symbol = String(spike?.symbol ?? '').toUpperCase()
          const logKey = spikeExecutionLogKey(spike, symbol || 'UNKNOWN')
          if (!agent1BlockedRegimeSpikeLogIds.has(logKey)) {
            pushAgent1ExecutionLog('info', `skip ${symbol || 'UNKNOWN'}: ${reason}`)
            agent1BlockedRegimeSpikeLogIds.add(logKey)
            if (agent1BlockedRegimeSpikeLogIds.size > 5000) {
              agent1BlockedRegimeSpikeLogIds.clear()
            }
          }
        }
      }
      agent1LastGateState = nextGateState
      try {
        const rec = await reconcileAgent1OpenTradesWithExchange(apiKey, apiSecret)
        if (rec.closedNow > 0) {
          pushAgent1ExecutionLog('info', `closed detected: ${rec.closedNow}`)
        }
      } catch (e) {
        pushAgent1ExecutionLog(
          'warn',
          `reconcile (gate blocked): ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      return
    }
    if (!emaGateEnabled) {
      if (agent1LastGateState !== 'disabled') {
        pushAgent1ExecutionLog('warn', 'EMA gate disabled: execution bypassing regime gate')
      }
      agent1LastGateState = 'disabled'
    } else if (agent1LastGateState !== 'allow') {
      pushAgent1ExecutionLog(
        'info',
        `gate open: allow long (cum=${Number.isFinite(Number(regime.latestCumPnlPct)) ? Number(regime.latestCumPnlPct).toFixed(3) : 'na'} ema=${Number.isFinite(Number(regime.emaValue)) ? Number(regime.emaValue).toFixed(3) : 'na'})`,
      )
      agent1LastGateState = 'allow'
    }
    if (agent1BlockedRegimeSpikeLogIds.size > 0) {
      agent1BlockedRegimeSpikeLogIds.clear()
    }

    const openTrades = await listAgent1TradeRecords('open', 500)
    const openKeys = new Set()
    addOpenKeysFromAgentTradeRows(openKeys, openTrades)
    try {
      const exchangeOpenKeys = await fetchAgent1OpenPositionKeys(apiKey, apiSecret)
      for (const k of exchangeOpenKeys) openKeys.add(k)
    } catch (e) {
      pushAgent1ExecutionLog(
        'warn',
        `open-position sync failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    let tradeMarginUsd = settings.tradeSizeUsd
    if (pending.length > 0) {
      tradeMarginUsd = await resolveAgentTradeMarginUsd(
        settings,
        apiKey,
        apiSecret,
        pushAgent1ExecutionLog,
      )
      const headroom = await checkFuturesWalletHeadroomForNewTrades(
        apiKey,
        apiSecret,
        pushAgent1ExecutionLog,
        'agent1',
        settings.minAvailableWalletPct,
      )
      if (!headroom.allow) {
        try {
          const rec = await reconcileAgent1OpenTradesWithExchange(apiKey, apiSecret)
          if (rec.closedNow > 0) {
            pushAgent1ExecutionLog('info', `closed detected: ${rec.closedNow}`)
          }
        } catch (e) {
          pushAgent1ExecutionLog(
            'warn',
            `reconcile (wallet headroom): ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        // Wallet headroom policy: pending spikes are skipped (logged + skip_reason) instead of retrying until stale.
        const marginSkipReason = 'skipped due to insufficient margin'
        for (const s of pending) {
          const sym = String(s?.symbol ?? '').toUpperCase() || 'UNKNOWN'
          try {
            await markAgent1SpikeSkipped(s.id, marginSkipReason)
            pushAgent1ExecutionLog('info', `skip ${sym}: ${marginSkipReason}`)
          } catch (e) {
            pushAgent1ExecutionLog(
              'warn',
              `skip ${sym}: ${marginSkipReason} (DB update failed: ${
                e instanceof Error ? e.message : String(e)
              })`,
            )
          }
        }
        return
      }
    }

    for (const spike of pending) {
      processed += 1
      const rawSymbol = String(spike?.symbol ?? '')
      const symbol = normalizeUsdtFuturesSymbol(rawSymbol, { allowMissingSuffix: false })
      const direction = String(spike?.direction ?? '').toLowerCase()
      if (!symbol) {
        const bad = String(rawSymbol ?? '').trim() || 'UNKNOWN'
        await markAgent1SpikeSkipped(spike.id, 'invalid symbol format')
        pushAgent1ExecutionLog('warn', `skip ${bad}: invalid symbol format`)
        continue
      }
      if (direction !== 'up') {
        await markAgent1SpikeSkipped(spike.id, `direction ${direction}`)
        pushAgent1ExecutionLog('info', `skip ${symbol}: direction ${direction}`)
        continue
      }
      const spikeLowRaw = Number.parseFloat(String(spike?.spike_low ?? ''))
      if (!Number.isFinite(spikeLowRaw) || spikeLowRaw <= 0) {
        await markAgent1SpikeSkipped(spike.id, 'missing spike_low')
        pushAgent1ExecutionLog('warn', `skip ${symbol}: missing spike_low`)
        continue
      }
      if (agentHasOpenPositionOnSymbolSide(openKeys, symbol, 'LONG')) {
        await markAgent1SpikeSkipped(spike.id, 'long already open')
        pushAgent1ExecutionLog('info', `skip ${symbol}: long already open`)
        continue
      }
      if (openKeys.size >= settings.maxOpenPositions) {
        await markAgent1SpikeSkipped(spike.id, `max open positions reached (${settings.maxOpenPositions})`)
        pushAgent1ExecutionLog(
          'warn',
          `skip ${symbol}: max open positions reached (${settings.maxOpenPositions})`,
        )
        continue
      }
      let placedOut = null
      let lastErrMsg = ''
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt === 2) {
            pushAgent1ExecutionLog('warn', `retry ${symbol}: placement attempt 2/2`)
          }
          placedOut = await placeFuturesOrderWithProtection({
            apiKey,
            apiSecret,
            symbolRaw: symbol,
            sideRaw: 'BUY',
            tradeSizeUsdRaw: tradeMarginUsd,
            leverageRaw: settings.leverage,
            marginModeRaw: settings.marginMode,
            tpPctRaw: settings.maxTpPct,
            slPctRaw: settings.maxSlPct,
            spikeLowPriceRaw: spike?.spike_low,
            debug: false,
          })
          break
        } catch (e) {
          lastErrMsg = e instanceof Error ? e.message : String(e)
          const criticalProtectionFailure = /position should be flat/i.test(lastErrMsg)
          if (criticalProtectionFailure) {
            pushAgent1ExecutionLog(
              'error',
              `critical ${symbol}: ${lastErrMsg} (retry blocked to avoid stacked exposure)`,
            )
            try {
              const exchangeOpenKeys = await fetchAgent1OpenPositionKeys(apiKey, apiSecret)
              for (const k of exchangeOpenKeys) openKeys.add(k)
            } catch {
              // best-effort sync only
            }
            break
          }
          if (attempt === 1) {
            pushAgent1ExecutionLog('warn', `failed ${symbol}: ${lastErrMsg} (retrying once now)`)
          }
        }
      }
      if (!placedOut) {
        await markAgent1SpikeSkipped(
          spike.id,
          lastErrMsg ? `placement failed: ${lastErrMsg}` : 'placement failed after retry',
        )
        pushAgent1ExecutionLog('error', `failed ${symbol}: ${lastErrMsg} (skipped after retry)`)
        continue
      }
      try {
        const saved = await insertAgent1TradeRecord({
          spike_id: spike.id,
          symbol: placedOut.symbol,
          side: placedOut.side,
          position_side: placedOut.positionSide,
          status: 'open',
          requested_leverage: placedOut.requestedLeverage,
          applied_leverage: placedOut.appliedLeverage,
          trade_size_usd: placedOut.tradeSizeUsd,
          quantity: Number(placedOut.quantity),
          entry_order_id: placedOut.entryOrder?.orderId ?? null,
          tp_algo_id: placedOut.tpOrder?.algoId ?? null,
          sl_algo_id: placedOut.slOrder?.algoId ?? null,
          entry_price: placedOut.entryPrice,
          warnings: Array.isArray(placedOut.warnings)
            ? placedOut.warnings.join(' | ').slice(0, 500)
            : null,
          opened_at: new Date().toISOString(),
        })
        if (!saved) {
          await markAgent1SpikeTradeTaken(spike.id)
          pushAgent1ExecutionLog(
            'error',
            `placed ${placedOut.symbol} but DB row missing — spike marked taken to avoid duplicate orders`,
          )
        } else {
          await markAgent1SpikeTradeTaken(spike.id)
          const placedKey = openPositionKeyFromPlacement(placedOut)
          if (placedKey) openKeys.add(placedKey)
          placed += 1
          pushAgent1ExecutionLog(
            'info',
            `placed ${placedOut.symbol} lev ${placedOut.appliedLeverage}x qty ${placedOut.quantity}`,
          )
          const caps = Array.isArray(placedOut.warnings)
            ? placedOut.warnings.filter((w) => /capped by setting/i.test(String(w)))
            : []
          for (const msg of caps.slice(0, 2)) {
            pushAgent1ExecutionLog('warn', `${placedOut.symbol}: ${msg}`)
          }
        }
      } catch (e) {
        await markAgent1SpikeTradeTaken(spike.id)
        pushAgent1ExecutionLog(
          'error',
          `placed ${placedOut.symbol} but record save failed — spike marked taken to avoid duplicate: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }
    const rec = await reconcileAgent1OpenTradesWithExchange(apiKey, apiSecret)
    if (rec.closedNow > 0) {
      pushAgent1ExecutionLog('info', `closed detected: ${rec.closedNow}`)
    }
  } catch (e) {
    agent1ExecutionState.lastError = e instanceof Error ? e.message : String(e)
    pushAgent1ExecutionLog('error', `tick error: ${agent1ExecutionState.lastError}`)
  } finally {
    agent1ExecutionState.lastRunAt = Date.now()
    agent1ExecutionState.lastProcessed = processed
    agent1ExecutionState.lastPlaced = placed
    agent1ExecutionState.running = false
  }
}

async function runAgent3ExecutionTick() {
  if (agent3ExecutionState.running) return
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  if (canUseAgent3ExecutionDbCoordination()) {
    try {
      const owner = await tryAcquireAgent3ExecutionLease()
      agent3ExecutionLeaseOwner = owner
      agent3ExecutionState.leaseOwner = owner
      if (!owner) return
    } catch (e) {
      agent3ExecutionLeaseOwner = false
      agent3ExecutionState.leaseOwner = false
      const msg = e instanceof Error ? e.message : String(e)
      agent3ExecutionState.lastError = `lease error: ${msg}`
      pushAgent3ExecutionLog('error', `lease error: ${msg}`)
      return
    }
  } else {
    agent3ExecutionLeaseOwner = true
    agent3ExecutionState.leaseOwner = true
  }
  agent3ExecutionState.running = true
  agent3ExecutionState.lastError = null
  let processed = 0
  let placed = 0
  try {
    const settings = await readAgent3Settings()
    if (settings.emaGateEnabled !== false) {
      await maybeHydrateAgent1ShadowSnapshot()
    }
    const { apiKey, apiSecret, accountId } = resolveBinanceCredentials(settings.binanceAccount)
    if (!apiKey || !apiSecret) {
      agent3ExecutionState.lastError = `Binance API keys missing for account "${accountId}"`
      pushAgent3ExecutionLog('error', agent3ExecutionState.lastError)
      return
    }
    if (!settings.agentEnabled) {
      try {
        const rec = await reconcileAgent3OpenTradesWithExchange(apiKey, apiSecret)
        if (rec.closedNow > 0) {
          pushAgent3ExecutionLog('info', `closed detected: ${rec.closedNow}`)
        }
      } catch (e) {
        pushAgent3ExecutionLog(
          'warn',
          `reconcile (agent off): ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      return
    }
    try {
      const recStart = await reconcileAgent3OpenTradesWithExchange(apiKey, apiSecret)
      if (recStart.closedNow > 0) {
        pushAgent3ExecutionLog('info', `closed at tick start: ${recStart.closedNow}`)
      }
    } catch (e) {
      pushAgent3ExecutionLog(
        'warn',
        `reconcile (tick start): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    const fetchCap = Math.min(500, Math.max(50, AGENT3_EXECUTION_MAX_SPIKES_PER_TICK * 25))
    const pendingCandidates = await fetchPendingAgent3Spikes(fetchCap)
    const pending = []
    for (const spike of pendingCandidates) {
      if (pending.length >= AGENT3_EXECUTION_MAX_SPIKES_PER_TICK) break
      const symbol = String(spike?.symbol ?? '').toUpperCase()
      const staleInfoA3 = getAgent3SpikeStalenessInfo(
        spike,
        settings.scanInterval,
        settings.scanSecondsBeforeClose,
      )
      if (staleInfoA3.stale) {
        try {
          await markAgent3SpikeSkipped(spike.id, 'stale spike')
        } catch (e) {
          pushAgent3ExecutionLog(
            'warn',
            `stale spike DB skip failed ${symbol || 'UNKNOWN'}: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        const logKey = spikeExecutionLogKey(spike, symbol)
        if (!agent3StaleSpikeLogIds.has(logKey)) {
          const agePart =
            staleInfoA3.ageMs != null && staleInfoA3.maxAgeMs != null
              ? ` ageMs=${Math.round(staleInfoA3.ageMs)} maxMs=${staleInfoA3.maxAgeMs} iv=${staleInfoA3.scanInterval} sbc=${staleInfoA3.scanSecondsBeforeClose}${staleInfoA3.usedEnvMaxAge ? ` env=${staleInfoA3.envMaxAgeKey}` : ''}`
              : ''
          pushAgent3ExecutionLog('info', `skip ${symbol || 'UNKNOWN'}: stale spike${agePart}`)
          agent3StaleSpikeLogIds.add(logKey)
          if (agent3StaleSpikeLogIds.size > 5000) {
            agent3StaleSpikeLogIds.clear()
          }
        }
        continue
      }
      pending.push(spike)
    }

    const emaGateEnabledA3 = settings.emaGateEnabled !== false
    const regimeA3 = getAgent1ShadowSnapshot()?.regimeAgent3 ?? null
    if (emaGateEnabledA3 && (!regimeA3 || regimeA3.gateAllowLong !== true)) {
      agent3ExecutionState.lastGateBlockAt = Date.now()
      const nextGateState = regimeA3 == null ? 'blocked_unavailable' : 'blocked_below_ema'
      if (pending.length > 0) {
        const reason = nextGateState === 'blocked_unavailable' ? 'regime unavailable' : 'regime blocked'
        for (const spike of pending) {
          const symbol = String(spike?.symbol ?? '').toUpperCase()
          const logKey = spikeExecutionLogKey(spike, symbol || 'UNKNOWN')
          if (!agent3BlockedRegimeSpikeLogIds.has(logKey)) {
            pushAgent3ExecutionLog('info', `skip ${symbol || 'UNKNOWN'}: ${reason}`)
            agent3BlockedRegimeSpikeLogIds.add(logKey)
            if (agent3BlockedRegimeSpikeLogIds.size > 5000) {
              agent3BlockedRegimeSpikeLogIds.clear()
            }
          }
        }
      }
      agent3LastGateState = nextGateState
      try {
        const rec = await reconcileAgent3OpenTradesWithExchange(apiKey, apiSecret)
        if (rec.closedNow > 0) {
          pushAgent3ExecutionLog('info', `closed detected: ${rec.closedNow}`)
        }
      } catch (e) {
        pushAgent3ExecutionLog(
          'warn',
          `reconcile (gate blocked): ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      return
    }
    if (!emaGateEnabledA3) {
      if (agent3LastGateState !== 'disabled') {
        pushAgent3ExecutionLog('warn', 'EMA gate disabled: Agent 3 execution bypassing regime gate')
      }
      agent3LastGateState = 'disabled'
    } else if (agent3LastGateState !== 'allow') {
      pushAgent3ExecutionLog(
        'info',
        `gate open: allow short (cum=${Number.isFinite(Number(regimeA3?.latestCumPnlPct)) ? Number(regimeA3.latestCumPnlPct).toFixed(3) : 'na'} ema=${Number.isFinite(Number(regimeA3?.emaValue)) ? Number(regimeA3.emaValue).toFixed(3) : 'na'})`,
      )
      agent3LastGateState = 'allow'
    }
    if (agent3BlockedRegimeSpikeLogIds.size > 0) {
      agent3BlockedRegimeSpikeLogIds.clear()
    }

    const openTrades = await listAgent3TradeRecords('open', 500)
    const openKeys = new Set()
    addOpenKeysFromAgentTradeRows(openKeys, openTrades)
    try {
      const exchangeOpenKeys = await fetchAgent1OpenPositionKeys(apiKey, apiSecret)
      for (const k of exchangeOpenKeys) openKeys.add(k)
    } catch (e) {
      pushAgent3ExecutionLog(
        'warn',
        `open-position sync failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    let tradeMarginUsd = settings.tradeSizeUsd
    if (pending.length > 0) {
      tradeMarginUsd = await resolveAgentTradeMarginUsd(
        settings,
        apiKey,
        apiSecret,
        pushAgent3ExecutionLog,
      )
      const headroom = await checkFuturesWalletHeadroomForNewTrades(
        apiKey,
        apiSecret,
        pushAgent3ExecutionLog,
        'agent3',
        settings.minAvailableWalletPct,
      )
      if (!headroom.allow) {
        try {
          const rec = await reconcileAgent3OpenTradesWithExchange(apiKey, apiSecret)
          if (rec.closedNow > 0) {
            pushAgent3ExecutionLog('info', `closed detected: ${rec.closedNow}`)
          }
        } catch (e) {
          pushAgent3ExecutionLog(
            'warn',
            `reconcile (wallet headroom): ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        // Wallet headroom policy: pending spikes are skipped (logged + skip_reason) instead of retrying until stale.
        const marginSkipReason = 'skipped due to insufficient margin'
        for (const s of pending) {
          const sym = String(s?.symbol ?? '').toUpperCase() || 'UNKNOWN'
          try {
            await markAgent3SpikeSkipped(s.id, marginSkipReason)
            pushAgent3ExecutionLog('info', `skip ${sym}: ${marginSkipReason}`)
          } catch (e) {
            pushAgent3ExecutionLog(
              'warn',
              `skip ${sym}: ${marginSkipReason} (DB update failed: ${
                e instanceof Error ? e.message : String(e)
              })`,
            )
          }
        }
        return
      }
    }

    for (const spike of pending) {
      processed += 1
      const rawSymbol = String(spike?.symbol ?? '')
      const symbol = normalizeUsdtFuturesSymbol(rawSymbol, { allowMissingSuffix: false })
      const direction = String(spike?.direction ?? '').toLowerCase()
      if (!symbol) {
        const bad = String(rawSymbol ?? '').trim() || 'UNKNOWN'
        await markAgent3SpikeSkipped(spike.id, 'invalid symbol format')
        pushAgent3ExecutionLog('warn', `skip ${bad}: invalid symbol format`)
        continue
      }
      if (direction !== 'down') {
        await markAgent3SpikeSkipped(spike.id, `direction ${direction}`)
        pushAgent3ExecutionLog('info', `skip ${symbol}: direction ${direction}`)
        continue
      }
      const spikeHighRaw = Number.parseFloat(String(spike?.spike_high ?? ''))
      if (!Number.isFinite(spikeHighRaw) || spikeHighRaw <= 0) {
        await markAgent3SpikeSkipped(spike.id, 'missing spike_high')
        pushAgent3ExecutionLog('warn', `skip ${symbol}: missing spike_high`)
        continue
      }
      if (agentHasOpenPositionOnSymbolSide(openKeys, symbol, 'SHORT')) {
        await markAgent3SpikeSkipped(spike.id, 'short already open')
        pushAgent3ExecutionLog('info', `skip ${symbol}: short already open`)
        continue
      }
      if (openKeys.size >= settings.maxOpenPositions) {
        await markAgent3SpikeSkipped(spike.id, `max open positions reached (${settings.maxOpenPositions})`)
        pushAgent3ExecutionLog(
          'warn',
          `skip ${symbol}: max open positions reached (${settings.maxOpenPositions})`,
        )
        continue
      }
      let placedOut = null
      let lastErrMsg = ''
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt === 2) {
            pushAgent3ExecutionLog('warn', `retry ${symbol}: placement attempt 2/2`)
          }
          placedOut = await placeFuturesOrderWithProtection({
            apiKey,
            apiSecret,
            symbolRaw: symbol,
            sideRaw: 'SELL',
            tradeSizeUsdRaw: tradeMarginUsd,
            leverageRaw: settings.leverage,
            marginModeRaw: settings.marginMode,
            tpPctRaw: settings.maxTpPct,
            slPctRaw: settings.maxSlPct,
            spikeHighPriceRaw: spike?.spike_high,
            debug: false,
          })
          break
        } catch (e) {
          lastErrMsg = e instanceof Error ? e.message : String(e)
          const criticalProtectionFailure = /position should be flat/i.test(lastErrMsg)
          if (criticalProtectionFailure) {
            pushAgent3ExecutionLog(
              'error',
              `critical ${symbol}: ${lastErrMsg} (retry blocked to avoid stacked exposure)`,
            )
            try {
              const exchangeOpenKeys = await fetchAgent1OpenPositionKeys(apiKey, apiSecret)
              for (const k of exchangeOpenKeys) openKeys.add(k)
            } catch {
              // best-effort sync only
            }
            break
          }
          if (attempt === 1) {
            pushAgent3ExecutionLog('warn', `failed ${symbol}: ${lastErrMsg} (retrying once now)`)
          }
        }
      }
      if (!placedOut) {
        await markAgent3SpikeSkipped(
          spike.id,
          lastErrMsg ? `placement failed: ${lastErrMsg}` : 'placement failed after retry',
        )
        pushAgent3ExecutionLog('error', `failed ${symbol}: ${lastErrMsg} (skipped after retry)`)
        continue
      }
      try {
        const saved = await insertAgent3TradeRecord({
          spike_id: spike.id,
          symbol: placedOut.symbol,
          side: placedOut.side,
          position_side: placedOut.positionSide,
          status: 'open',
          requested_leverage: placedOut.requestedLeverage,
          applied_leverage: placedOut.appliedLeverage,
          trade_size_usd: placedOut.tradeSizeUsd,
          quantity: Number(placedOut.quantity),
          entry_order_id: placedOut.entryOrder?.orderId ?? null,
          tp_algo_id: placedOut.tpOrder?.algoId ?? null,
          sl_algo_id: placedOut.slOrder?.algoId ?? null,
          entry_price: placedOut.entryPrice,
          warnings: Array.isArray(placedOut.warnings)
            ? placedOut.warnings.join(' | ').slice(0, 500)
            : null,
          opened_at: new Date().toISOString(),
        })
        if (!saved) {
          await markAgent3SpikeTradeTaken(spike.id)
          pushAgent3ExecutionLog(
            'error',
            `placed ${placedOut.symbol} but DB row missing — spike marked taken to avoid duplicate orders`,
          )
        } else {
          await markAgent3SpikeTradeTaken(spike.id)
          const placedKey = openPositionKeyFromPlacement(placedOut)
          if (placedKey) openKeys.add(placedKey)
          placed += 1
          pushAgent3ExecutionLog(
            'info',
            `placed short ${placedOut.symbol} lev ${placedOut.appliedLeverage}x qty ${placedOut.quantity}`,
          )
          const caps = Array.isArray(placedOut.warnings)
            ? placedOut.warnings.filter((w) => /capped by setting/i.test(String(w)))
            : []
          for (const msg of caps.slice(0, 2)) {
            pushAgent3ExecutionLog('warn', `${placedOut.symbol}: ${msg}`)
          }
        }
      } catch (e) {
        await markAgent3SpikeTradeTaken(spike.id)
        pushAgent3ExecutionLog(
          'error',
          `placed ${placedOut.symbol} but record save failed — spike marked taken to avoid duplicate: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }
    const rec = await reconcileAgent3OpenTradesWithExchange(apiKey, apiSecret)
    if (rec.closedNow > 0) {
      pushAgent3ExecutionLog('info', `closed detected: ${rec.closedNow}`)
    }
  } catch (e) {
    agent3ExecutionState.lastError = e instanceof Error ? e.message : String(e)
    pushAgent3ExecutionLog('error', `tick error: ${agent3ExecutionState.lastError}`)
  } finally {
    agent3ExecutionState.lastRunAt = Date.now()
    agent3ExecutionState.lastProcessed = processed
    agent3ExecutionState.lastPlaced = placed
    agent3ExecutionState.running = false
  }
}

async function upsertAgent1Settings(input) {
  const s = normalizeAgent1Settings(input)
  const body = {
    agent_name: s.agentName,
    trade_size_usd: s.tradeSizeUsd,
    trade_size_wallet_pct: s.tradeSizeWalletPct,
    leverage: s.leverage,
    margin_mode: s.marginMode,
    max_tp_pct: s.maxTpPct,
    max_sl_pct: s.maxSlPct,
    max_open_positions: s.maxOpenPositions,
    scan_seconds_before_close: s.scanSecondsBeforeClose,
    scan_threshold_pct: s.scanThresholdPct,
    scan_min_quote_volume: s.scanMinQuoteVolume,
    scan_max_symbols: s.scanMaxSymbols,
    scan_spike_metric: s.scanSpikeMetric,
    scan_direction: s.scanDirection,
    scan_interval: s.scanInterval,
    agent_enabled: s.agentEnabled,
    ema_gate_enabled: s.emaGateEnabled,
    binance_account: s.binanceAccount,
    min_available_wallet_pct: s.minAvailableWalletPct,
  }
  let bodyToSend = { ...body }
  let rows
  let strippedBinanceAccountDueToMissingDbColumn = false
  let strippedMinAvailableWalletPctDueToMissingDbColumn = false
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rows = await supabaseRest('/rest/v1/agent_settings?on_conflict=agent_name&select=*', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(bodyToSend),
      })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/max_open_positions/i.test(msg)) {
        throw new Error(
          'maxOpenPositions requires DB migration. Run supabase/agent_settings_alter_agent1.sql (or supabase/agent_settings.sql) and retry.',
        )
      }
      if (/trade_size_wallet_pct/i.test(msg) && Object.hasOwn(bodyToSend, 'trade_size_wallet_pct')) {
        const { trade_size_wallet_pct: _w, ...rest } = bodyToSend
        bodyToSend = rest
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'min_available_wallet_pct') &&
        Object.hasOwn(bodyToSend, 'min_available_wallet_pct')
      ) {
        const { min_available_wallet_pct: _m, ...rest } = bodyToSend
        bodyToSend = rest
        strippedMinAvailableWalletPctDueToMissingDbColumn = true
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'binance_account') &&
        Object.hasOwn(bodyToSend, 'binance_account')
      ) {
        const { binance_account: _b, ...rest } = bodyToSend
        bodyToSend = rest
        strippedBinanceAccountDueToMissingDbColumn = true
        continue
      }
      throw e
    }
  }
  if (strippedMinAvailableWalletPctDueToMissingDbColumn) {
    throw new Error(
      'Cannot save min available wallet %: agent_settings is missing column min_available_wallet_pct. Run supabase/agent_settings_min_available_wallet_pct.sql in Supabase, then save again.',
    )
  }
  if (strippedBinanceAccountDueToMissingDbColumn && s.binanceAccount !== 'master') {
    throw new Error(
      'Cannot save Agent 1 Binance sub-account: database table agent_settings is missing column binance_account (or it is unreadable). Run supabase/agent_settings_binance_account.sql in Supabase, restart the server, then save again. Until then the server uses the default account (master) for credentials.',
    )
  }
  agent1BinanceAccountColumnReadable = !strippedBinanceAccountDueToMissingDbColumn
  const row = Array.isArray(rows) && rows[0] ? rows[0] : body
  const out = normalizeAgent1Settings(row)
  return {
    ...out,
    updatedAt: row.updated_at ?? null,
  }
}

async function upsertAgent3Settings(input) {
  const s = normalizeAgent3Settings(input)
  const body = {
    agent_name: 'agent3',
    trade_size_usd: s.tradeSizeUsd,
    trade_size_wallet_pct: s.tradeSizeWalletPct,
    leverage: s.leverage,
    margin_mode: s.marginMode,
    max_tp_pct: s.maxTpPct,
    max_sl_pct: s.maxSlPct,
    max_open_positions: s.maxOpenPositions,
    scan_seconds_before_close: s.scanSecondsBeforeClose,
    scan_threshold_pct: s.scanThresholdPct,
    scan_min_quote_volume: s.scanMinQuoteVolume,
    scan_max_symbols: s.scanMaxSymbols,
    scan_spike_metric: s.scanSpikeMetric,
    scan_direction: s.scanDirection,
    scan_interval: s.scanInterval,
    agent_enabled: s.agentEnabled,
    ema_gate_enabled: s.emaGateEnabled,
    binance_account: s.binanceAccount,
    min_available_wallet_pct: s.minAvailableWalletPct,
  }
  let bodyToSend = { ...body }
  let rows
  let strippedBinanceAccountDueToMissingDbColumn = false
  let strippedMinAvailableWalletPctDueToMissingDbColumn = false
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rows = await supabaseRest('/rest/v1/agent_settings?on_conflict=agent_name&select=*', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(bodyToSend),
      })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/max_open_positions/i.test(msg)) {
        throw new Error(
          'maxOpenPositions requires DB migration. Run supabase/agent_settings_alter_agent1.sql (adds columns used by all agents) and retry.',
        )
      }
      if (/trade_size_wallet_pct/i.test(msg) && Object.hasOwn(bodyToSend, 'trade_size_wallet_pct')) {
        const { trade_size_wallet_pct: _w, ...rest } = bodyToSend
        bodyToSend = rest
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'min_available_wallet_pct') &&
        Object.hasOwn(bodyToSend, 'min_available_wallet_pct')
      ) {
        const { min_available_wallet_pct: _m, ...rest } = bodyToSend
        bodyToSend = rest
        strippedMinAvailableWalletPctDueToMissingDbColumn = true
        continue
      }
      if (
        supabaseErrorIndicatesMissingColumn(msg, 'binance_account') &&
        Object.hasOwn(bodyToSend, 'binance_account')
      ) {
        const { binance_account: _b, ...rest } = bodyToSend
        bodyToSend = rest
        strippedBinanceAccountDueToMissingDbColumn = true
        continue
      }
      throw e
    }
  }
  if (strippedMinAvailableWalletPctDueToMissingDbColumn) {
    throw new Error(
      'Cannot save min available wallet %: agent_settings is missing column min_available_wallet_pct. Run supabase/agent_settings_min_available_wallet_pct.sql in Supabase, then save again.',
    )
  }
  if (strippedBinanceAccountDueToMissingDbColumn && s.binanceAccount !== 'master') {
    throw new Error(
      'Cannot save Agent 3 Binance sub-account: database table agent_settings is missing column binance_account (or it is unreadable). Run supabase/agent_settings_binance_account.sql in Supabase, restart the server, then save again. Until then the server uses the default account (master) for credentials.',
    )
  }
  agent3BinanceAccountColumnReadable = !strippedBinanceAccountDueToMissingDbColumn
  const row = Array.isArray(rows) && rows[0] ? rows[0] : body
  const out = normalizeAgent3Settings(row)
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
      volMap.set(String(r.symbol).toUpperCase(), r.quoteVolume24h)
    }
  }
  const rows = []
  for (const ev of events) {
    const symbol = normalizeUsdtFuturesSymbol(ev?.symbol, { allowMissingSuffix: false })
    if (!symbol) continue
    rows.push({
      candle_open_time_ms: ev.openTime,
      symbol,
      direction: ev.direction,
      spike_pct: ev.spikePct,
      spike_low: Number.isFinite(Number(ev?.spikeLow)) ? Number(ev.spikeLow) : null,
      quote_volume_24h: volMap.get(symbol) ?? volMap.get(String(ev?.symbol ?? '').toUpperCase()) ?? null,
      scan_run_at: scanRunAt,
    })
  }
  if (rows.length === 0) {
    return { spikeCount: 0 }
  }
  await supabaseRest('/rest/v1/agent1_spikes?on_conflict=candle_open_time_ms,symbol,direction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
  return { spikeCount: rows.length }
}

async function persistAgent3ScanResult(scanResult) {
  const events = (scanResult.spikeEventsChronological ?? []).filter((ev) => (ev?.direction ?? '') === 'down')
  if (events.length === 0) {
    return { spikeCount: 0 }
  }
  const scanRunAt = new Date().toISOString()
  const volMap = new Map()
  for (const r of scanResult.rows ?? []) {
    if (r?.symbol != null && r.quoteVolume24h != null) {
      volMap.set(String(r.symbol).toUpperCase(), r.quoteVolume24h)
    }
  }
  const rows = []
  for (const ev of events) {
    const symbol = normalizeUsdtFuturesSymbol(ev?.symbol, { allowMissingSuffix: false })
    if (!symbol) continue
    rows.push({
      candle_open_time_ms: ev.openTime,
      symbol,
      direction: 'down',
      spike_pct: ev.spikePct,
      spike_low: Number.isFinite(Number(ev?.spikeLow)) ? Number(ev.spikeLow) : null,
      spike_high: Number.isFinite(Number(ev?.spikeHigh)) ? Number(ev.spikeHigh) : null,
      quote_volume_24h: volMap.get(symbol) ?? volMap.get(String(ev?.symbol ?? '').toUpperCase()) ?? null,
      scan_run_at: scanRunAt,
    })
  }
  if (rows.length === 0) {
    return { spikeCount: 0 }
  }
  await supabaseRest('/rest/v1/agent3_spikes?on_conflict=candle_open_time_ms,symbol,direction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
  return { spikeCount: rows.length }
}

const agent1ExecutionState = {
  running: false,
  lastRunAt: null,
  lastError: null,
  lastProcessed: 0,
  lastPlaced: 0,
  lastGateBlockAt: null,
  leaseOwner: false,
}

const agent3ExecutionState = {
  running: false,
  lastRunAt: null,
  lastError: null,
  lastProcessed: 0,
  lastPlaced: 0,
  lastGateBlockAt: null,
  leaseOwner: false,
}

let agent1LastGateState = 'unknown'
const agent1BlockedRegimeSpikeLogIds = new Set()
let agent3LastGateState = 'unknown'
const agent3BlockedRegimeSpikeLogIds = new Set()
const agent1StaleSpikeLogIds = new Set()
const agent3StaleSpikeLogIds = new Set()
/** userTrades pagination cursors: keys are `${scope}:${symbol}|${side}` so Agent 1 / 3 / 2 do not clobber each other in one-way (BOTH) mode. */
const agent1CloseAccountingCursorByKey = new Map()

/** @type {Array<{at: string, level: 'info'|'warn'|'error', msg: string}>} */
const agent1ExecutionLogs = []
/** @type {Array<{at: string, level: 'info'|'warn'|'error', msg: string}>} */
const agent3ExecutionLogs = []

async function insertAgent1ExecutionLogRow(row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  await supabaseRest('/rest/v1/agent1_execution_logs?select=*', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      level: row.level,
      message: row.msg,
      logged_at: row.at,
    }),
  })
}

async function listAgent1ExecutionLogRows(limit = 100) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return []
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const rows = await supabaseRest(
    `/rest/v1/agent1_execution_logs?select=*&order=logged_at.desc&limit=${n}`,
  )
  return Array.isArray(rows) ? rows : []
}

async function insertAgent3ExecutionLogRow(row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null
  const at = row?.at ? new Date(row.at) : new Date()
  const payload = {
    logged_at: at.toISOString(),
    level: row?.level === 'error' || row?.level === 'warn' ? row.level : 'info',
    message: String(row?.msg ?? '').slice(0, 240),
  }
  const rows = await supabaseRest('/rest/v1/agent3_execution_logs?select=*', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function listAgent3ExecutionLogRows(limit = 100) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return []
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const rows = await supabaseRest(
    `/rest/v1/agent3_execution_logs?select=*&order=logged_at.desc&limit=${n}`,
  )
  return Array.isArray(rows) ? rows : []
}

function pushAgent3ExecutionLog(level, msg) {
  const row = {
    at: new Date().toISOString(),
    level,
    msg: String(msg ?? '').slice(0, 240),
  }
  agent3ExecutionLogs.push(row)
  if (agent3ExecutionLogs.length > AGENT3_EXECUTION_MAX_LOGS) {
    agent3ExecutionLogs.splice(0, agent3ExecutionLogs.length - AGENT3_EXECUTION_MAX_LOGS)
  }
  void insertAgent3ExecutionLogRow(row).catch(() => {})
}

function pushAgent1ExecutionLog(level, msg) {
  const row = {
    at: new Date().toISOString(),
    level,
    msg: String(msg ?? '').slice(0, 240),
  }
  agent1ExecutionLogs.push(row)
  if (agent1ExecutionLogs.length > AGENT1_EXECUTION_MAX_LOGS) {
    agent1ExecutionLogs.splice(0, agent1ExecutionLogs.length - AGENT1_EXECUTION_MAX_LOGS)
  }
  void insertAgent1ExecutionLogRow(row).catch(() => {
    // keep in-memory logs even if DB log insert fails
  })
}

async function fetchPendingAgent1Spikes(limit = AGENT1_EXECUTION_MAX_SPIKES_PER_TICK) {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || AGENT1_EXECUTION_MAX_SPIKES_PER_TICK))
  const rows = await supabaseRest(
    `/rest/v1/agent1_spikes?select=*&trade_taken=eq.false&execution_skipped=eq.false&order=created_at.desc&limit=${n}`,
  )
  return Array.isArray(rows) ? rows : []
}

/** Dedupe key for once-per-spike execution logs (numeric id, UUID string, or candle time fallback). */
function spikeExecutionLogKey(spike, symbolUpper) {
  const sym = String(symbolUpper ?? '').toUpperCase() || 'UNKNOWN'
  const idRaw = spike?.id
  if (typeof idRaw === 'number' && Number.isFinite(idRaw)) {
    return `spike:${Math.trunc(idRaw)}`
  }
  const idStr = String(idRaw ?? '').trim()
  if (idStr) {
    if (/^\d+$/.test(idStr)) return `spike:${idStr}`
    return `spike:${idStr.slice(0, 80)}`
  }
  return `${sym}:${String(spike?.candle_open_time_ms ?? '')}`
}

/** Age from candle open at which a spike is too old to trade (env overrides fully replace this). */
function defaultMaxSpikeAgeMs(intervalMs, scanSecondsBeforeClose) {
  const scanBeforeMs = Math.max(0, Math.floor(Number(scanSecondsBeforeClose) || 0) * 1000)
  const slackAfterCloseMs = Math.max(0, SPIKE_EXECUTION_TRADE_WINDOW_MS - scanBeforeMs)
  return intervalMs + slackAfterCloseMs
}

/**
 * @param {string} maxAgeEnvKey - e.g. 'AGENT1_EXECUTION_MAX_SPIKE_AGE_MS'
 * @returns {{ stale: boolean, ageMs: number|null, maxAgeMs: number|null, scanInterval: string, scanSecondsBeforeClose: number, usedEnvMaxAge: boolean, envMaxAgeKey: string }}
 */
function getSpikeStalenessInfo(spike, scanInterval, scanSecondsBeforeClose, maxAgeEnvKey) {
  const openMs = Number.parseInt(String(spike?.candle_open_time_ms ?? ''), 10)
  if (!Number.isFinite(openMs) || openMs <= 0) {
    return {
      stale: false,
      ageMs: null,
      maxAgeMs: null,
      scanInterval,
      scanSecondsBeforeClose,
      usedEnvMaxAge: false,
      envMaxAgeKey: maxAgeEnvKey,
    }
  }
  const intervalMs = AGENT1_INTERVAL_MS[scanInterval] ?? AGENT1_INTERVAL_MS['5m']
  const envMaxAge = Number.parseInt(String(process.env[maxAgeEnvKey] ?? ''), 10)
  const usedEnvMaxAge = Number.isFinite(envMaxAge) && envMaxAge > 0
  const maxAgeMs = usedEnvMaxAge ? envMaxAge : defaultMaxSpikeAgeMs(intervalMs, scanSecondsBeforeClose)
  const ageMs = Date.now() - openMs
  return {
    stale: ageMs > maxAgeMs,
    ageMs,
    maxAgeMs,
    scanInterval,
    scanSecondsBeforeClose,
    usedEnvMaxAge,
    envMaxAgeKey: maxAgeEnvKey,
  }
}

function getAgent1SpikeStalenessInfo(spike, scanInterval, scanSecondsBeforeClose) {
  return getSpikeStalenessInfo(
    spike,
    scanInterval,
    scanSecondsBeforeClose,
    'AGENT1_EXECUTION_MAX_SPIKE_AGE_MS',
  )
}

function getAgent3SpikeStalenessInfo(spike, scanInterval, scanSecondsBeforeClose) {
  return getSpikeStalenessInfo(
    spike,
    scanInterval,
    scanSecondsBeforeClose,
    'AGENT3_EXECUTION_MAX_SPIKE_AGE_MS',
  )
}

async function markAgent1SpikeTradeTaken(spikeId) {
  const id = String(spikeId ?? '').trim()
  if (!SPIKE_ROW_UUID_RE.test(id)) return false
  const rows = await supabaseRest(`/rest/v1/agent1_spikes?id=eq.${id}&trade_taken=eq.false&select=*`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ trade_taken: true, execution_skipped: false, skip_reason: null }),
  })
  return Array.isArray(rows) && rows.length > 0
}

async function markAgent1SpikeSkipped(spikeId, reason) {
  const id = String(spikeId ?? '').trim()
  if (!SPIKE_ROW_UUID_RE.test(id)) return false
  const msg = String(reason ?? '').trim().slice(0, 480)
  const rows = await supabaseRest(
    `/rest/v1/agent1_spikes?id=eq.${id}&trade_taken=eq.false&execution_skipped=eq.false&select=*`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        execution_skipped: true,
        skip_reason: msg || 'skipped',
      }),
    },
  )
  return Array.isArray(rows) && rows.length > 0
}

async function insertAgent1TradeRecord(payload) {
  const rows = await supabaseRest('/rest/v1/agent1_trades?select=*', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function listAgent1TradeRecords(status, limit = 100) {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const statusPart = status ? `&status=eq.${encodeURIComponent(status)}` : ''
  const rows = await supabaseRest(
    `/rest/v1/agent1_trades?select=*&order=opened_at.desc&limit=${n}${statusPart}`,
  )
  return Array.isArray(rows) ? rows : []
}

/** Net USDT for one closed row — same formula as Agent1 closed-trades table. */
function agent1ClosedTradeNetPnlUsdt(row) {
  const r = Number(row?.realized_pnl_usdt)
  const c = Number(row?.commission_usdt)
  const f = Number(row?.funding_fee_usdt)
  const realized = Number.isFinite(r) ? r : 0
  const commission = Number.isFinite(c) ? c : 0
  const funding = Number.isFinite(f) ? f : 0
  return realized + commission + funding
}

/** Most recently closed rows first; caller sorts chronologically for cumulative curve. */
async function listAgent1ClosedTradesForPnlCurve(limit = 1000) {
  const n = Math.min(1000, Math.max(1, Math.floor(limit) || 1000))
  const rows = await supabaseRest(
    `/rest/v1/agent1_trades?select=id,symbol,opened_at,closed_at,realized_pnl_usdt,commission_usdt,funding_fee_usdt&status=eq.closed&order=closed_at.desc&limit=${n}`,
  )
  if (!Array.isArray(rows)) return []
  return rows.filter((r) => r && r.closed_at)
}

async function fetchPendingAgent3Spikes(limit = AGENT3_EXECUTION_MAX_SPIKES_PER_TICK) {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || AGENT3_EXECUTION_MAX_SPIKES_PER_TICK))
  const rows = await supabaseRest(
    `/rest/v1/agent3_spikes?select=*&trade_taken=eq.false&execution_skipped=eq.false&order=created_at.desc&limit=${n}`,
  )
  return Array.isArray(rows) ? rows : []
}

async function markAgent3SpikeTradeTaken(spikeId) {
  const id = String(spikeId ?? '').trim()
  if (!SPIKE_ROW_UUID_RE.test(id)) return false
  const rows = await supabaseRest(`/rest/v1/agent3_spikes?id=eq.${id}&trade_taken=eq.false&select=*`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ trade_taken: true, execution_skipped: false, skip_reason: null }),
  })
  return Array.isArray(rows) && rows.length > 0
}

async function markAgent3SpikeSkipped(spikeId, reason) {
  const id = String(spikeId ?? '').trim()
  if (!SPIKE_ROW_UUID_RE.test(id)) return false
  const msg = String(reason ?? '').trim().slice(0, 480)
  const rows = await supabaseRest(
    `/rest/v1/agent3_spikes?id=eq.${id}&trade_taken=eq.false&execution_skipped=eq.false&select=*`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        execution_skipped: true,
        skip_reason: msg || 'skipped',
      }),
    },
  )
  return Array.isArray(rows) && rows.length > 0
}

async function insertAgent3TradeRecord(payload) {
  const rows = await supabaseRest('/rest/v1/agent3_trades?select=*', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function listAgent3TradeRecords(status, limit = 100) {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const statusPart = status ? `&status=eq.${encodeURIComponent(status)}` : ''
  const rows = await supabaseRest(
    `/rest/v1/agent3_trades?select=*&order=opened_at.desc&limit=${n}${statusPart}`,
  )
  return Array.isArray(rows) ? rows : []
}

async function sumIncomeSince(apiKey, apiSecret, symbol, incomeType, sinceMs) {
  if (!Number.isFinite(sinceMs)) return null
  const startTime = Math.max(0, Math.floor(sinceMs))
  const data = await signedFuturesJson(apiKey, apiSecret, '/fapi/v1/income', {
    symbol,
    incomeType,
    startTime,
    limit: 200,
  })
  if (!Array.isArray(data)) return null
  let sum = 0
  let hit = false
  for (const row of data) {
    const ts = Number.parseInt(String(row?.time ?? ''), 10)
    if (!Number.isFinite(ts) || ts < startTime) continue
    const n = Number.parseFloat(String(row?.income ?? ''))
    if (!Number.isFinite(n)) continue
    sum += n
    hit = true
  }
  return hit ? sum : null
}

async function fetchAgentTradeCloseAccountingFromUserTrades(apiKey, apiSecret, tradeRow, cursorScope = 'agent2') {
  const symbol = String(tradeRow?.symbol ?? '').toUpperCase()
  if (!symbol) return null
  const openedMs = Date.parse(String(tradeRow?.opened_at ?? ''))
  if (!Number.isFinite(openedMs)) return null
  const posSideNorm = normalizePositionSideForKey(tradeRow?.position_side)
  const scope = String(cursorScope ?? 'agent2').replace(/[^a-zA-Z0-9._-]/g, '_') || 'agent2'
  const cursorKey = `${scope}:${buildAgentTradePositionKey(symbol, posSideNorm)}`
  const cursorMs = Number(agent1CloseAccountingCursorByKey.get(cursorKey))
  const lowerBoundMs = Number.isFinite(cursorMs) ? Math.max(openedMs, cursorMs + 1) : openedMs
  const startTime = Math.max(0, Math.floor(lowerBoundMs))
  const rows = await signedFuturesJson(apiKey, apiSecret, '/fapi/v1/userTrades', {
    symbol,
    startTime,
    limit: 1000,
  })
  if (!Array.isArray(rows) || rows.length === 0) return null

  const entrySide = String(tradeRow?.side ?? 'BUY').toUpperCase()
  const closeSide = entrySide === 'BUY' ? 'SELL' : 'BUY'
  const targetQty = Math.abs(toNum(tradeRow?.quantity) ?? 0)

  const candidates = rows
    .filter((r) => {
      const ts = Number.parseInt(String(r?.time ?? ''), 10)
      if (!Number.isFinite(ts) || ts < startTime) return false
      const side = String(r?.side ?? '').toUpperCase()
      if (side !== closeSide) return false
      if (posSideNorm !== 'BOTH') {
        const ps = normalizePositionSideForKey(r?.positionSide)
        if (ps !== posSideNorm) return false
      }
      return true
    })
    .sort((a, b) => {
      const ta = Number.parseInt(String(a?.time ?? ''), 10) || 0
      const tb = Number.parseInt(String(b?.time ?? ''), 10) || 0
      if (tb !== ta) return tb - ta
      const ia = Number.parseInt(String(a?.id ?? ''), 10) || 0
      const ib = Number.parseInt(String(b?.id ?? ''), 10) || 0
      return ib - ia
    })

  if (candidates.length === 0) return null

  let matchedQty = 0
  let realized = 0
  let commission = 0
  let count = 0
  let maxUsedTs = null
  const qtyCutoff = targetQty > 0 ? targetQty * 0.98 : 0
  for (const r of candidates) {
    const q = Math.abs(toNum(r?.qty) ?? 0)
    const rp = toNum(r?.realizedPnl) ?? 0
    const cm = toNum(r?.commission) ?? 0
    const ts = Number.parseInt(String(r?.time ?? ''), 10)
    matchedQty += q
    realized += rp
    commission += cm
    count += 1
    if (Number.isFinite(ts)) {
      maxUsedTs = maxUsedTs == null ? ts : Math.max(maxUsedTs, ts)
    }
    if (qtyCutoff > 0 && matchedQty >= qtyCutoff) break
  }
  if (count === 0) return null
  if (maxUsedTs != null) {
    const prev = Number(agent1CloseAccountingCursorByKey.get(cursorKey))
    if (!Number.isFinite(prev) || maxUsedTs > prev) {
      agent1CloseAccountingCursorByKey.set(cursorKey, maxUsedTs)
    }
  }
  return {
    realized_pnl_usdt: realized,
    commission_usdt: commission,
  }
}

async function fetchAgentTradeCloseAccounting(apiKey, apiSecret, tradeRow, cursorScope = 'agent2') {
  const symbol = String(tradeRow?.symbol ?? '').toUpperCase()
  if (!symbol) return {}
  const openedMs = Date.parse(String(tradeRow?.opened_at ?? ''))
  if (!Number.isFinite(openedMs)) return {}
  let realized = null
  let commission = null
  try {
    const fromTrades = await fetchAgentTradeCloseAccountingFromUserTrades(
      apiKey,
      apiSecret,
      tradeRow,
      cursorScope,
    )
    if (fromTrades) {
      realized = fromTrades.realized_pnl_usdt
      commission = fromTrades.commission_usdt
    }
  } catch {
    // Fall back to income endpoint below.
  }
  const funding = await sumIncomeSince(apiKey, apiSecret, symbol, 'FUNDING_FEE', openedMs)
  if (realized == null || commission == null) {
    const [realizedIncome, commissionIncome] = await Promise.all([
      sumIncomeSince(apiKey, apiSecret, symbol, 'REALIZED_PNL', openedMs),
      sumIncomeSince(apiKey, apiSecret, symbol, 'COMMISSION', openedMs),
    ])
    if (realized == null) realized = realizedIncome
    if (commission == null) commission = commissionIncome
  }
  return {
    realized_pnl_usdt: realized,
    commission_usdt: commission,
    funding_fee_usdt: funding,
  }
}

async function markAgent1TradeRecordClosed(id, closeReason, closeMeta = {}) {
  const rid = String(id ?? '').trim()
  if (!rid) return null
  const rows = await supabaseRest(`/rest/v1/agent1_trades?id=eq.${encodeURIComponent(rid)}&status=eq.open&select=*`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      status: 'closed',
      close_reason: String(closeReason ?? 'position_closed').slice(0, 80),
      closed_at: new Date().toISOString(),
      realized_pnl_usdt: Number.isFinite(Number(closeMeta?.realized_pnl_usdt))
        ? Number(closeMeta.realized_pnl_usdt)
        : null,
      commission_usdt: Number.isFinite(Number(closeMeta?.commission_usdt))
        ? Number(closeMeta.commission_usdt)
        : null,
      funding_fee_usdt: Number.isFinite(Number(closeMeta?.funding_fee_usdt))
        ? Number(closeMeta.funding_fee_usdt)
        : null,
    }),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function fetchPositionMode(apiKey, apiSecret) {
  const data = await signedFuturesJson(apiKey, apiSecret, '/fapi/v1/positionSide/dual', {})
  return Boolean(data?.dualSidePosition)
}

async function fetchMaxLeverageForSymbol(apiKey, apiSecret, symbol) {
  try {
    const data = await signedFuturesJson(apiKey, apiSecret, '/fapi/v1/leverageBracket', { symbol })
    const rows = Array.isArray(data) ? data : []
    const row = rows.find((r) => String(r?.symbol ?? '') === symbol) ?? rows[0]
    const brackets = Array.isArray(row?.brackets) ? row.brackets : []
    let maxLev = null
    for (const b of brackets) {
      const lev = Number.parseInt(String(b?.initialLeverage ?? ''), 10)
      if (!Number.isFinite(lev) || lev < 1) continue
      maxLev = maxLev == null ? lev : Math.max(maxLev, lev)
    }
    return Number.isFinite(maxLev) ? maxLev : null
  } catch {
    return null
  }
}

function parseMaxLeverageFromBinanceError(message) {
  const m = String(message ?? '')
  const hit = /max(?:imum)? leverage[^0-9]*([0-9]{1,3})/i.exec(m)
  if (!hit) return null
  const n = Number.parseInt(hit[1], 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

/**
 * Reusable order flow used by test page and Agent 1 execution.
 * Always attempts to continue with best-effort TP/SL.
 */
async function placeFuturesOrderWithProtection({
  apiKey,
  apiSecret,
  symbolRaw,
  sideRaw,
  tradeSizeUsdRaw,
  leverageRaw,
  marginModeRaw,
  tpPctRaw,
  slPctRaw,
  spikeLowPriceRaw,
  spikeHighPriceRaw,
  debug = false,
}) {
  const symbol = normalizeUsdtFuturesSymbol(symbolRaw, { allowMissingSuffix: true })
  if (!symbol || symbol.length > 32) {
    throw new Error('Invalid symbol format. Use Binance API symbol, e.g. BTCUSDT.')
  }

  const side = String(sideRaw ?? 'BUY').trim().toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') {
    throw new Error('side must be BUY or SELL')
  }
  const tradeSizeUsd = Number.parseFloat(String(tradeSizeUsdRaw ?? '0'))
  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) {
    throw new Error('tradeSizeUsd must be a positive number')
  }
  const requestedLeverage = Number.parseInt(String(leverageRaw ?? '5'), 10)
  if (!Number.isFinite(requestedLeverage) || requestedLeverage < 1 || requestedLeverage > 125) {
    throw new Error('leverage must be an integer between 1 and 125')
  }
  const marginModeNorm = String(marginModeRaw ?? 'cross').trim().toLowerCase()
  if (marginModeNorm !== 'cross' && marginModeNorm !== 'isolated') {
    throw new Error("marginMode must be 'cross' or 'isolated'")
  }
  const marginType = marginModeNorm === 'isolated' ? 'ISOLATED' : 'CROSSED'
  const tpPct = Number.parseFloat(String(tpPctRaw ?? '0'))
  const slPct = Number.parseFloat(String(slPctRaw ?? '0'))
  if (!Number.isFinite(tpPct) || tpPct <= 0) throw new Error('tpPct must be a positive number')
  if (!Number.isFinite(slPct) || slPct <= 0) throw new Error('slPct must be a positive number')
  const spikeLowPrice = toNum(spikeLowPriceRaw)
  const spikeHighPrice = toNum(spikeHighPriceRaw)

  const timeline = []
  const addDebug = (step, data = {}) => {
    if (!debug) return
    timeline.push({ at: new Date().toISOString(), step, ...data })
  }

  const warnings = []
  addDebug('start', { symbol, side })
  const spec = await getSymbolSpec(symbol)
  const isHedgeMode = await fetchPositionMode(apiKey, apiSecret)
  const entryPositionSide = side === 'BUY' ? 'LONG' : 'SHORT'
  try {
    await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/marginType', {
      symbol,
      marginType,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/no need to change margin type/i.test(msg)) {
      warnings.push(`Margin mode apply failed (${marginType}): ${msg}`)
    }
  }

  const maxAllowedLeverage = await fetchMaxLeverageForSymbol(apiKey, apiSecret, symbol)
  let appliedLeverage = requestedLeverage
  if (Number.isFinite(maxAllowedLeverage) && maxAllowedLeverage > 0) {
    appliedLeverage = Math.min(appliedLeverage, maxAllowedLeverage)
  }
  try {
    await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/leverage', {
      symbol,
      leverage: appliedLeverage,
    })
  } catch (e) {
    const parsed = parseMaxLeverageFromBinanceError(e instanceof Error ? e.message : String(e))
    if (Number.isFinite(parsed) && parsed > 0 && parsed < appliedLeverage) {
      appliedLeverage = parsed
      await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/leverage', {
        symbol,
        leverage: appliedLeverage,
      })
      warnings.push(`Leverage clamped by exchange to ${appliedLeverage}x`)
    } else {
      throw e
    }
  }
  if (appliedLeverage !== requestedLeverage) {
    warnings.push(`Requested leverage ${requestedLeverage}x, using ${appliedLeverage}x`)
  }
  addDebug('leverage_applied', { requestedLeverage, appliedLeverage, maxAllowedLeverage })

  const tickerQ = new URLSearchParams({ symbol })
  const tickerRes = await fetch(`${FUTURES_BASE}/fapi/v1/ticker/price?${tickerQ}`)
  const tickerText = await tickerRes.text()
  let ticker
  try {
    ticker = tickerText ? JSON.parse(tickerText) : {}
  } catch {
    throw new Error('Invalid Binance ticker response')
  }
  const markPrice = Number.parseFloat(String(ticker?.price ?? ''))
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error('Could not resolve current symbol price')
  }
  if (side === 'BUY') {
    if (!Number.isFinite(spikeLowPrice) || spikeLowPrice <= 0) {
      throw new Error('Missing spike_low for BUY trade')
    }
    if (spikeLowPrice >= markPrice) {
      throw new Error(
        `Invalid spike_low ${spikeLowPrice} for ${symbol}: must be below market ${markPrice.toFixed(8)} before entry`,
      )
    }
  } else if (side === 'SELL') {
    if (!Number.isFinite(spikeHighPrice) || spikeHighPrice <= 0) {
      throw new Error('Missing spike_high for SELL trade')
    }
    if (spikeHighPrice <= markPrice) {
      throw new Error(
        `Invalid spike_high ${spikeHighPrice} for ${symbol}: must be above market ${markPrice.toFixed(8)} before entry`,
      )
    }
  }

  const effectiveNotionalUsd = tradeSizeUsd * appliedLeverage
  if (spec.minNotional > 0 && effectiveNotionalUsd < spec.minNotional) {
    throw new Error(
      `Order notional too small for ${symbol}. Required min notional ${spec.minNotional} USDT, got ${effectiveNotionalUsd.toFixed(4)} USDT.`,
    )
  }
  const rawQty = effectiveNotionalUsd / markPrice
  let qty = quantizeToStep(rawQty, spec.stepSize, 'floor')
  if (!Number.isFinite(qty) || qty <= 0 || qty < spec.minQty) {
    throw new Error(`tradeSizeUsd × leverage is too small for ${symbol}. Minimum quantity is ${spec.minQty}.`)
  }
  const minN = spec.minNotional
  if (minN > 0) {
    const step = spec.stepSize
    const estNotional = (q) => q * markPrice
    let units = Math.floor(qty / step + 1e-10)
    let bumpSteps = 0
    const maxBumpSteps = 1_000_000
    while (estNotional(units * step) < minN - 1e-10 && bumpSteps < maxBumpSteps) {
      units += 1
      bumpSteps += 1
    }
    qty = quantizeToStep(units * step, step, 'round')
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Could not size quantity for ${symbol} after min-notional adjustment.`)
    }
    if (minN > 0 && estNotional(qty) < minN - 1e-10) {
      throw new Error(
        `After lot-size rounding, notional ~${estNotional(qty).toFixed(4)} USDT is below Binance minimum ${minN} for ${symbol}. Increase margin × leverage.`,
      )
    }
    if (qty < spec.minQty) {
      throw new Error(
        `Min-notional sizing for ${symbol} needs qty ${qty}, below exchange minQty ${spec.minQty}. Increase margin × leverage.`,
      )
    }
    if (bumpSteps > 0) {
      warnings.push(
        `Raised quantity by ${bumpSteps} lot step(s) so notional meets exchange minimum ${minN} USDT (floor qty would have been below min notional).`,
      )
    }
  }
  const quantity = fmtByStep(qty, spec.stepSize, spec.quantityPrecision)

  const entryOrderParams = {
    symbol,
    side,
    type: 'MARKET',
    quantity,
    newOrderRespType: 'RESULT',
  }
  if (isHedgeMode) entryOrderParams.positionSide = entryPositionSide
  const entryOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/order', entryOrderParams)

  let entryPrice = Number.parseFloat(String(entryOrder?.avgPrice ?? ''))
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    const risk = await fetchPositionRisk(apiKey, apiSecret)
    const row = Array.isArray(risk)
      ? risk.find((p) => {
          if (String(p?.symbol ?? '') !== symbol) return false
          if (Math.abs(parseFloat(String(p?.positionAmt ?? '0'))) <= 0) return false
          if (isHedgeMode && String(p?.positionSide ?? '').toUpperCase() !== entryPositionSide) return false
          return true
        })
      : null
    const rp = Number.parseFloat(String(row?.entryPrice ?? ''))
    entryPrice = Number.isFinite(rp) && rp > 0 ? rp : markPrice
  }

  await sleep(280)

  const exitSide = side === 'BUY' ? 'SELL' : 'BUY'
  let effectiveTpPct = tpPct
  let effectiveSlPct = slPct
  if (side === 'BUY' && Number.isFinite(spikeLowPrice) && spikeLowPrice > 0) {
    const calcSlPct = ((entryPrice - spikeLowPrice) / entryPrice) * 100
    if (Number.isFinite(calcSlPct) && calcSlPct > 0) {
      effectiveSlPct = Math.min(calcSlPct, slPct)
      const rawTpPct = effectiveSlPct * 2
      effectiveTpPct = Math.min(rawTpPct, tpPct)
      if (calcSlPct > slPct) {
        warnings.push(`SL capped by setting: calc ${calcSlPct.toFixed(3)}% -> max ${slPct.toFixed(3)}%`)
      }
      if (rawTpPct > tpPct) {
        warnings.push(`TP capped by setting: calc ${rawTpPct.toFixed(3)}% -> max ${tpPct.toFixed(3)}%`)
      }
    } else {
      try {
        await closeFuturesMarketReduceOnlyBestEffort({
          apiKey,
          apiSecret,
          symbol,
          entrySide: side,
          entryPositionSide,
          isHedgeMode,
          spec,
          fallbackQuantityStr: quantity,
        })
      } catch (e) {
        warnings.push(`Emergency flatten failed (spike_low not below entry): ${e instanceof Error ? e.message : String(e)}`)
      }
      throw new Error(
        `Spike low ${spikeLowPrice} is not below entry ${entryPrice} for ${symbol}; position flattened if possible.`,
      )
    }
  }
  if (side === 'SELL' && Number.isFinite(spikeHighPrice) && spikeHighPrice > 0) {
    const calcSlPct = ((spikeHighPrice - entryPrice) / entryPrice) * 100
    if (Number.isFinite(calcSlPct) && calcSlPct > 0) {
      effectiveSlPct = Math.min(calcSlPct, slPct)
      const rawTpPct = effectiveSlPct * 2
      effectiveTpPct = Math.min(rawTpPct, tpPct)
      if (calcSlPct > slPct) {
        warnings.push(`SL capped by setting: calc ${calcSlPct.toFixed(3)}% -> max ${slPct.toFixed(3)}%`)
      }
      if (rawTpPct > tpPct) {
        warnings.push(`TP capped by setting: calc ${rawTpPct.toFixed(3)}% -> max ${tpPct.toFixed(3)}%`)
      }
    } else {
      try {
        await closeFuturesMarketReduceOnlyBestEffort({
          apiKey,
          apiSecret,
          symbol,
          entrySide: side,
          entryPositionSide,
          isHedgeMode,
          spec,
          fallbackQuantityStr: quantity,
        })
      } catch (e) {
        warnings.push(`Emergency flatten failed (spike_high not above entry): ${e instanceof Error ? e.message : String(e)}`)
      }
      throw new Error(
        `Spike high ${spikeHighPrice} is not above entry ${entryPrice} for ${symbol}; position flattened if possible.`,
      )
    }
  }
  const tpPriceRaw = side === 'BUY'
    ? entryPrice * (1 + effectiveTpPct / 100)
    : entryPrice * (1 - effectiveTpPct / 100)
  const slPriceRaw = side === 'BUY'
    ? entryPrice * (1 - effectiveSlPct / 100)
    : entryPrice * (1 + effectiveSlPct / 100)
  const tpMode = side === 'BUY' ? 'ceil' : 'floor'
  const slMode = side === 'BUY' ? 'floor' : 'ceil'
  let tpPriceNum = quantizeToStep(tpPriceRaw, spec.tickSize, tpMode)
  let slPriceNum = quantizeToStep(slPriceRaw, spec.tickSize, slMode)
  if (!Number.isFinite(tpPriceNum) || tpPriceNum <= 0 || !Number.isFinite(slPriceNum) || slPriceNum <= 0) {
    throw new Error('Computed TP/SL prices are invalid for this symbol tick size.')
  }
  const bracket = enforceExitBracketAgainstEntry({
    side,
    entryPrice,
    tpPriceNum,
    slPriceNum,
    tickSize: spec.tickSize,
  })
  if (bracket.adjusted) {
    warnings.push(
      'TP/SL nudged vs fill price so each trigger sits at least one tick on the correct side of entry (exchange requirement).',
    )
  }
  tpPriceNum = bracket.tpPriceNum
  slPriceNum = bracket.slPriceNum
  if (!bracket.ok) {
    try {
      await closeFuturesMarketReduceOnlyBestEffort({
        apiKey,
        apiSecret,
        symbol,
        entrySide: side,
        entryPositionSide,
        isHedgeMode,
        spec,
        fallbackQuantityStr: quantity,
      })
    } catch (e) {
      warnings.push(`Emergency flatten failed (invalid bracket): ${e instanceof Error ? e.message : String(e)}`)
    }
    throw new Error(
      `Invalid TP/SL bracket vs entry ${entryPrice} for ${symbol} after tick rounding. Position flattened if possible.`,
    )
  }
  const tpPrice = fmtByStep(tpPriceNum, spec.tickSize, spec.pricePrecision)
  const slPrice = fmtByStep(slPriceNum, spec.tickSize, spec.pricePrecision)
  const tpPriceCheck = Number.parseFloat(tpPrice)
  const slPriceCheck = Number.parseFloat(slPrice)
  if (!(tpPriceCheck > 0) || !(slPriceCheck > 0)) {
    try {
      await closeFuturesMarketReduceOnlyBestEffort({
        apiKey,
        apiSecret,
        symbol,
        entrySide: side,
        entryPositionSide,
        isHedgeMode,
        spec,
        fallbackQuantityStr: quantity,
      })
    } catch (e) {
      warnings.push(`Emergency flatten failed (non-positive trigger price): ${e instanceof Error ? e.message : String(e)}`)
    }
    throw new Error(
      `TP/SL trigger rounded to non-positive value (TP=${tpPrice}, SL=${slPrice}) for ${symbol}. Position flattened if possible.`,
    )
  }

  let tpOrder = null
  let slOrder = null
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
  const maxProtAttempts = 5
  let lastTpErr = null
  let lastSlErr = null
  for (let attempt = 0; attempt < maxProtAttempts && (!tpOrder || !slOrder); attempt++) {
    if (attempt > 0) await sleep(360)
    if (!tpOrder) {
      try {
        tpParams.triggerPrice = tpPrice
        tpOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/algoOrder', tpParams)
      } catch (e) {
        lastTpErr = e instanceof Error ? e : new Error(String(e))
      }
    }
    if (!slOrder) {
      try {
        slParams.triggerPrice = slPrice
        slOrder = await signedFuturesJsonPost(apiKey, apiSecret, '/fapi/v1/algoOrder', slParams)
      } catch (e) {
        lastSlErr = e instanceof Error ? e : new Error(String(e))
      }
    }
  }
  if (!tpOrder || !slOrder) {
    const detail = [
      !tpOrder && lastTpErr ? `TP: ${lastTpErr.message}` : null,
      !slOrder && lastSlErr ? `SL: ${lastSlErr.message}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    warnings.push(`Protection incomplete after ${maxProtAttempts} attempts: ${detail}`)
    try {
      await closeFuturesMarketReduceOnlyBestEffort({
        apiKey,
        apiSecret,
        symbol,
        entrySide: side,
        entryPositionSide,
        isHedgeMode,
        spec,
        fallbackQuantityStr: quantity,
      })
      warnings.push(`Emergency market close sent for ${symbol} (avoid naked position without TP/SL).`)
    } catch (e) {
      warnings.push(`CRITICAL: market close failed for ${symbol}: ${e instanceof Error ? e.message : String(e)}`)
    }
    throw new Error(
      `TP/SL not placed after entry (${detail || 'unknown'}). Position should be flat — verify on Binance immediately.`,
    )
  }
  addDebug('finish', { protectionPlaced: Boolean(tpOrder && slOrder), warningsCount: warnings.length })

  return {
    symbol,
    side,
    positionMode: isHedgeMode ? 'HEDGE' : 'ONE_WAY',
    positionSide: isHedgeMode ? entryPositionSide : 'BOTH',
    requestedLeverage,
    appliedLeverage,
    tradeSizeUsd,
    effectiveNotionalUsd,
    quantity,
    entryPrice,
    effectiveTpPct,
    effectiveSlPct,
    spikeLowPrice,
    spikeHighPrice,
    tpPrice,
    slPrice,
    entryOrder,
    tpOrder,
    slOrder,
    protectionPlaced: Boolean(tpOrder && slOrder),
    supportedOrderTypes: spec.orderTypes,
    warnings,
    debug: debug ? { timeline } : undefined,
    fetchedAt: new Date().toISOString(),
  }
}

function parseBinanceDecimal(v) {
  const n = Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

/** `availableBalance / totalWalletBalance` × 100 from `/fapi/v2/account` (same basis as execution headroom). */
function marginAvailablePctFromFuturesAccount(acc) {
  if (!acc || typeof acc !== 'object') {
    return { availableBalanceUsdt: null, marginAvailablePct: null }
  }
  const totalWallet = parseBinanceDecimal(acc.totalWalletBalance)
  const available = parseBinanceDecimal(acc.availableBalance)
  if (!Number.isFinite(available)) {
    return { availableBalanceUsdt: null, marginAvailablePct: null }
  }
  if (!Number.isFinite(totalWallet) || totalWallet <= 0) {
    return { availableBalanceUsdt: available, marginAvailablePct: null }
  }
  return {
    availableBalanceUsdt: available,
    marginAvailablePct: (available / totalWallet) * 100,
  }
}

/**
 * USDT-M futures wallet (USDT) — Binance sometimes omits or zeros
 * totalWalletBalance; fall back to assets[] then /fapi/v2/balance.
 * @param {object | null} [preloadedAccount] — optional `/fapi/v2/account` JSON to avoid a duplicate request.
 */
async function getFuturesUsdtWalletTotal(apiKey, apiSecret, preloadedAccount = null) {
  const acc =
    preloadedAccount && typeof preloadedAccount === 'object'
      ? preloadedAccount
      : await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
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

/** One `/fapi/v2/account` pull: account-level + USDT asset fields used to compare wallet vs margin vs uPnL. */
async function fetchFuturesBalanceBreakdown(apiKey, apiSecret) {
  const acc = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
  const sizingWalletUsd = await getFuturesUsdtWalletTotal(apiKey, apiSecret, acc)
  const ACCOUNT_FIELDS = [
    'totalWalletBalance',
    'totalUnrealizedProfit',
    'totalMarginBalance',
    'totalCrossWalletBalance',
    'totalCrossUnPnl',
    'availableBalance',
    'maxWithdrawAmount',
    'totalInitialMargin',
    'totalMaintMargin',
    'totalPositionInitialMargin',
    'totalOpenOrderInitialMargin',
  ]
  const account = {}
  for (const k of ACCOUNT_FIELDS) {
    account[k] = parseBinanceDecimal(acc[k])
  }
  let usdtAsset = null
  const usdt = Array.isArray(acc.assets) ? acc.assets.find((a) => a.asset === 'USDT') : null
  if (usdt) {
    const USDT_FIELDS = [
      'walletBalance',
      'unrealizedProfit',
      'marginBalance',
      'crossWalletBalance',
      'crossUnPnl',
      'availableBalance',
      'maxWithdrawAmount',
      'positionInitialMargin',
      'openOrderInitialMargin',
      'initialMargin',
    ]
    usdtAsset = {}
    for (const k of USDT_FIELDS) {
      usdtAsset[k] = parseBinanceDecimal(usdt[k])
    }
  }
  return {
    account,
    usdtAsset,
    sizingWalletUsd,
    sizingNote:
      'Agent % sizing uses getFuturesUsdtWalletTotal: totalWalletBalance when non-zero, else USDT asset walletBalance → crossWalletBalance → marginBalance, else /fapi/v2/balance.',
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Policy: do not open new trades when free margin is tight vs wallet.
 * Blocks when `availableBalance / totalWalletBalance` ≤ threshold.
 * Uses `minAvailableWalletPct` from agent settings (0–100; 0 disables). When the DB value is null
 * before migration, normalization falls back to `FUTURES_MIN_AVAILABLE_WALLET_PCT` (default 30).
 */
async function checkFuturesWalletHeadroomForNewTrades(
  apiKey,
  apiSecret,
  pushLog,
  agentLabel,
  minAvailableWalletPct,
) {
  const minPct = Number.isFinite(Number(minAvailableWalletPct))
    ? Math.min(100, Math.max(0, Math.floor(Number(minAvailableWalletPct))))
    : envFallbackMinAvailableWalletPct()
  if (minPct === 0) return { allow: true }

  const acc = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
  const totalWallet = parseBinanceDecimal(acc.totalWalletBalance)
  const available = parseBinanceDecimal(acc.availableBalance)
  if (!Number.isFinite(totalWallet) || totalWallet <= 0) {
    pushLog?.(
      'warn',
      `${agentLabel}: wallet headroom skipped — invalid totalWalletBalance (fail-open)`,
    )
    return { allow: true }
  }
  if (!Number.isFinite(available)) {
    pushLog?.(
      'warn',
      `${agentLabel}: wallet headroom skipped — invalid availableBalance (fail-open)`,
    )
    return { allow: true }
  }
  const ratioPct = (available / totalWallet) * 100
  if (ratioPct <= minPct + 1e-9) {
    pushLog?.(
      'warn',
      `${agentLabel}: skip new trades — available ${ratioPct.toFixed(2)}% of wallet (≤ ${minPct}% policy; available ${available.toFixed(4)} / wallet ${totalWallet.toFixed(4)} USDT)`,
    )
    return { allow: false, available, totalWallet, ratioPct, minPct }
  }
  return { allow: true, available, totalWallet, ratioPct, minPct }
}

/**
 * Margin used per order: fixed tradeSizeUsd, or wallet × tradeSizeWalletPct/100 when pct > 0.
 * @returns {{ marginUsd: number, usesPctSizing: boolean }}
 */
function computeAgentTradeMarginUsdFromWallet(settings, walletUsdt, pushLog) {
  const fixed = Number(settings.tradeSizeUsd)
  const pct = Number(settings.tradeSizeWalletPct)
  const log = typeof pushLog === 'function' ? pushLog : () => {}
  if (!Number.isFinite(fixed) || fixed <= 0) {
    throw new Error('tradeSizeUsd must be a positive number')
  }
  if (!Number.isFinite(pct) || pct <= 0) {
    return { marginUsd: fixed, usesPctSizing: false }
  }
  const wallet = Number(walletUsdt)
  if (!Number.isFinite(wallet) || wallet <= 0) {
    log('warn', 'Trade size %: futures USDT wallet unavailable; using fixed USDT margin')
    return { marginUsd: fixed, usesPctSizing: false }
  }
  const fromPct = (wallet * pct) / 100
  if (!Number.isFinite(fromPct) || fromPct < 0.01) {
    log(
      'warn',
      `Trade size %: computed margin ${fromPct.toFixed(4)} USDT is below minimum; using fixed USDT margin`,
    )
    return { marginUsd: fixed, usesPctSizing: false }
  }
  log(
    'info',
    `Trade size %: using ${fromPct.toFixed(4)} USDT margin (${pct}% of ${wallet.toFixed(2)} USDT wallet)`,
  )
  return { marginUsd: fromPct, usesPctSizing: true }
}

/** When tradeSizeWalletPct > 0, margin = wallet × pct/100; otherwise fixed tradeSizeUsd. */
async function resolveAgentTradeMarginUsd(settings, apiKey, apiSecret, pushLog) {
  const fixed = Number(settings.tradeSizeUsd)
  const pct = Number(settings.tradeSizeWalletPct)
  if (!Number.isFinite(fixed) || fixed <= 0) {
    throw new Error('tradeSizeUsd must be a positive number')
  }
  if (!Number.isFinite(pct) || pct <= 0) {
    return fixed
  }
  try {
    const wallet = await getFuturesUsdtWalletTotal(apiKey, apiSecret)
    return computeAgentTradeMarginUsdFromWallet(settings, wallet, pushLog).marginUsd
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pushLog?.('warn', `Trade size %: ${msg}; using fixed USDT margin`)
    return fixed
  }
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

initAgent2Context({
  supabaseRest,
  futuresBase: FUTURES_BASE,
  postSigned: signedFuturesJsonPost,
  getSigned: signedFuturesJson,
  deleteSigned: signedFuturesJsonDelete,
  normalizeSymbol: normalizeUsdtFuturesSymbol,
  getSymbolSpec,
  quantizeToStep,
  fmtByStep,
  toNum,
  sleep,
  fetchPositionMode,
  fetchPositionRisk,
  fetchMaxLeverageForSymbol,
  parseMaxLeverageFromBinanceError,
  enforceExitBracketAgainstEntry,
  buildAgentTradePositionKey,
  normalizePositionSideForKey,
  fetchTradeCloseAccounting: fetchAgentTradeCloseAccounting,
})

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
    return res.json({
      settings,
      binanceAccountColumnReadable: agent1BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
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
    return res.json({
      ok: true,
      settings,
      binanceAccountColumnReadable: agent1BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
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
    return res.json({
      ok: true,
      settings,
      binanceAccountColumnReadable: agent1BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
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

app.patch('/api/agents/agent1/ema-gate', async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include enabled: boolean' })
    }
    const current = await readAgent1Settings()
    const { updatedAt: _upd, ...rest } = current
    const settings = await upsertAgent1Settings({
      ...rest,
      emaGateEnabled: req.body.enabled,
    })
    return res.json({
      ok: true,
      settings,
      binanceAccountColumnReadable: agent1BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to update Agent 1 EMA gate flag',
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

app.get('/api/agents/agent1/shadow-curve', async (_req, res) => {
  try {
    if (canUseShadowDbCoordination() && !agent1ShadowLeaseOwner) {
      await maybeHydrateAgent1ShadowSnapshot()
    }
    const snap = getAgent1ShadowSnapshot()
    res.json({
      ...snap,
      shadowSchedulerActive: process.env.AGENT1_SHADOW_SCHEDULER !== 'false',
    })
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load shadow curve',
    })
  }
})

app.get('/api/agents/agent1/shadow-sim-config', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      const pack = defaultShadowSimConfigPack()
      return res.json({
        configKey: pack.configKey,
        updatedAt: pack.updatedAt,
        fromDb: false,
        long: pack.long,
        short: pack.short,
        warning: 'Supabase not configured; values are code defaults only',
      })
    }
    const pack = await loadAgent1ShadowSimConfigFromDbCached({ force: false })
    res.json({
      configKey: pack.configKey,
      updatedAt: pack.updatedAt,
      fromDb: pack.fromDb,
      long: pack.long,
      short: pack.short,
    })
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load shadow sim config',
    })
  }
})

app.patch('/api/agents/agent1/shadow-sim-config', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const body = req.body
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' })
    }
    const cur = await loadAgent1ShadowSimConfigFromDbCached({ force: true })
    const { long, short } = mergeShadowSimConfigPatch(body, cur.long, cur.short)
    assertValidShadowSimBases(long, short)
    const row = shadowSimBasesToDbRow(SHADOW_SIM_CONFIG_KEY, long, short)
    await supabaseRest('/rest/v1/agent1_shadow_sim_config?on_conflict=config_key&select=*', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(row),
    })
    bustShadowSimConfigCache()
    const pack = await loadAgent1ShadowSimConfigFromDbCached({ force: true })
    return res.json({
      ok: true,
      configKey: pack.configKey,
      updatedAt: pack.updatedAt,
      fromDb: pack.fromDb,
      long: pack.long,
      short: pack.short,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to update shadow sim config'
    const isVal = /required|must be|JSON/i.test(msg)
    return res.status(isVal ? 400 : 500).json({ error: msg })
  }
})

app.patch('/api/agents/agent1/shadow-simulation', async (req, res) => {
  try {
    if (typeof req.body?.paused !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include paused: boolean' })
    }
    if (process.env.AGENT1_SHADOW_SCHEDULER === 'false') {
      return res.status(400).json({
        error:
          'Shadow scheduler is off in server config (AGENT1_SHADOW_SCHEDULER=false). Remove it or set to true and restart to run simulation.',
      })
    }
    const paused = req.body.paused
    setAgent1ShadowSimulationPaused(paused)
    if (canUseShadowDbCoordination()) {
      try {
        const existing = await loadAgent1ShadowSnapshotFromDb()
        const base = existing || getAgent1ShadowSnapshot()
        await persistAgent1ShadowSnapshot({ ...base, simulationPaused: paused })
      } catch (e) {
        console.error('[agent1-shadow] persist simulationPaused failed', e)
      }
    }
    return res.json({
      ok: true,
      simulationPaused: getAgent1ShadowSimulationPaused(),
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to update shadow simulation',
    })
  }
})

app.patch('/api/agents/agent1/shadow-sim-params', async (req, res) => {
  try {
    if (process.env.AGENT1_SHADOW_SCHEDULER === 'false') {
      return res.status(400).json({
        error:
          'Shadow scheduler is off in server config (AGENT1_SHADOW_SCHEDULER=false). Set it true and restart to run simulation.',
      })
    }
    const body = req.body
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' })
    }
    patchShadowSimRuntimeOverrides(body)
    const snap = getAgent1ShadowSnapshot()
    if (canUseShadowDbCoordination()) {
      try {
        const existing = await loadAgent1ShadowSnapshotFromDb()
        const base = existing && typeof existing === 'object' ? existing : snap
        await persistAgent1ShadowSnapshot({
          ...base,
          shadowSimRuntimeOverrides: snap.shadowSimRuntimeOverrides,
          simulationPaused: getAgent1ShadowSimulationPaused(),
        })
      } catch (e) {
        console.error('[agent1-shadow] persist shadow-sim-params failed', e)
      }
    }
    return res.json({
      ok: true,
      shadowSimRuntimeOverrides: snap.shadowSimRuntimeOverrides,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to update shadow sim params'
    const isVal = /required|must be/i.test(msg)
    return res.status(isVal ? 400 : 500).json({ error: msg })
  }
})

app.get('/api/agents/agent1/regime', async (_req, res) => {
  try {
    if (canUseShadowDbCoordination() && !agent1ShadowLeaseOwner) {
      await maybeHydrateAgent1ShadowSnapshot()
    }
    const snap = getAgent1ShadowSnapshot()
    res.json({
      regime: snap.regime ?? null,
      regimeAgent3: snap.regimeAgent3 ?? null,
      updatedAt: snap.updatedAt ?? null,
      simUpdatedAt: snap.simUpdatedAt ?? null,
      markUpdatedAt: snap.markUpdatedAt ?? null,
      scheduler: snap.scheduler ?? null,
    })
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load regime snapshot',
    })
  }
})

/**
 * Agent 3 short-leg regime only — same in-memory snapshot as the A1/A3 shadow simulation (Long Sim).
 * `regime` is `regimeAgent3` from `runAgent1ShadowTickOnce` (cumulative short Σ% vs EMA on the short live curve).
 */
app.get('/api/agents/agent3/regime', async (_req, res) => {
  try {
    if (canUseShadowDbCoordination() && !agent1ShadowLeaseOwner) {
      await maybeHydrateAgent1ShadowSnapshot()
    }
    const snap = getAgent1ShadowSnapshot()
    res.json({
      regime: snap.regimeAgent3 ?? null,
      updatedAt: snap.updatedAt ?? null,
      simUpdatedAt: snap.simUpdatedAt ?? null,
      markUpdatedAt: snap.markUpdatedAt ?? null,
      scheduler: snap.scheduler ?? null,
    })
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load Agent 3 regime snapshot',
    })
  }
})

/**
 * Cumulative net PnL (USDT) over the last N Agent 1 closed rows (DB only — not whole Binance account).
 * Query: limit ≤ 1000 (default 1000). On-demand; not polled by the execution bundle.
 */
app.get('/api/agents/agent1/closed-trades-pnl-curve', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const limRaw = req.query?.limit
    const limitRequested = Math.min(1000, Math.max(1, parseInt(String(limRaw ?? '1000'), 10) || 1000))
    const raw = await listAgent1ClosedTradesForPnlCurve(limitRequested)
    const chrono = [...raw].sort((a, b) => {
      const da = new Date(a.closed_at).getTime()
      const db = new Date(b.closed_at).getTime()
      if (da !== db) return da - db
      return String(a.id ?? '').localeCompare(String(b.id ?? ''))
    })
    let cum = 0
    const points = []
    for (const r of chrono) {
      const net = agent1ClosedTradeNetPnlUsdt(r)
      cum += net
      points.push({
        id: r.id,
        symbol: r.symbol,
        openedAt: r.opened_at ?? null,
        closedAt: r.closed_at,
        netPnlUsdt: net,
        cumPnlUsdt: cum,
      })
    }
    res.json({
      tradesInCurve: chrono.length,
      limitRequested,
      points,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load Agent 1 closed PnL curve',
    })
  }
})

app.get('/api/agents/agent1/execution', async (_req, res) => {
  try {
    const regimeSnap = getAgent1ShadowSnapshot()?.regime ?? null
    let openTrades = []
    let closedTrades = []
    let logs = agent1ExecutionLogs.slice(-100).reverse()
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      openTrades = await listAgent1TradeRecords('open', 100)
      closedTrades = await listAgent1TradeRecords('closed', 100)
      const dbLogs = await listAgent1ExecutionLogRows(100)
      if (dbLogs.length > 0) {
        logs = dbLogs.map((r) => ({
          at: r.logged_at ?? r.created_at ?? null,
          level: r.level ?? 'info',
          msg: r.message ?? '',
        }))
      }
    }

    let openPositionMap = new Map()
    let a1Settings = normalizeAgent1Settings({})
    try {
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        a1Settings = await readAgent1Settings()
      }
    } catch {
      a1Settings = normalizeAgent1Settings({})
    }
    const { apiKey, apiSecret } = resolveBinanceCredentials(a1Settings.binanceAccount)
    if (apiKey && apiSecret) {
      try {
        const all = await fetchPositionRisk(apiKey, apiSecret)
        openPositionMap = openPositionRowMapFromRiskRows(Array.isArray(all) ? all : [])
      } catch {
        // keep DB-only view if Binance call fails
      }
    }
    const ongoing = openTrades.map((t) => {
      const row = openPositionMap.get(buildAgentTradePositionKey(t.symbol, t.position_side))
      return {
        ...t,
        positionAmt: row?.positionAmt ?? null,
        markPrice: row?.markPrice ?? null,
        unRealizedProfit: row?.unRealizedProfit ?? null,
      }
    })

    res.json({
      state: agent1ExecutionState,
      regime: regimeSnap,
      logs,
      ongoingTrades: ongoing,
      closedTrades,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load agent1 execution state',
    })
  }
})

/** Futures wallet + open-position unrealized PnL for the Agent 1 `binance_account` setting. */
app.get('/api/agents/agent1/account-metrics', async (_req, res) => {
  try {
    let settings = normalizeAgent1Settings({})
    try {
      settings = await readAgent1Settings()
    } catch {
      settings = normalizeAgent1Settings({})
    }
    const { apiKey, apiSecret, accountId } = resolveBinanceCredentials(settings.binanceAccount)
    if (!apiKey || !apiSecret) {
      return res.status(503).json({
        error: `Binance API keys not configured for account "${accountId}"`,
      })
    }
    const acc = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
    const { availableBalanceUsdt, marginAvailablePct } = marginAvailablePctFromFuturesAccount(acc)
    const [futuresWalletUsdt, risk] = await Promise.all([
      getFuturesUsdtWalletTotal(apiKey, apiSecret, acc),
      fetchPositionRisk(apiKey, apiSecret),
    ])
    const rows = Array.isArray(risk) ? risk : []
    const open = rows.filter((p) => Math.abs(parseFloat(String(p?.positionAmt ?? '0'))) > 0)
    let unrealizedPnlUsdt = 0
    for (const p of open) {
      const u = parseFloat(String(p?.unRealizedProfit ?? ''))
      if (Number.isFinite(u)) unrealizedPnlUsdt += u
    }
    const { marginUsd: tradeMarginUsd, usesPctSizing: tradeMarginUsesPctSizing } =
      computeAgentTradeMarginUsdFromWallet(settings, futuresWalletUsdt, () => {})
    const pct = Number(settings.tradeSizeWalletPct)
    const fixedUsd = Number(settings.tradeSizeUsd)
    const tradeMarginDetail =
      !Number.isFinite(pct) || pct <= 0
        ? 'Fixed margin'
        : tradeMarginUsesPctSizing
          ? `${pct}% of USDT-M wallet`
          : `Using fixed ${Number.isFinite(fixedUsd) ? fixedUsd.toFixed(2) : '—'} USDT (pct sizing unavailable)`
    res.json({
      binanceAccount: accountId,
      futuresWalletUsdt,
      availableBalanceUsdt,
      marginAvailablePct,
      openPositionCount: open.length,
      unrealizedPnlUsdt,
      tradeSizeUsd: settings.tradeSizeUsd,
      tradeSizeWalletPct: settings.tradeSizeWalletPct,
      tradeMarginUsd,
      tradeMarginUsesPctSizing,
      tradeMarginDetail,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load futures account metrics',
    })
  }
})

/** Futures wallet + sizing preview for Agent 3 `binance_account` (same shape as Agent 1). */
app.get('/api/agents/agent3/account-metrics', async (_req, res) => {
  let accountId = 'master'
  try {
    let settings = normalizeAgent3Settings({})
    try {
      settings = await readAgent3Settings()
    } catch {
      settings = normalizeAgent3Settings({})
    }
    const creds = resolveBinanceCredentials(settings.binanceAccount)
    accountId = creds.accountId
    const { apiKey, apiSecret } = creds
    if (!apiKey || !apiSecret) {
      return res.status(503).json({
        error: `Binance API keys not configured for account "${accountId}"`,
        binanceAccount: accountId,
      })
    }
    const acc = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
    const { availableBalanceUsdt, marginAvailablePct } = marginAvailablePctFromFuturesAccount(acc)
    const [futuresWalletUsdt, risk] = await Promise.all([
      getFuturesUsdtWalletTotal(apiKey, apiSecret, acc),
      fetchPositionRisk(apiKey, apiSecret),
    ])
    const rows = Array.isArray(risk) ? risk : []
    const open = rows.filter((p) => Math.abs(parseFloat(String(p?.positionAmt ?? '0'))) > 0)
    let unrealizedPnlUsdt = 0
    for (const p of open) {
      const u = parseFloat(String(p?.unRealizedProfit ?? ''))
      if (Number.isFinite(u)) unrealizedPnlUsdt += u
    }
    const { marginUsd: tradeMarginUsd, usesPctSizing: tradeMarginUsesPctSizing } =
      computeAgentTradeMarginUsdFromWallet(settings, futuresWalletUsdt, () => {})
    const pct = Number(settings.tradeSizeWalletPct)
    const fixedUsd = Number(settings.tradeSizeUsd)
    const tradeMarginDetail =
      !Number.isFinite(pct) || pct <= 0
        ? 'Fixed margin'
        : tradeMarginUsesPctSizing
          ? `${pct}% of USDT-M wallet`
          : `Using fixed ${Number.isFinite(fixedUsd) ? fixedUsd.toFixed(2) : '—'} USDT (pct sizing unavailable)`
    res.json({
      binanceAccount: accountId,
      futuresWalletUsdt,
      availableBalanceUsdt,
      marginAvailablePct,
      openPositionCount: open.length,
      unrealizedPnlUsdt,
      tradeSizeUsd: settings.tradeSizeUsd,
      tradeSizeWalletPct: settings.tradeSizeWalletPct,
      tradeMarginUsd,
      tradeMarginUsesPctSizing,
      tradeMarginDetail,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : 'Failed to load futures account metrics'
    let hint = ''
    if (/invalid api-key|-2015|401/i.test(errMsg)) {
      if (accountId === 'sub1') {
        hint =
          ' For sub1, set BINANCE_SUB1_API_KEY and BINANCE_SUB1_API_SECRET in the server .env (not the browser), enable Futures on the key, match BINANCE_USE_TESTNET to the key type, and check IP restrictions.'
      } else if (accountId === 'sub2') {
        hint =
          ' For sub2, set BINANCE_SUB2_API_KEY and BINANCE_SUB2_API_SECRET in the server .env, enable Futures on the key, match BINANCE_USE_TESTNET to the key type, and check IP restrictions.'
      } else {
        hint =
          ' For master, set BINANCE_API_KEY / BINANCE_API_SECRET (or BINANCE_MASTER_*), enable Futures on the key, match BINANCE_USE_TESTNET to the key type, and check IP restrictions.'
      }
      if (!agent3BinanceAccountColumnReadable) {
        hint +=
          ' Also run supabase/agent_settings_binance_account.sql: without binance_account in the DB, Agent 3 may still be using master while the UI shows a sub-account.'
      }
    }
    res.status(502).json({
      error: hint ? `${errMsg}${hint}` : errMsg,
      binanceAccount: accountId,
    })
  }
})

/**
 * Cumulative net PnL (USDT) over the last N Agent 3 closed rows (`agent3_trades` only).
 */
app.get('/api/agents/agent3/closed-trades-pnl-curve', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const limRaw = req.query?.limit
    const limitRequested = Math.min(1000, Math.max(1, parseInt(String(limRaw ?? '1000'), 10) || 1000))
    const n = Math.min(1000, Math.max(1, Math.floor(limitRequested) || 1000))
    const rows = await supabaseRest(
      `/rest/v1/agent3_trades?select=id,symbol,opened_at,closed_at,realized_pnl_usdt,commission_usdt,funding_fee_usdt&status=eq.closed&order=closed_at.desc&limit=${n}`,
    )
    const raw = Array.isArray(rows) ? rows.filter((r) => r && r.closed_at) : []
    const chrono = [...raw].sort((a, b) => {
      const da = new Date(a.closed_at).getTime()
      const db = new Date(b.closed_at).getTime()
      if (da !== db) return da - db
      return String(a.id ?? '').localeCompare(String(b.id ?? ''))
    })
    let cum = 0
    const points = []
    for (const r of chrono) {
      const net = agent1ClosedTradeNetPnlUsdt(r)
      cum += net
      points.push({
        id: r.id,
        symbol: r.symbol,
        openedAt: r.opened_at ?? null,
        closedAt: r.closed_at,
        netPnlUsdt: net,
        cumPnlUsdt: cum,
      })
    }
    res.json({
      tradesInCurve: chrono.length,
      limitRequested,
      points,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load Agent 3 closed PnL curve',
    })
  }
})

app.get('/api/agents/agent3/settings', async (_req, res) => {
  try {
    const settings = await readAgent3Settings()
    return res.json({
      settings,
      binanceAccountColumnReadable: agent3BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load Agent 3 settings',
    })
  }
})

app.put('/api/agents/agent3/settings', async (req, res) => {
  try {
    const body = req.body ?? {}
    const current = await readAgent3Settings()
    const merged = { ...current, ...body }
    if (typeof body.agentEnabled !== 'boolean') {
      merged.agentEnabled = current.agentEnabled
    }
    if (typeof body.scanInterval !== 'string' && typeof body.scan_interval !== 'string') {
      merged.scanInterval = current.scanInterval
    }
    const { updatedAt: _u, ...forUpsert } = merged
    const settings = await upsertAgent3Settings(forUpsert)
    return res.json({
      ok: true,
      settings,
      binanceAccountColumnReadable: agent3BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    if (e instanceof Error && /must be/i.test(e.message)) {
      return res.status(400).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to save Agent 3 settings',
    })
  }
})

app.patch('/api/agents/agent3/enabled', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include enabled: boolean' })
    }
    const current = await readAgent3Settings()
    const { updatedAt: _upd, ...rest } = current
    const settings = await upsertAgent3Settings({
      ...rest,
      agentEnabled: req.body.enabled,
    })
    return res.json({
      ok: true,
      settings,
      binanceAccountColumnReadable: agent3BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to update Agent 3 enabled flag',
    })
  }
})

app.patch('/api/agents/agent3/ema-gate', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include enabled: boolean' })
    }
    const current = await readAgent3Settings()
    const { updatedAt: _upd, ...rest } = current
    const settings = await upsertAgent3Settings({
      ...rest,
      emaGateEnabled: req.body.enabled,
    })
    return res.json({
      ok: true,
      settings,
      binanceAccountColumnReadable: agent3BinanceAccountColumnReadable,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof SupabaseConfigError) {
      return res.status(503).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to update Agent 3 EMA gate flag',
    })
  }
})

app.get('/api/agents/agent3/scan-status', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const st = agent3SchedulerState
    const settings = await readAgent3Settings()
    const enabled =
      Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) &&
      process.env.AGENT3_SCAN_SCHEDULER !== 'false'
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
    return res.status(500).json({ error: 'agent3 scan-status failed' })
  }
})

app.get('/api/agents/agent3/spikes', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const limitRaw = Number.parseInt(String(req.query.limit ?? '200'), 10)
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200))
    const rows = await supabaseRest(
      `/rest/v1/agent3_spikes?select=*&order=created_at.desc&limit=${limit}`,
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

app.patch('/api/agents/agent3/spikes/:id', async (req, res) => {
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
    const taken = req.body.tradeTaken === true
    const patchBody = taken
      ? { trade_taken: true, execution_skipped: false, skip_reason: null }
      : { trade_taken: false, execution_skipped: false, skip_reason: null }
    const rows = await supabaseRest(`/rest/v1/agent3_spikes?id=eq.${id}&select=*`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patchBody),
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

app.get('/api/agents/agent3/execution', async (_req, res) => {
  try {
    let openTrades = []
    let closedTrades = []
    let logs = agent3ExecutionLogs.slice(-100).reverse()
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      openTrades = await listAgent3TradeRecords('open', 100)
      closedTrades = await listAgent3TradeRecords('closed', 100)
      const dbLogs = await listAgent3ExecutionLogRows(100)
      if (dbLogs.length > 0) {
        logs = dbLogs.map((r) => ({
          at: r.logged_at ?? r.created_at ?? null,
          level: r.level ?? 'info',
          msg: r.message ?? '',
        }))
      }
    }
    let openPositionMap = new Map()
    let a3Settings = normalizeAgent3Settings({})
    try {
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        a3Settings = await readAgent3Settings()
      }
    } catch {
      a3Settings = normalizeAgent3Settings({})
    }
    const { apiKey, apiSecret } = resolveBinanceCredentials(a3Settings.binanceAccount)
    if (apiKey && apiSecret) {
      try {
        const all = await fetchPositionRisk(apiKey, apiSecret)
        openPositionMap = openPositionRowMapFromRiskRows(Array.isArray(all) ? all : [])
      } catch {
        // keep DB-only view if Binance call fails
      }
    }
    const ongoing = openTrades.map((t) => {
      const row = openPositionMap.get(buildAgentTradePositionKey(t.symbol, t.position_side))
      return {
        ...t,
        positionAmt: row?.positionAmt ?? null,
        markPrice: row?.markPrice ?? null,
        unRealizedProfit: row?.unRealizedProfit ?? null,
      }
    })
    res.json({
      state: agent3ExecutionState,
      logs,
      ongoingTrades: ongoing,
      closedTrades,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load agent3 execution state',
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
    const taken = req.body.tradeTaken === true
    const patchBody = taken
      ? { trade_taken: true, execution_skipped: false, skip_reason: null }
      : { trade_taken: false, execution_skipped: false, skip_reason: null }
    const rows = await supabaseRest(`/rest/v1/agent1_spikes?id=eq.${id}&select=*`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patchBody),
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

app.get('/api/agents/agent2/settings', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const settings = await readAgent2Settings()
    return res.json({ settings, fetchedAt: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to load Agent 2 settings',
    })
  }
})

app.put('/api/agents/agent2/settings', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const body = req.body ?? {}
    const current = await readAgent2Settings()
    const merged = { ...current, ...body }
    if (typeof body.agentEnabled !== 'boolean' && typeof body.agent_enabled !== 'boolean') {
      merged.agentEnabled = current.agentEnabled
    }
    if (typeof body.signalsSchedulerEnabled !== 'boolean' && typeof body.signals_scheduler_enabled !== 'boolean') {
      merged.signalsSchedulerEnabled = current.signalsSchedulerEnabled
    }
    if (typeof body.tradingEnabled !== 'boolean' && typeof body.trading_enabled !== 'boolean') {
      merged.tradingEnabled = current.tradingEnabled
    }
    const { id: _id, updatedAt: _u, ...forUpsert } = merged
    const settings = await upsertAgent2Settings(forUpsert)
    return res.json({ ok: true, settings, fetchedAt: new Date().toISOString() })
  } catch (e) {
    if (e instanceof Error && /must be/i.test(e.message)) {
      return res.status(400).json({ error: e.message })
    }
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to save Agent 2 settings',
    })
  }
})

app.patch('/api/agents/agent2/enabled', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include enabled: boolean' })
    }
    const current = await readAgent2Settings()
    const { id: _i, updatedAt: _u, ...rest } = current
    const settings = await upsertAgent2Settings({
      ...rest,
      agentEnabled: req.body.enabled,
    })
    return res.json({ ok: true, settings, fetchedAt: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Failed to update Agent 2 master switch',
    })
  }
})

app.get('/api/agents/agent2/scan-status', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const settings = await readAgent2Settings()
    const schedOn = process.env.AGENT2_SCAN_SCHEDULER !== 'false'
    return res.json({
      schedulerEnabled: schedOn,
      agentEnabled: settings.agentEnabled,
      signalsSchedulerEnabled: settings.signalsSchedulerEnabled,
      tradingEnabled: settings.tradingEnabled,
      scanInterval: settings.scanInterval,
      scanSecondsAfterClose: settings.scanSecondsAfterClose,
      nextFireAt: agent2SchedulerState.nextFireAt,
      nextFireAtIso:
        agent2SchedulerState.nextFireAt != null
          ? new Date(agent2SchedulerState.nextFireAt).toISOString()
          : null,
      lastRunAt: agent2SchedulerState.lastRunAt,
      lastSpikeCount: agent2SchedulerState.lastSpikeCount,
      lastError: agent2SchedulerState.lastError,
      running: agent2SchedulerState.running,
      scanLeaseOwner: agent2SchedulerState.scanLeaseOwner,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'agent2 scan-status failed' })
  }
})

app.post('/api/agents/agent2/scan-now', async (_req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const out = await runAgent2ScanOnce()
    return res.json({ ok: true, ...out, fetchedAt: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Agent 2 scan failed',
    })
  }
})

app.get('/api/agents/agent2/spikes', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const limitRaw = Number.parseInt(String(req.query.limit ?? '200'), 10)
    const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200))
    const rows = await supabaseRest(`/rest/v1/agent2_spikes?select=*&order=created_at.desc&limit=${limit}`)
    return res.json({ spikes: Array.isArray(rows) ? rows : [], fetchedAt: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    return res.status(502).json({ error: e instanceof Error ? e.message : 'Failed to load spikes' })
  }
})

app.get('/api/agents/agent2/entry-orders', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase not configured' })
    }
    const limitRaw = Number.parseInt(String(req.query.limit ?? '100'), 10)
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const rows = await supabaseRest(
      `/rest/v1/agent2_entry_orders?select=*&order=created_at.desc&limit=${limit}`,
    )
    return res.json({ orders: Array.isArray(rows) ? rows : [], fetchedAt: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    return res.status(502).json({ error: e instanceof Error ? e.message : 'Failed to load entry orders' })
  }
})

app.get('/api/agents/agent2/execution', async (_req, res) => {
  try {
    let logs = []
    let openTrades = []
    let closedTrades = []
    let entryOrders = []
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const dbLogs = await listAgent2ExecutionLogRows(500)
      logs = dbLogs.map((r) => ({
        at: r.logged_at ?? r.created_at ?? null,
        level: r.level ?? 'info',
        msg: r.message ?? '',
      }))
      openTrades = await supabaseRest(
        '/rest/v1/agent2_trades?select=*&status=eq.open&order=opened_at.desc&limit=200',
      )
      openTrades = Array.isArray(openTrades) ? openTrades : []
      closedTrades = await supabaseRest(
        '/rest/v1/agent2_trades?select=*&status=eq.closed&order=closed_at.desc&limit=100',
      )
      closedTrades = Array.isArray(closedTrades) ? closedTrades : []
      entryOrders = await supabaseRest(
        '/rest/v1/agent2_entry_orders?select=*&order=created_at.desc&limit=200',
      )
      entryOrders = Array.isArray(entryOrders) ? entryOrders : []
      const spikeIds = [...new Set(entryOrders.map((o) => o.spike_id).filter(Boolean))]
      if (spikeIds.length > 0) {
        const inList = spikeIds.map((id) => encodeURIComponent(String(id))).join(',')
        const spikeRows = await supabaseRest(
          `/rest/v1/agent2_spikes?id=in.(${inList})&select=id,candle_open_time_ms`,
        )
        const spikeTimeById = new Map()
        if (Array.isArray(spikeRows)) {
          for (const s of spikeRows) {
            if (s?.id != null) spikeTimeById.set(String(s.id), s.candle_open_time_ms ?? null)
          }
        }
        entryOrders = entryOrders.map((o) => ({
          ...o,
          spike_candle_open_time_ms: spikeTimeById.get(String(o.spike_id)) ?? null,
        }))
      }
    }
    let openPositionMap = new Map()
    const a2Creds = resolveBinanceCredentials(process.env.AGENT2_BINANCE_ACCOUNT ?? 'master')
    if (a2Creds.apiKey && a2Creds.apiSecret) {
      try {
        const all = await fetchPositionRisk(a2Creds.apiKey, a2Creds.apiSecret)
        openPositionMap = openPositionRowMapFromRiskRows(Array.isArray(all) ? all : [])
      } catch {
        /* */
      }
    }
    const ongoingTrades = openTrades.map((t) => {
      const row = openPositionMap.get(buildAgentTradePositionKey(t.symbol, t.position_side))
      return {
        ...t,
        positionAmt: row?.positionAmt ?? null,
        markPrice: row?.markPrice ?? null,
        unRealizedProfit: row?.unRealizedProfit ?? null,
      }
    })
    return res.json({
      state: agent2ExecutionState,
      logs,
      ongoingTrades,
      closedTrades,
      entryOrders,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to load agent2 execution',
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

/** Home / debug: full USDT-M balance breakdown (master keys) for comparing wallet vs margin vs uPnL. */
app.get('/api/binance/futures-balance-breakdown', async (_req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  try {
    const breakdown = await fetchFuturesBalanceBreakdown(apiKey, apiSecret)
    res.json(breakdown)
  } catch (e) {
    return sendBinanceRouteError(res, e)
  }
})

/** Dev check: USDT-M futures wallet using BINANCE_SUB1_* from env only (no Supabase). */
app.get('/api/test/sub1-futures-balance', async (_req, res) => {
  const { apiKey, apiSecret, accountId } = resolveBinanceCredentials('sub1')
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_SUB1_API_KEY and BINANCE_SUB1_API_SECRET in the project root .env.',
    })
  }
  try {
    const totalWalletBalanceUsdt = await getFuturesUsdtWalletTotal(apiKey, apiSecret)
    res.json({
      binanceAccount: accountId,
      totalWalletBalanceUsdt,
      futuresBase: FUTURES_BASE,
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
  try {
    const out = await placeFuturesOrderWithProtection({
      apiKey,
      apiSecret,
      symbolRaw: req.body?.symbol,
      sideRaw: req.body?.side,
      tradeSizeUsdRaw: req.body?.tradeSizeUsd,
      leverageRaw: req.body?.leverage,
      marginModeRaw: req.body?.marginMode,
      tpPctRaw: req.body?.tpPct,
      slPctRaw: req.body?.slPct,
      debug: req.body?.debug !== false,
    })
    return res.json({ ok: true, ...out })
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

app.get('/api/binance/daily-market-overview', async (req, res) => {
  const days = Number.parseInt(String(req.query.days ?? '60'), 10)
  const minQuoteVolume = Number.parseFloat(String(req.query.minQuoteVolume ?? '2000000'))
  const maxSymbols = Number.parseInt(String(req.query.maxSymbols ?? '250'), 10)
  if (!Number.isFinite(days) || days < 10 || days > 120) {
    return res.status(400).json({ error: 'days must be between 10 and 120' })
  }
  if (!Number.isFinite(minQuoteVolume) || minQuoteVolume < 0) {
    return res.status(400).json({ error: 'minQuoteVolume must be >= 0' })
  }
  if (!Number.isFinite(maxSymbols) || maxSymbols < 20 || maxSymbols > 500) {
    return res.status(400).json({ error: 'maxSymbols must be between 20 and 500' })
  }
  try {
    const result = await computeDailyMarketOverview(FUTURES_BASE, {
      days,
      minQuoteVolume,
      maxSymbols,
    })
    if (result.error) {
      return res.status(400).json({ error: result.error })
    }
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Daily market overview failed',
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

app.get('/api/binance/daily-dca-backtest', async (req, res) => {
  const interval = String(req.query.interval ?? '1d').trim()
  const candleCount = Number.parseInt(String(req.query.candleCount ?? '120'), 10)
  const maxSymbols = Number.parseInt(String(req.query.maxSymbols ?? '0'), 10)
  const startingBalanceUsd = Number.parseFloat(String(req.query.startingBalanceUsd ?? '1000'))
  const leverage = Number.parseFloat(String(req.query.leverage ?? '20'))
  const perEntryMarginUsd = Number.parseFloat(String(req.query.perEntryMarginUsd ?? '1'))
  const tpPct = Number.parseFloat(String(req.query.tpPct ?? '20'))
  const addPct = Number.parseFloat(String(req.query.addPct ?? '-50'))

  if (!DCA_BACKTEST_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `interval must be one of: ${[...DCA_BACKTEST_INTERVALS].join(', ')}`,
    })
  }
  if (!Number.isFinite(candleCount) || candleCount < 30 || candleCount > 500) {
    return res.status(400).json({ error: 'candleCount must be between 30 and 500' })
  }
  if (!Number.isFinite(maxSymbols) || maxSymbols < 0 || maxSymbols > 1200) {
    return res.status(400).json({ error: 'maxSymbols must be between 0 and 1200' })
  }
  if (!Number.isFinite(startingBalanceUsd) || startingBalanceUsd <= 0) {
    return res.status(400).json({ error: 'startingBalanceUsd must be > 0' })
  }
  if (!Number.isFinite(leverage) || leverage <= 0 || leverage > 125) {
    return res.status(400).json({ error: 'leverage must be in (0, 125]' })
  }
  if (!Number.isFinite(perEntryMarginUsd) || perEntryMarginUsd <= 0) {
    return res.status(400).json({ error: 'perEntryMarginUsd must be > 0' })
  }
  if (!Number.isFinite(tpPct) || tpPct <= 0) {
    return res.status(400).json({ error: 'tpPct must be > 0' })
  }
  if (!Number.isFinite(addPct) || addPct >= 0) {
    return res.status(400).json({ error: 'addPct must be < 0' })
  }

  try {
    const result = await runDailyDcaBacktest(FUTURES_BASE, {
      interval,
      candleCount,
      maxSymbols,
      startingBalanceUsd,
      leverage,
      perEntryMarginUsd,
      tpPct,
      addPct,
    })
    if (result.error) return res.status(400).json({ error: result.error })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Daily DCA backtest failed',
    })
  }
})

/** Public: volume-filtered universe — long 2R/1R on green spikes; short = red-body spike short (shortRedSpike); use short_spike_low for green-spike short (TP spike low). */
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
  else if (s === 'short') strategy = 'shortRedSpike'
  else if (s === 'short_spike_low' || s === 'shortspikelow') strategy = 'shortSpikeLow'
  else if (
    s === 'shortgreenspike2r' ||
    s === 'short_green_spike_2r' ||
    s === 'short_green_spike' ||
    s === 'short_long_spike'
  ) {
    strategy = 'shortGreenSpike2R'
  } else if (
    s === 'shortgreenretestlow' ||
    s === 'short_green_retest_low' ||
    s === 'shortretestspikelow' ||
    s === 'short_spike_retest_low'
  ) {
    strategy = 'shortGreenRetestLow'
  } else if (
    s === 'longgreenretestlow' ||
    s === 'long_green_retest_low' ||
    s === 'longretestspikelow' ||
    s === 'long_spike_retest_low'
  ) {
    strategy = 'longGreenRetestLow'
  }
  else if (
    s === 'short_red_spike' ||
    s === 'shortredspike' ||
    s === 'negative_spike' ||
    s === 'negativespike'
  ) {
    strategy = 'shortRedSpike'
  } else if (
    s === 'regimeflipema50' ||
    s === 'regime_flip_ema50' ||
    s === 'regime_flip' ||
    s === 'regime'
  ) {
    strategy = 'regimeFlipEma50'
  } else if (
    s === 'longredspiketphigh' ||
    s === 'long_red_spike_tp_high' ||
    s === 'longredspikehigh' ||
    s === 'redspike_long_tp_high'
  ) {
    strategy = 'longRedSpikeTpHigh'
  } else {
    return res.status(400).json({
      error:
        'strategy must be long, longRedSpikeTpHigh / long_red_spike_tp_high, longGreenRetestLow / long_green_retest_low, short (red-body spike → shortRedSpike), short_spike_low (green spike TP spike low), shortGreenSpike2R / short_long_spike, shortGreenRetestLow / short_green_retest_low, shortRedSpike / negative_spike, or regimeFlipEma50',
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

  const maxSlQ = req.query.maxSlPct
  let maxSlPctOpt
  if (maxSlQ != null && String(maxSlQ).trim() !== '') {
    const v = Number.parseFloat(String(maxSlQ))
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      return res.status(400).json({
        error: 'maxSlPct must be a number in (0, 100], or omit the parameter for no cap',
      })
    }
    maxSlPctOpt = v
  }
  const slAtSpikeOpen = String(req.query.slAtSpikeOpen ?? '').toLowerCase() === 'true'
  const includeChartCandles =
    String(req.query.includeChartCandles ?? 'true').toLowerCase() !== 'false'
  const emaLongFilter96_5m =
    String(req.query.emaLongFilter96_5m ?? '').toLowerCase() === 'true'
  const emaLongSlopePositive96_5m =
    String(req.query.emaLongSlopePositive96_5m ?? '').toLowerCase() === 'true'
  const emaShortFilter96_5m =
    String(req.query.emaShortFilter96_5m ?? '').toLowerCase() === 'true'
  const allowOverlap = String(req.query.allowOverlap ?? '').toLowerCase() === 'true'

  const tpRQ = req.query.tpR
  let tpROpt
  if (tpRQ != null && String(tpRQ).trim() !== '') {
    const tr = Number.parseFloat(String(tpRQ))
    if (!Number.isFinite(tr) || tr <= 0 || tr > 100) {
      return res.status(400).json({
        error: 'tpR must be a number in (0, 100], e.g. 2 for 2R take-profit vs 1R stop',
      })
    }
    tpROpt = tr
  }
  const entryVolQ = req.query.entryMinQuoteVolume24hAtEntry
  let entryMinQuoteVolume24hAtEntryOpt
  if (entryVolQ != null && String(entryVolQ).trim() !== '') {
    const v = Number.parseFloat(String(entryVolQ))
    if (!Number.isFinite(v) || v <= 0) {
      return res.status(400).json({
        error:
          'entryMinQuoteVolume24hAtEntry must be a positive number (strict rolling 24h entry-volume gate), or omit it',
      })
    }
    entryMinQuoteVolume24hAtEntryOpt = v
  }

  const longRetestTpAtSpikeHigh =
    strategy === 'longGreenRetestLow' &&
    String(req.query.longRetestTpAtSpikeHigh ?? '').toLowerCase() === 'true'

  const equityEmaSlowQ = Number.parseInt(String(req.query.equityEmaSlow ?? '50'), 10)
  const equityEmaSlowOpt = Number.isFinite(equityEmaSlowQ) ? equityEmaSlowQ : 50

  try {
    const result = await computeSpikeTpSlBacktest(FUTURES_BASE, {
      minQuoteVolume24h,
      interval,
      candleCount,
      thresholdPct,
      strategy,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      maxSlPct: maxSlPctOpt,
      slAtSpikeOpen,
      allowOverlap,
      includeChartCandles,
      emaLongFilter96_5m,
      emaLongSlopePositive96_5m,
      emaShortFilter96_5m,
      equityEmaSlow: equityEmaSlowOpt,
      ...(entryMinQuoteVolume24hAtEntryOpt != null
        ? { entryMinQuoteVolume24hAtEntry: entryMinQuoteVolume24hAtEntryOpt }
        : {}),
      ...(tpROpt != null ? { tpR: tpROpt } : {}),
      ...(longRetestTpAtSpikeHigh ? { longRetestTpAtSpikeHigh: true } : {}),
    })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Spike TP/SL backtest failed',
    })
  }
})

const QUICK_BT_MAX_CANDLES = 20000

/**
 * SSE: same engine as spike-tpsl-backtest with extended tail candles (up to 20k), progress events,
 * no per-symbol OHLC charts. Agent 1 = long; Agent 3 = short_red_spike; Agent 4 = long_on_red_2r.
 */
app.get('/api/binance/spike-tpsl-quick-backtest/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  const minQuoteVolume24h = Number.parseFloat(String(req.query.minQuoteVolume24h ?? '1000000'))
  if (!Number.isFinite(minQuoteVolume24h) || minQuoteVolume24h < 0) {
    send({ event: 'error', message: 'minQuoteVolume24h must be >= 0' })
    res.end()
    return
  }

  const interval = String(req.query.interval ?? '5m')
  if (!ALLOWED_INTERVALS.has(interval)) {
    send({
      event: 'error',
      message: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
    res.end()
    return
  }

  const candleCount = Number.parseInt(String(req.query.candleCount ?? '8000'), 10)
  if (!Number.isFinite(candleCount) || candleCount < 50 || candleCount > QUICK_BT_MAX_CANDLES) {
    send({
      event: 'error',
      message: `candleCount must be between 50 and ${QUICK_BT_MAX_CANDLES}`,
    })
    res.end()
    return
  }

  const thresholdPct = Number.parseFloat(String(req.query.thresholdPct ?? '3'))
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    send({ event: 'error', message: 'thresholdPct must be a positive number' })
    res.end()
    return
  }

  const strategyRaw = String(req.query.strategy ?? 'long').trim()
  const s = strategyRaw.toLowerCase().replace(/-/g, '_')
  let strategy
  if (s === 'long' || s === 'agent1') strategy = 'long'
  else if (
    s === 'short_red_spike' ||
    s === 'shortredspike' ||
    s === 'agent3' ||
    s === 'short'
  ) {
    strategy = 'shortRedSpike'
  } else if (
    s === 'longonredspike2r' ||
    s === 'long_on_red_spike_2r' ||
    s === 'long_on_red_2r' ||
    s === 'agent4' ||
    s === 'agent_4'
  ) {
    strategy = 'longOnRedSpike2R'
  } else {
    send({
      event: 'error',
      message:
        'strategy must be long (Agent 1), short_red_spike / agent3 (Agent 3), or long_on_red_2r / agent4 (Agent 4)',
    })
    res.end()
    return
  }

  const firstQ = (v) => {
    if (v == null) return ''
    const x = Array.isArray(v) ? v[0] : v
    return String(x ?? '').trim()
  }
  const truthyQ = (v) => {
    const s = firstQ(v).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes'
  }

  const useLocalCandlesOpt = truthyQ(req.query.useLocalCandles)
  const localCandlesOnlyOpt = truthyQ(req.query.localCandlesOnly)
  const localDiskMode = useLocalCandlesOpt && localCandlesOnlyOpt

  const maxSymTrim = firstQ(req.query.maxSymbols)
  let maxSymbolsOpt = null
  let allQualifiedSymbolsOpt = false
  if (localDiskMode && maxSymTrim === '') {
    allQualifiedSymbolsOpt = true
  } else if (localDiskMode && maxSymTrim !== '') {
    const maxSymQ = Number.parseInt(maxSymTrim, 10)
    maxSymbolsOpt = Number.isFinite(maxSymQ) ? Math.min(500, Math.max(10, maxSymQ)) : 120
  } else if (
    maxSymTrim === '' &&
    truthyQ(req.query.allQualifiedSymbols) &&
    useLocalCandlesOpt
  ) {
    allQualifiedSymbolsOpt = true
  } else {
    const maxSymQ = Number.parseInt(maxSymTrim || '120', 10)
    maxSymbolsOpt = Number.isFinite(maxSymQ) ? Math.min(500, Math.max(10, maxSymQ)) : 120
  }

  const equityEmaSlowQ = Number.parseInt(String(req.query.equityEmaSlow ?? '50'), 10)
  const equityEmaSlowOpt = Number.isFinite(equityEmaSlowQ) ? equityEmaSlowQ : 50

  let tpROpt = null
  const tpRStr = req.query.tpR
  if (tpRStr != null && String(tpRStr).trim() !== '') {
    const tr = Number.parseFloat(String(tpRStr))
    if (!Number.isFinite(tr) || tr <= 0 || tr > 100) {
      send({ event: 'error', message: 'tpR must be a number in (0, 100]' })
      res.end()
      return
    }
    tpROpt = tr
  }
  let maxSlPctOpt = null
  const maxSlQ = req.query.maxSlPct
  if (maxSlQ != null && String(maxSlQ).trim() !== '') {
    const v = Number.parseFloat(String(maxSlQ))
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      send({ event: 'error', message: 'maxSlPct must be a number in (0, 100], or omit it' })
      res.end()
      return
    }
    maxSlPctOpt = v
  }
  const entryVolQ = req.query.entryMinQuoteVolume24hAtEntry
  let entryMinQuoteVolume24hAtEntryOpt = null
  if (entryVolQ != null && String(entryVolQ).trim() !== '') {
    const v = Number.parseFloat(String(entryVolQ))
    if (!Number.isFinite(v) || v <= 0) {
      send({
        event: 'error',
        message:
          'entryMinQuoteVolume24hAtEntry must be a positive number (strict rolling 24h entry-volume gate), or omit it',
      })
      res.end()
      return
    }
    entryMinQuoteVolume24hAtEntryOpt = v
  }

  try {
    const result = await computeSpikeTpSlBacktest(FUTURES_BASE, {
      minQuoteVolume24h,
      interval,
      candleCount,
      thresholdPct,
      strategy,
      includeChartCandles: false,
      extendedCandles: true,
      ...(allQualifiedSymbolsOpt ? { allQualifiedSymbols: true } : { maxSymbols: maxSymbolsOpt }),
      ...(maxSlPctOpt != null ? { maxSlPct: maxSlPctOpt } : {}),
      equityEmaSlow: equityEmaSlowOpt,
      ...(entryMinQuoteVolume24hAtEntryOpt != null
        ? { entryMinQuoteVolume24hAtEntry: entryMinQuoteVolume24hAtEntryOpt }
        : {}),
      ...(tpROpt != null ? { tpR: tpROpt } : {}),
      ...(useLocalCandlesOpt ? { useLocalCandles: true } : {}),
      ...(localCandlesOnlyOpt ? { localCandlesOnly: true } : {}),
      onProgress: (p) => send({ event: 'progress', ...p }),
    })
    send({ event: 'done', result })
  } catch (e) {
    console.error(e)
    send({
      event: 'error',
      message: e instanceof Error ? e.message : 'Quick backtest failed',
    })
  }
  res.end()
})

/** Local on-disk kline cache (see data/local-candles). */
app.get('/api/local-candles/status', async (_req, res) => {
  try {
    const status = await scanLocalCandlesStatus()
    res.json({
      ...status,
      useLocalInBacktest:
        String(process.env.SPIKE_TPSL_USE_LOCAL_CANDLES ?? '').trim() === '1' ||
        String(process.env.SPIKE_TPSL_USE_LOCAL_CANDLES ?? '').toLowerCase().trim() === 'true',
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({
      error: e instanceof Error ? e.message : 'local-candles status failed',
    })
  }
})

/**
 * SSE: download up to `targetBars` (default 10_000) closed klines per symbol.
 * Query `interval`: `5m` or `15m` (one phase); omit for both 5m and 15m in one run.
 */
app.get('/api/local-candles/sync/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  const concQ = Number.parseInt(String(req.query.concurrency ?? '2'), 10)
  const concurrency = Number.isFinite(concQ) ? Math.min(8, Math.max(1, concQ)) : 2

  const tbQ = Number.parseInt(String(req.query.targetBars ?? '10000'), 10)
  const targetBars = Number.isFinite(tbQ) ? Math.min(20_000, Math.max(100, tbQ)) : 10_000

  const intervalRaw = String(req.query.interval ?? '').trim().toLowerCase()
  let intervals
  if (!intervalRaw) {
    intervals = ['5m', '15m']
  } else if (intervalRaw === '5m' || intervalRaw === '15m') {
    intervals = [intervalRaw]
  } else {
    send({
      event: 'error',
      message: 'interval must be 5m or 15m (or omit to fetch both in one run)',
    })
    res.end()
    return
  }

  try {
    await runLocalCandlesFullSync({
      futuresBase: FUTURES_BASE,
      headers: binanceFuturesPublicHeaders(),
      targetBars,
      intervals,
      concurrency,
      onEvent: (evt) => send(evt),
    })
  } catch (e) {
    console.error(e)
    send({
      event: 'error',
      message: e instanceof Error ? e.message : 'local-candles sync failed',
    })
  }
  res.end()
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
  else if (s === 'short') strategy = 'shortRedSpike'
  else if (s === 'short_spike_low' || s === 'shortspikelow') strategy = 'shortSpikeLow'
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
        'strategy must be long, short (red-body spike → short 2R/1R), short_spike_low (green spike: TP spike low), or shortRedSpike / negative_spike (same as short)',
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
  let scanSecondsBeforeClose
  const sbcRaw = req.query.scanSecondsBeforeClose ?? req.query.scan_seconds_before_close
  if (sbcRaw !== undefined && String(sbcRaw).trim() !== '') {
    const sbc = Number.parseInt(String(sbcRaw), 10)
    if (Number.isFinite(sbc)) scanSecondsBeforeClose = sbc
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
      scanSecondsBeforeClose,
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

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && process.env.AGENT3_SCAN_SCHEDULER !== 'false') {
  startAgent3ScanScheduler({
    futuresBase: FUTURES_BASE,
    isEnabled: () => true,
    readSettings: readAgent3Settings,
    persistScan: persistAgent3ScanResult,
    logger: console,
  })
}

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && process.env.AGENT2_SCAN_SCHEDULER !== 'false') {
  startAgent2ScanScheduler({ futuresBase: FUTURES_BASE, logger: console })
}

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && process.env.AGENT2_BOOT_SCAN !== 'false') {
  void runAgent2ScanOnce().catch((e) => console.error('[agent2] boot scan failed', e))
}

if (AGENT2_EXECUTION_ENABLED) {
  setInterval(() => {
    void runAgent2ExecutionTick()
  }, AGENT2_EXECUTION_POLL_MS)
  console.log(`[agent2] execution loop started (${AGENT2_EXECUTION_POLL_MS}ms poll)`)
  void runAgent2ExecutionTick()
}

if (AGENT1_EXECUTION_ENABLED) {
  setInterval(() => {
    void runAgent1ExecutionTick()
  }, AGENT1_EXECUTION_POLL_MS)
  pushAgent1ExecutionLog('info', `execution loop started (${AGENT1_EXECUTION_POLL_MS}ms poll)`)
  void runAgent1ExecutionTick()
}

if (AGENT3_EXECUTION_ENABLED) {
  setInterval(() => {
    void runAgent3ExecutionTick()
  }, AGENT3_EXECUTION_POLL_MS)
  pushAgent3ExecutionLog('info', `execution loop started (${AGENT3_EXECUTION_POLL_MS}ms poll)`)
  void runAgent3ExecutionTick()
}

if (process.env.AGENT1_SHADOW_SCHEDULER !== 'false') {
  startAgent1ShadowScheduler({
    futuresBase: FUTURES_BASE,
    loadShadowSimBaseSettings: async () => {
      const pack = await loadAgent1ShadowSimConfigFromDbCached()
      return {
        longBase: pack.long,
        shortBase: pack.short,
        configUpdatedAt: pack.updatedAt,
        configFromDb: pack.fromDb,
      }
    },
    syncPausedFromDb: canUseShadowDbCoordination() ? syncAgent1ShadowPausedFromDb : null,
    syncShadowOverridesFromDb: canUseShadowDbCoordination()
      ? async () => {
          const row = await loadAgent1ShadowSnapshotFromDb()
          if (row && Object.prototype.hasOwnProperty.call(row, 'shadowSimRuntimeOverrides')) {
            setAgent1ShadowSnapshot({ shadowSimRuntimeOverrides: row.shadowSimRuntimeOverrides })
          }
        }
      : null,
    shouldRunTick: async () => {
      if (!canUseShadowDbCoordination()) {
        agent1ShadowLeaseOwner = true
        return true
      }
      const owner = await tryAcquireAgent1ShadowLease()
      agent1ShadowLeaseOwner = owner
      if (!owner) {
        await maybeHydrateAgent1ShadowSnapshot(true)
      }
      return owner
    },
    afterTick: async (snapshot) => {
      if (canUseShadowDbCoordination() && agent1ShadowLeaseOwner) {
        await persistAgent1ShadowSnapshot(snapshot)
      }
    },
    shouldMarkTick: () => {
      if (!canUseShadowDbCoordination()) return true
      return agent1ShadowLeaseOwner
    },
    afterMarkTick: async (snapshot) => {
      if (canUseShadowDbCoordination() && agent1ShadowLeaseOwner) {
        await persistAgent1ShadowSnapshot(snapshot)
      }
    },
    logger: console,
  })
}
