/**
 * Agent 2 — long green retest at spike low (TAKE_PROFIT_MARKET BUY), TP/SL after fill.
 * Standalone from Agent 1; initialized via initAgent2Context() from app.js.
 */
import os from 'node:os'
import { computeFutures24hVolumes } from './volumeScreener.js'
import { fetchAgent1ShadowKlines } from './agent1ShadowEngine.js'
import {
  AGENT1_INTERVAL_MS,
  AGENT1_SCAN_INTERVALS,
  agent1IntervalMs,
  clampScanSecondsAfterClose,
  msUntilNextScanAfterBarClose,
} from './agent1ScanIntervals.js'

const SPIKE_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const AGENT2_DEFAULTS = Object.freeze({
  agentEnabled: false,
  signalsSchedulerEnabled: false,
  tradingEnabled: false,
  tradeSizeUsd: 10,
  leverage: 10,
  marginMode: 'cross',
  maxTpPct: 1.5,
  maxSlPct: 1.0,
  tpR: 2,
  longRetestTpAtSpikeHigh: false,
  scanThresholdPct: 3,
  scanMinQuoteVolume: 10_000_000,
  scanMaxSymbols: 80,
  maxOpenPositions: 10,
  scanInterval: '5m',
  scanSecondsAfterClose: 5,
  workingType: 'MARK_PRICE',
})

export const AGENT2_EXECUTION_MAX_LOGS = 200

const AGENT2_EXECUTION_SINGLE_WRITER = process.env.AGENT2_EXECUTION_SINGLE_WRITER !== 'false'
const AGENT2_EXECUTION_LOCK_NAME = String(process.env.AGENT2_EXECUTION_LOCK_NAME ?? 'agent2_execution_main').trim()
const AGENT2_EXECUTION_LOCK_TTL_SEC = Math.min(
  600,
  Math.max(15, Number.parseInt(String(process.env.AGENT2_EXECUTION_LOCK_TTL_SEC ?? '90'), 10) || 90),
)
const AGENT2_EXECUTION_WRITER_ID = String(
  process.env.AGENT2_EXECUTION_WRITER_ID ?? `${os.hostname?.() ?? 'host'}:${process.pid}`,
).replace(/[^a-zA-Z0-9._:-]/g, '_')

const AGENT2_SCAN_SINGLE_WRITER = process.env.AGENT2_SCAN_SINGLE_WRITER !== 'false'
const AGENT2_SCAN_LOCK_NAME = String(process.env.AGENT2_SCAN_LOCK_NAME ?? 'agent2_scan_main').trim()
const AGENT2_SCAN_LOCK_TTL_SEC = Math.min(
  900,
  Math.max(60, Number.parseInt(String(process.env.AGENT2_SCAN_LOCK_TTL_SEC ?? '300'), 10) || 300),
)
const AGENT2_SCAN_WRITER_ID = String(
  process.env.AGENT2_SCAN_WRITER_ID ?? `${os.hostname?.() ?? 'host'}:${process.pid}`,
).replace(/[^a-zA-Z0-9._:-]/g, '_')

/** @type {Agent2Context | null} */
let agent2Ctx = null

/**
 * @typedef {object} Agent2Context
 * @property {(path: string, init?: RequestInit) => Promise<any>} supabaseRest
 * @property {string} futuresBase
 * @property {(apiKey: string, apiSecret: string, path: string, params?: object) => Promise<any>} postSigned
 * @property {(apiKey: string, apiSecret: string, path: string, params?: object) => Promise<any>} getSigned
 * @property {(apiKey: string, apiSecret: string, path: string, params?: object) => Promise<any>} deleteSigned
 * @property {(raw: string, opts?: { allowMissingSuffix?: boolean }) => string | null} normalizeSymbol
 * @property {(symbol: string) => Promise<object>} getSymbolSpec
 * @property {(v: number, step: number, mode?: string) => number} quantizeToStep
 * @property {(v: number, step: number, cap?: number | null) => string} fmtByStep
 * @property {(x: any) => number | null} toNum
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(apiKey: string, apiSecret: string) => Promise<boolean>} fetchPositionMode
 * @property {(apiKey: string, apiSecret: string) => Promise<any[]>} fetchPositionRisk
 * @property {(apiKey: string, apiSecret: string, symbol: string) => Promise<number | null>} fetchMaxLeverageForSymbol
 * @property {(msg: string) => number | null} parseMaxLeverageFromBinanceError
 * @property {(o: object) => object} enforceExitBracketAgainstEntry
 * @property {(symbol: string, positionSide: string) => string} buildAgentTradePositionKey
 * @property {(apiKey: string, apiSecret: string, tradeRow: object) => Promise<object>} fetchTradeCloseAccounting
 */

export function initAgent2Context(ctx) {
  agent2Ctx = ctx
}

function ctx() {
  if (!agent2Ctx) throw new Error('Agent2: initAgent2Context not called')
  return agent2Ctx
}

function isGreenBodySpike(c, thresholdPct) {
  if (!c || !Number.isFinite(c.open) || c.open === 0) return false
  if (!(c.close > c.open)) return false
  const bodyPct = ((c.close - c.open) / c.open) * 100
  return bodyPct >= thresholdPct
}

function capStopLong(entry, slPrice, maxSlPct) {
  if (maxSlPct == null || !Number.isFinite(maxSlPct) || maxSlPct <= 0) return slPrice
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(slPrice)) return slPrice
  const maxDist = entry * (maxSlPct / 100)
  const dist = entry - slPrice
  if (!(dist > 0)) return slPrice
  if (dist <= maxDist) return slPrice
  return entry - maxDist
}

function parseBool(v, defaultVal) {
  if (v == null) return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return defaultVal
}

function normalizeAgent2Settings(raw = {}) {
  const tradeSizeUsd = Number.parseFloat(String(raw.tradeSizeUsd ?? raw.trade_size_usd ?? AGENT2_DEFAULTS.tradeSizeUsd))
  const leverage = Number.parseInt(String(raw.leverage ?? AGENT2_DEFAULTS.leverage), 10)
  const marginMode = String(raw.marginMode ?? raw.margin_mode ?? AGENT2_DEFAULTS.marginMode)
    .trim()
    .toLowerCase()
  const maxTpPct = Number.parseFloat(String(raw.maxTpPct ?? raw.max_tp_pct ?? AGENT2_DEFAULTS.maxTpPct))
  const maxSlPct = Number.parseFloat(String(raw.maxSlPct ?? raw.max_sl_pct ?? AGENT2_DEFAULTS.maxSlPct))
  const tpR = Number.parseFloat(String(raw.tpR ?? raw.tp_r ?? AGENT2_DEFAULTS.tpR))
  const longRetestTpAtSpikeHigh = parseBool(
    raw.longRetestTpAtSpikeHigh ?? raw.long_retest_tp_at_spike_high,
    AGENT2_DEFAULTS.longRetestTpAtSpikeHigh,
  )
  const scanThresholdPct = Number.parseFloat(
    String(raw.scanThresholdPct ?? raw.scan_threshold_pct ?? AGENT2_DEFAULTS.scanThresholdPct),
  )
  const scanMinQuoteVolume = Number.parseFloat(
    String(raw.scanMinQuoteVolume ?? raw.scan_min_quote_volume ?? AGENT2_DEFAULTS.scanMinQuoteVolume),
  )
  const scanMaxSymbols = Number.parseInt(
    String(raw.scanMaxSymbols ?? raw.scan_max_symbols ?? AGENT2_DEFAULTS.scanMaxSymbols),
    10,
  )
  let maxOpenPositions = Number.parseInt(
    String(raw.maxOpenPositions ?? raw.max_open_positions ?? AGENT2_DEFAULTS.maxOpenPositions),
    10,
  )
  if (!Number.isFinite(maxOpenPositions)) maxOpenPositions = AGENT2_DEFAULTS.maxOpenPositions
  maxOpenPositions = Math.min(50, Math.max(1, Math.floor(maxOpenPositions)))
  const scanIntervalRaw = String(raw.scanInterval ?? raw.scan_interval ?? AGENT2_DEFAULTS.scanInterval).trim()
  if (!AGENT1_SCAN_INTERVALS.has(scanIntervalRaw)) {
    throw new Error(`scanInterval must be one of: ${[...AGENT1_SCAN_INTERVALS].sort().join(', ')}`)
  }
  const scanInterval = scanIntervalRaw
  const intervalMs = AGENT1_INTERVAL_MS[scanInterval] ?? AGENT1_INTERVAL_MS['5m']
  const scanSecondsAfterClose = clampScanSecondsAfterClose(
    raw.scanSecondsAfterClose ??
      raw.scan_seconds_after_close ??
      AGENT2_DEFAULTS.scanSecondsAfterClose,
    intervalMs,
  )
  const workingTypeRaw = String(raw.workingType ?? raw.working_type ?? AGENT2_DEFAULTS.workingType).toUpperCase()
  const workingType = workingTypeRaw === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE'
  const agentEnabled = parseBool(raw.agentEnabled ?? raw.agent_enabled, AGENT2_DEFAULTS.agentEnabled)
  const signalsSchedulerEnabled = parseBool(
    raw.signalsSchedulerEnabled ?? raw.signals_scheduler_enabled,
    AGENT2_DEFAULTS.signalsSchedulerEnabled,
  )
  const tradingEnabled = parseBool(raw.tradingEnabled ?? raw.trading_enabled, AGENT2_DEFAULTS.tradingEnabled)

  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) throw new Error('tradeSizeUsd must be positive')
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) throw new Error('leverage 1–125')
  if (marginMode !== 'cross' && marginMode !== 'isolated') throw new Error("marginMode 'cross' or 'isolated'")
  if (!Number.isFinite(maxTpPct) || maxTpPct <= 0) throw new Error('maxTpPct must be positive')
  if (!Number.isFinite(maxSlPct) || maxSlPct <= 0) throw new Error('maxSlPct must be positive')
  if (!Number.isFinite(tpR) || tpR <= 0) throw new Error('tpR must be positive')
  if (!Number.isFinite(scanThresholdPct) || scanThresholdPct <= 0) throw new Error('scanThresholdPct must be positive')
  if (!Number.isFinite(scanMinQuoteVolume) || scanMinQuoteVolume < 0) throw new Error('scanMinQuoteVolume ≥ 0')
  if (!Number.isFinite(scanMaxSymbols) || scanMaxSymbols < 1 || scanMaxSymbols > 800) {
    throw new Error('scanMaxSymbols 1–800')
  }

  return {
    agentEnabled,
    signalsSchedulerEnabled,
    tradingEnabled,
    tradeSizeUsd,
    leverage,
    marginMode,
    maxTpPct,
    maxSlPct,
    tpR,
    longRetestTpAtSpikeHigh,
    scanThresholdPct,
    scanMinQuoteVolume,
    scanMaxSymbols,
    maxOpenPositions,
    scanInterval,
    scanSecondsAfterClose,
    workingType,
  }
}

const SETTINGS_SELECT =
  'id,updated_at,agent_enabled,signals_scheduler_enabled,trading_enabled,' +
  'trade_size_usd,leverage,margin_mode,max_tp_pct,max_sl_pct,tp_r,long_retest_tp_at_spike_high,' +
  'scan_threshold_pct,scan_min_quote_volume,scan_max_symbols,max_open_positions,scan_interval,scan_seconds_after_close,working_type'

export async function readAgent2Settings() {
  const { supabaseRest } = ctx()
  const rows = await supabaseRest(`/rest/v1/agent2_settings?select=${SETTINGS_SELECT}&limit=1`)
  if (!Array.isArray(rows) || rows.length === 0) {
    await supabaseRest('/rest/v1/agent2_settings?select=*', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_enabled: false,
        signals_scheduler_enabled: false,
        trading_enabled: false,
      }),
    })
    const again = await supabaseRest(`/rest/v1/agent2_settings?select=${SETTINGS_SELECT}&limit=1`)
    const row0 = Array.isArray(again) && again[0] ? again[0] : null
    if (!row0) return { ...AGENT2_DEFAULTS, id: null, updatedAt: null }
    return mapSettingsRow(row0)
  }
  return mapSettingsRow(rows[0])
}

function mapSettingsRow(row) {
  const n = normalizeAgent2Settings(row)
  return {
    id: row.id ?? null,
    ...n,
    updatedAt: row.updated_at ?? null,
  }
}

export async function upsertAgent2Settings(input) {
  const { supabaseRest } = ctx()
  const s = normalizeAgent2Settings(input)
  const existing = await supabaseRest(`/rest/v1/agent2_settings?select=id&limit=1`)
  const id = Array.isArray(existing) && existing[0]?.id ? existing[0].id : null
  const body = {
    agent_enabled: s.agentEnabled,
    signals_scheduler_enabled: s.signalsSchedulerEnabled,
    trading_enabled: s.tradingEnabled,
    trade_size_usd: s.tradeSizeUsd,
    leverage: s.leverage,
    margin_mode: s.marginMode,
    max_tp_pct: s.maxTpPct,
    max_sl_pct: s.maxSlPct,
    tp_r: s.tpR,
    long_retest_tp_at_spike_high: s.longRetestTpAtSpikeHigh,
    scan_threshold_pct: s.scanThresholdPct,
    scan_min_quote_volume: s.scanMinQuoteVolume,
    scan_max_symbols: s.scanMaxSymbols,
    max_open_positions: s.maxOpenPositions,
    scan_interval: s.scanInterval,
    scan_seconds_after_close: s.scanSecondsAfterClose,
    working_type: s.workingType,
  }
  if (id && SPIKE_ROW_UUID_RE.test(String(id))) {
    const rows = await supabaseRest(`/rest/v1/agent2_settings?id=eq.${encodeURIComponent(id)}&select=${SETTINGS_SELECT}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(body),
    })
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    if (row) return mapSettingsRow(row)
  }
  const rows = await supabaseRest(`/rest/v1/agent2_settings?select=${SETTINGS_SELECT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const row = Array.isArray(rows) && rows[0] ? rows[0] : body
  return mapSettingsRow(row)
}

function canUseAgent2ExecutionDbCoordination() {
  return AGENT2_EXECUTION_SINGLE_WRITER && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function tryAcquireAgent2ExecutionLease() {
  const { supabaseRest } = ctx()
  if (!canUseAgent2ExecutionDbCoordination()) return true
  const nowIso = new Date().toISOString()
  const leaseIso = new Date(Date.now() + AGENT2_EXECUTION_LOCK_TTL_SEC * 1000).toISOString()
  const lockNameEnc = encodeURIComponent(AGENT2_EXECUTION_LOCK_NAME)
  const orExpr = `(owner_id.eq.${AGENT2_EXECUTION_WRITER_ID},lease_until.lt.${nowIso})`
  const orEnc = encodeURIComponent(orExpr)
  const rows = await supabaseRest(
    `/rest/v1/agent_runtime_locks?lock_name=eq.${lockNameEnc}&or=${orEnc}&select=*`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ owner_id: AGENT2_EXECUTION_WRITER_ID, lease_until: leaseIso }),
    },
  )
  if (Array.isArray(rows) && rows.length > 0) return true
  try {
    const created = await supabaseRest('/rest/v1/agent_runtime_locks?select=*', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        lock_name: AGENT2_EXECUTION_LOCK_NAME,
        owner_id: AGENT2_EXECUTION_WRITER_ID,
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

function canUseAgent2ScanDbCoordination() {
  return AGENT2_SCAN_SINGLE_WRITER && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function tryAcquireAgent2ScanLease() {
  const { supabaseRest } = ctx()
  if (!canUseAgent2ScanDbCoordination()) return true
  const nowIso = new Date().toISOString()
  const leaseIso = new Date(Date.now() + AGENT2_SCAN_LOCK_TTL_SEC * 1000).toISOString()
  const lockNameEnc = encodeURIComponent(AGENT2_SCAN_LOCK_NAME)
  const orExpr = `(owner_id.eq.${AGENT2_SCAN_WRITER_ID},lease_until.lt.${nowIso})`
  const orEnc = encodeURIComponent(orExpr)
  const rows = await supabaseRest(
    `/rest/v1/agent_runtime_locks?lock_name=eq.${lockNameEnc}&or=${orEnc}&select=*`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ owner_id: AGENT2_SCAN_WRITER_ID, lease_until: leaseIso }),
    },
  )
  if (Array.isArray(rows) && rows.length > 0) return true
  try {
    const created = await supabaseRest('/rest/v1/agent_runtime_locks?select=*', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        lock_name: AGENT2_SCAN_LOCK_NAME,
        owner_id: AGENT2_SCAN_WRITER_ID,
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

/** @type {{ running: boolean, lastRunAt: number | null, lastError: string | null, leaseOwner: boolean, lastSpikes: number }} */
export const agent2ExecutionState = {
  running: false,
  lastRunAt: null,
  lastError: null,
  leaseOwner: false,
  lastSpikes: 0,
}

/** @type {Array<{ at: string, level: string, msg: string }>} */
const agent2ExecutionLogs = []

async function insertAgent2LogRow(row) {
  const { supabaseRest } = ctx()
  await supabaseRest('/rest/v1/agent2_execution_logs?select=*', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ level: row.level, message: row.msg, logged_at: row.at }),
  })
}

export function pushAgent2Log(level, msg) {
  const row = { at: new Date().toISOString(), level, msg: String(msg ?? '').slice(0, 480) }
  agent2ExecutionLogs.push(row)
  if (agent2ExecutionLogs.length > AGENT2_EXECUTION_MAX_LOGS) {
    agent2ExecutionLogs.splice(0, agent2ExecutionLogs.length - AGENT2_EXECUTION_MAX_LOGS)
  }
  void insertAgent2LogRow(row).catch(() => {})
}

export async function listAgent2ExecutionLogRows(limit = 100) {
  const { supabaseRest } = ctx()
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const rows = await supabaseRest(`/rest/v1/agent2_execution_logs?select=*&order=logged_at.desc&limit=${n}`)
  return Array.isArray(rows) ? rows : []
}

async function listAgent2OpenTrades(limit = 20) {
  const { supabaseRest } = ctx()
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 20))
  const rows = await supabaseRest(
    `/rest/v1/agent2_trades?select=*&status=eq.open&order=opened_at.desc&limit=${n}`,
  )
  return Array.isArray(rows) ? rows : []
}

async function markAgent2TradeRecordClosed(id, closeReason, closeMeta = {}) {
  const { supabaseRest } = ctx()
  const rid = String(id ?? '').trim()
  if (!SPIKE_ROW_UUID_RE.test(rid)) return null
  const rows = await supabaseRest(`/rest/v1/agent2_trades?id=eq.${encodeURIComponent(rid)}&status=eq.open&select=*`, {
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

async function reconcileAgent2OpenTradesWithExchange(apiKey, apiSecret) {
  const { fetchPositionRisk, buildAgentTradePositionKey, fetchTradeCloseAccounting } = ctx()
  const openTrades = await listAgent2OpenTrades(500)
  if (openTrades.length === 0) return { closedNow: 0 }
  const all = await fetchPositionRisk(apiKey, apiSecret)
  const openRows = Array.isArray(all)
    ? all.filter((p) => Math.abs(parseFloat(p?.positionAmt ?? '0')) > 0)
    : []
  const openKeys = new Set(
    openRows.map((p) => buildAgentTradePositionKey(p.symbol, p.positionSide)),
  )
  let closedNow = 0
  for (const tr of openTrades) {
    const key = buildAgentTradePositionKey(tr.symbol, tr.position_side)
    if (openKeys.has(key)) continue
    let closeMeta = {}
    try {
      if (typeof fetchTradeCloseAccounting === 'function') {
        closeMeta = await fetchTradeCloseAccounting(apiKey, apiSecret, tr)
      }
    } catch {
      closeMeta = {}
    }
    const closed = await markAgent2TradeRecordClosed(tr.id, 'position_not_open', closeMeta)
    if (closed) closedNow += 1
  }
  return { closedNow }
}

async function listActiveEntryOrders() {
  const { supabaseRest } = ctx()
  const rows = await supabaseRest(
    `/rest/v1/agent2_entry_orders?select=*&status=in.(NEW,PARTIALLY_FILLED)&order=created_at.desc&limit=50`,
  )
  return Array.isArray(rows) ? rows : []
}

async function patchEntryOrder(id, patch) {
  const { supabaseRest } = ctx()
  if (!SPIKE_ROW_UUID_RE.test(String(id))) return null
  const rows = await supabaseRest(`/rest/v1/agent2_entry_orders?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function patchSpike(spikeId, patch) {
  const { supabaseRest } = ctx()
  if (!SPIKE_ROW_UUID_RE.test(String(spikeId))) return null
  const rows = await supabaseRest(`/rest/v1/agent2_spikes?id=eq.${encodeURIComponent(spikeId)}&select=*`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function fetchSpikeById(spikeId) {
  const { supabaseRest } = ctx()
  if (!SPIKE_ROW_UUID_RE.test(String(spikeId))) return null
  const rows = await supabaseRest(`/rest/v1/agent2_spikes?id=eq.${encodeURIComponent(spikeId)}&limit=1`)
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function computeTheoreticalBracket(spikeRow, settings, actualEntryForClamp) {
  const theoreticalEntry = Number(spikeRow.spike_low)
  const baseR = Number(spikeRow.base_r)
  const spikeHigh = Number(spikeRow.spike_high)
  if (!Number.isFinite(theoreticalEntry) || !Number.isFinite(baseR) || baseR <= 0) return null
  let slPrice = theoreticalEntry - baseR
  slPrice = capStopLong(theoreticalEntry, slPrice, settings.maxSlPct)
  const riskWidth = theoreticalEntry - slPrice
  if (!(riskWidth > 0)) return null
  let tpPrice
  if (settings.longRetestTpAtSpikeHigh) {
    if (!Number.isFinite(spikeHigh) || !(spikeHigh > theoreticalEntry)) return null
    tpPrice = spikeHigh
  } else {
    tpPrice = theoreticalEntry + settings.tpR * riskWidth
  }
  const { quantizeToStep, fmtByStep, enforceExitBracketAgainstEntry, getSymbolSpec } = ctx()
  const symbol = String(spikeRow.symbol ?? '').toUpperCase()
  const spec = await getSymbolSpec(symbol)
  const tick = spec.tickSize
  const entryClamp = Number.isFinite(actualEntryForClamp) && actualEntryForClamp > 0 ? actualEntryForClamp : theoreticalEntry
  const tpNum = quantizeToStep(tpPrice, tick, 'ceil')
  const slNum = quantizeToStep(slPrice, tick, 'floor')
  const bracket = enforceExitBracketAgainstEntry({
    side: 'BUY',
    entryPrice: entryClamp,
    tpPriceNum: tpNum,
    slPriceNum: slNum,
    tickSize: tick,
  })
  if (!bracket.ok) return null
  return {
    tpPrice: fmtByStep(bracket.tpPriceNum, tick, spec.pricePrecision),
    slPrice: fmtByStep(bracket.slPriceNum, tick, spec.pricePrecision),
    tpNum: bracket.tpPriceNum,
    slNum: bracket.slPriceNum,
  }
}

async function prepareLeverageAndMargin(apiKey, apiSecret, symbol, settings, warnings) {
  const { postSigned, fetchMaxLeverageForSymbol, parseMaxLeverageFromBinanceError } = ctx()
  const marginType = settings.marginMode === 'isolated' ? 'ISOLATED' : 'CROSSED'
  try {
    await postSigned(apiKey, apiSecret, '/fapi/v1/marginType', { symbol, marginType })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/no need to change margin type/i.test(msg)) warnings.push(`marginType: ${msg}`)
  }
  let applied = settings.leverage
  const maxLev = await fetchMaxLeverageForSymbol(apiKey, apiSecret, symbol)
  if (Number.isFinite(maxLev) && maxLev > 0) applied = Math.min(applied, maxLev)
  try {
    await postSigned(apiKey, apiSecret, '/fapi/v1/leverage', { symbol, leverage: applied })
  } catch (e) {
    const parsed = parseMaxLeverageFromBinanceError(e instanceof Error ? e.message : String(e))
    if (Number.isFinite(parsed) && parsed > 0 && parsed < applied) {
      applied = parsed
      await postSigned(apiKey, apiSecret, '/fapi/v1/leverage', { symbol, leverage: applied })
      warnings.push(`leverage clamped ${applied}x`)
    } else throw e
  }
  return applied
}

async function placeRetestEntryOrder(apiKey, apiSecret, settings, spikeRow) {
  const {
    futuresBase,
    postSigned,
    normalizeSymbol,
    getSymbolSpec,
    quantizeToStep,
    fmtByStep,
    toNum,
    fetchPositionMode,
  } = ctx()
  const symbol = normalizeSymbol(spikeRow.symbol, { allowMissingSuffix: false })
  if (!symbol) throw new Error('bad symbol')
  const stopPriceRaw = Number(spikeRow.spike_low)
  if (!Number.isFinite(stopPriceRaw) || stopPriceRaw <= 0) throw new Error('bad spike_low')

  const warnings = []
  const appliedLev = await prepareLeverageAndMargin(apiKey, apiSecret, symbol, settings, warnings)

  const tickerQ = new URLSearchParams({ symbol })
  const tickerRes = await fetch(`${futuresBase}/fapi/v1/ticker/price?${tickerQ}`)
  const tickerText = await tickerRes.text()
  let ticker
  try {
    ticker = tickerText ? JSON.parse(tickerText) : {}
  } catch {
    throw new Error('ticker parse failed')
  }
  const markPrice = toNum(ticker?.price)
  if (!Number.isFinite(markPrice) || markPrice <= 0) throw new Error('no mark')
  if (!(stopPriceRaw < markPrice)) {
    throw new Error(`spike_low ${stopPriceRaw} must be below mark ${markPrice} for TAKE_PROFIT_MARKET BUY`)
  }

  const spec = await getSymbolSpec(symbol)
  const effectiveNotional = settings.tradeSizeUsd * appliedLev
  if (spec.minNotional > 0 && effectiveNotional < spec.minNotional) {
    throw new Error(`below min notional ${spec.minNotional}`)
  }
  const rawQty = effectiveNotional / markPrice
  const qty = quantizeToStep(rawQty, spec.stepSize, 'floor')
  if (!Number.isFinite(qty) || qty <= 0 || qty < spec.minQty) throw new Error('qty too small')
  const quantity = fmtByStep(qty, spec.stepSize, spec.quantityPrecision)

  const isHedge = await fetchPositionMode(apiKey, apiSecret)
  const triggerPrice = fmtByStep(stopPriceRaw, spec.tickSize, spec.pricePrecision)

  const params = {
    algoType: 'CONDITIONAL',
    symbol,
    side: 'BUY',
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice,
    quantity,
    workingType: settings.workingType,
    priceProtect: 'true',
    newOrderRespType: 'RESULT',
  }
  if (isHedge) params.positionSide = 'LONG'

  const order = await postSigned(apiKey, apiSecret, '/fapi/v1/algoOrder', params)
  const oid = Number.parseInt(String(order?.algoId ?? ''), 10)
  return {
    order,
    binanceOrderId: Number.isFinite(oid) ? oid : null,
    clientOrderId: order?.clientAlgoId ?? order?.clientOrderId ?? null,
    stopPrice: Number.parseFloat(triggerPrice),
    quantity,
    warnings,
  }
}

/** Map GET /fapi/v1/algoOrder JSON to classic order fields used by execution tick. */
function normalizeAlgoOrderToClassic(algo) {
  if (!algo || typeof algo !== 'object') return null
  const st = String(algo.algoStatus ?? '').toUpperCase()
  const qtyTotal = Number.parseFloat(String(algo.quantity ?? '0'))
  const ap = Number.parseFloat(String(algo.actualPrice ?? '0'))
  let aq = Number.parseFloat(String(algo.actualQuantity ?? algo.actualExecutedQty ?? algo.aq ?? 'NaN'))
  if (!Number.isFinite(aq) || aq < 0) aq = 0

  if (st === 'FINISHED') {
    if (ap > 0 && qtyTotal > 0) {
      const exec = aq > 0 ? aq : qtyTotal
      return {
        status: 'FILLED',
        avgPrice: String(ap),
        executedQty: String(exec),
        price: String(ap),
        cumQty: String(exec),
        _algoStatus: st,
      }
    }
    return { status: 'CANCELED', avgPrice: '0', executedQty: '0', _algoStatus: st }
  }
  if (st === 'CANCELED') return { status: 'CANCELED', avgPrice: '0', executedQty: '0', _algoStatus: st }
  if (st === 'EXPIRED') return { status: 'EXPIRED', avgPrice: '0', executedQty: '0', _algoStatus: st }
  if (st === 'REJECTED') return { status: 'REJECTED', avgPrice: '0', executedQty: '0', _algoStatus: st }
  if (Number.isFinite(aq) && aq > 0 && ap > 0 && qtyTotal > 0 && aq < qtyTotal * 0.999) {
    return {
      status: 'PARTIALLY_FILLED',
      avgPrice: String(ap),
      executedQty: String(aq),
      price: String(ap),
      cumQty: String(aq),
      _algoStatus: st,
    }
  }
  return { status: 'NEW', avgPrice: '0', executedQty: '0', _algoStatus: st }
}

async function cancelBinanceOrder(apiKey, apiSecret, _symbol, algoId) {
  const { deleteSigned } = ctx()
  if (!Number.isFinite(algoId)) return null
  try {
    return await deleteSigned(apiKey, apiSecret, '/fapi/v1/algoOrder', { algoId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/unknown order|does not exist|algo.*not found|Unknown algo/i.test(msg)) return { status: 'UNKNOWN' }
    throw e
  }
}

async function fetchBinanceOrder(apiKey, apiSecret, _symbol, algoId) {
  const { getSigned } = ctx()
  if (!Number.isFinite(algoId)) return null
  const raw = await getSigned(apiKey, apiSecret, '/fapi/v1/algoOrder', { algoId })
  return normalizeAlgoOrderToClassic(raw)
}

async function placeExitBrackets(apiKey, apiSecret, tradeRow, spikeRow, settings, avgEntry) {
  const { postSigned, fetchPositionMode, sleep } = ctx()
  if (!spikeRow) throw new Error('missing spike row for bracket')
  const symbol = String(tradeRow.symbol ?? '').toUpperCase()
  const computed = await computeTheoreticalBracket(spikeRow, settings, avgEntry)
  if (!computed) throw new Error('could not compute TP/SL')

  const isHedge = await fetchPositionMode(apiKey, apiSecret)
  const exitSide = 'SELL'
  const tpParams = {
    algoType: 'CONDITIONAL',
    symbol,
    side: exitSide,
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: computed.tpPrice,
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
    triggerPrice: computed.slPrice,
    workingType: 'MARK_PRICE',
    priceProtect: 'true',
    closePosition: 'true',
    newOrderRespType: 'RESULT',
  }
  if (isHedge) {
    tpParams.positionSide = 'LONG'
    slParams.positionSide = 'LONG'
  }
  let tpOrder = null
  let slOrder = null
  for (let attempt = 0; attempt < 5 && (!tpOrder || !slOrder); attempt++) {
    if (attempt > 0) await sleep(360)
    if (!tpOrder) {
      try {
        tpOrder = await postSigned(apiKey, apiSecret, '/fapi/v1/algoOrder', tpParams)
      } catch {
        /* retry */
      }
    }
    if (!slOrder) {
      try {
        slOrder = await postSigned(apiKey, apiSecret, '/fapi/v1/algoOrder', slParams)
      } catch {
        /* retry */
      }
    }
  }
  if (!tpOrder || !slOrder) throw new Error('TP/SL placement failed')
  const tpId = tpOrder?.clientAlgoId ?? tpOrder?.algoId ?? String(tpOrder?.orderId ?? '')
  const slId = slOrder?.clientAlgoId ?? slOrder?.algoId ?? String(slOrder?.orderId ?? '')
  return {
    tpAlgoId: tpId ? String(tpId) : null,
    slAlgoId: slId ? String(slId) : null,
    tpTrigger: Number.parseFloat(computed.tpPrice),
    slTrigger: Number.parseFloat(computed.slPrice),
  }
}

async function insertAgent2Trade(payload) {
  const { supabaseRest } = ctx()
  const rows = await supabaseRest('/rest/v1/agent2_trades?select=*', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

async function patchTrade(tradeId, patch) {
  const { supabaseRest } = ctx()
  if (!SPIKE_ROW_UUID_RE.test(String(tradeId))) return null
  const rows = await supabaseRest(`/rest/v1/agent2_trades?id=eq.${encodeURIComponent(tradeId)}&select=*`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

/**
 * The bar that just completed has openTime = (floor(now/interval)*interval) - interval.
 * Requires Binance klines in chronological order; avoids using the still-forming last row.
 */
function pickLastCompletedIntervalBar(candles, intervalMs, nowMs = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 2 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null
  }
  const currentOpen = Math.floor(nowMs / intervalMs) * intervalMs
  const expectedOpen = currentOpen - intervalMs
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]
    if (c && Number.isFinite(c.openTime) && c.openTime === expectedOpen) return c
  }
  return null
}

function shouldSkipSpikeInsideOpenBracket(openTrade, newSpikeLow) {
  const sl = Number(openTrade.sl_trigger_price)
  const tp = Number(openTrade.tp_trigger_price)
  const L2 = Number(newSpikeLow)
  if (!Number.isFinite(L2)) return false
  if (Number.isFinite(sl) && Number.isFinite(tp) && L2 > sl && L2 < tp) return true
  return false
}

function openTradeOnSymbol(openTrades, symbol) {
  const sym = String(symbol ?? '').toUpperCase()
  return openTrades.find((tr) => String(tr.symbol ?? '').toUpperCase() === sym) ?? null
}

function shouldSkipSpikeInsideAnySameSymbolBracket(openTrades, symbol, newSpikeLow) {
  for (const tr of openTrades) {
    if (String(tr.symbol ?? '').toUpperCase() !== String(symbol ?? '').toUpperCase()) continue
    if (tr.bracket_state === 'placed' && shouldSkipSpikeInsideOpenBracket(tr, newSpikeLow)) return true
  }
  return false
}

/**
 * Scan universe for green body spikes on last closed bar; optionally arm TAKE_PROFIT_MARKET entries.
 */
export async function runAgent2ScanTick() {
  const { futuresBase, supabaseRest } = ctx()
  const settings = await readAgent2Settings()
  if (!settings.agentEnabled || !settings.signalsSchedulerEnabled) {
    agent2SchedulerState.scanLeaseOwner = false
    return { spikes: 0, skipped: 'master_or_signals_off' }
  }

  if (canUseAgent2ScanDbCoordination()) {
    try {
      const leaseOk = await tryAcquireAgent2ScanLease()
      agent2SchedulerState.scanLeaseOwner = leaseOk
      if (!leaseOk) {
        return { spikes: 0, skipped: 'not_scan_lease_owner' }
      }
    } catch (e) {
      agent2SchedulerState.scanLeaseOwner = false
      const msg = e instanceof Error ? e.message : String(e)
      agent2SchedulerState.lastError = `scan lease error: ${msg}`
      throw e
    }
  } else {
    agent2SchedulerState.scanLeaseOwner = true
  }

  const volRows = await computeFutures24hVolumes(futuresBase)
  const minV = settings.scanMinQuoteVolume
  const filtered = volRows
    .filter((r) => Number.isFinite(r.quoteVolume24h) && r.quoteVolume24h >= minV)
    .slice(0, settings.scanMaxSymbols)

  const scanRunAt = new Date().toISOString()
  const threshold = settings.scanThresholdPct
  let spikeCount = 0

  const maxOpen = settings.maxOpenPositions
  const openTrades = await listAgent2OpenTrades(500)
  const openCount = openTrades.length
  const intervalMs = AGENT1_INTERVAL_MS[settings.scanInterval] ?? AGENT1_INTERVAL_MS['5m']
  const scanNowMs = Date.now()

  for (const row of filtered) {
    const symbol = row.symbol
    let candles
    try {
      candles = await fetchAgent1ShadowKlines(futuresBase, symbol, settings.scanInterval, 24)
    } catch {
      continue
    }
    if (!Array.isArray(candles) || candles.length < 2) continue
    const lastClosed = pickLastCompletedIntervalBar(candles, intervalMs, scanNowMs)
    if (!lastClosed || !Number.isFinite(lastClosed.openTime)) continue

    if (!isGreenBodySpike(lastClosed, threshold)) continue

    const baseR = lastClosed.close - lastClosed.low
    if (!(Number.isFinite(baseR) && baseR > 0)) continue

    const spikePayload = {
      candle_open_time_ms: lastClosed.openTime,
      symbol,
      spike_low: lastClosed.low,
      spike_high: lastClosed.high,
      spike_open: lastClosed.open,
      spike_close: lastClosed.close,
      base_r: baseR,
      quote_volume_24h: row.quoteVolume24h ?? null,
      scan_run_at: scanRunAt,
      status: 'recorded',
    }

    let ins
    try {
      ins = await supabaseRest('/rest/v1/agent2_spikes?on_conflict=candle_open_time_ms,symbol&select=*', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(spikePayload),
      })
    } catch {
      continue
    }
    const spikeRow = Array.isArray(ins) && ins[0] ? ins[0] : null
    if (!spikeRow?.id) continue
    spikeCount += 1

    if (!settings.agentEnabled || !settings.tradingEnabled) continue

    if (openCount >= maxOpen) {
      await patchSpike(spikeRow.id, { status: 'deferred', skip_reason: 'max_open_positions' })
      continue
    }

    if (openTradeOnSymbol(openTrades, symbol)) {
      await patchSpike(spikeRow.id, { status: 'deferred', skip_reason: 'already_open_symbol' })
      continue
    }

    if (shouldSkipSpikeInsideAnySameSymbolBracket(openTrades, symbol, spikeRow.spike_low)) {
      await patchSpike(spikeRow.id, { status: 'skipped', skip_reason: 'inside_open_tp_sl_band' })
      continue
    }

    const apiKey = process.env.BINANCE_API_KEY
    const apiSecret = process.env.BINANCE_API_SECRET
    if (!apiKey || !apiSecret) {
      pushAgent2Log('warn', 'trading on but Binance keys missing')
      continue
    }

    try {
      await armOrReplaceEntry(apiKey, apiSecret, settings, spikeRow)
    } catch (e) {
      pushAgent2Log('error', `${symbol} arm failed: ${e instanceof Error ? e.message : e}`)
      await patchSpike(spikeRow.id, { status: 'arm_failed', skip_reason: String(e instanceof Error ? e.message : e).slice(0, 200) })
    }
  }

  return { spikes: spikeCount }
}

async function armOrReplaceEntry(apiKey, apiSecret, settings, spikeRow) {
  const { supabaseRest } = ctx()
  const symbol = String(spikeRow.symbol ?? '').toUpperCase()
  const existingOrders = await supabaseRest(
    `/rest/v1/agent2_entry_orders?select=*&symbol=eq.${encodeURIComponent(symbol)}&status=in.(NEW,PARTIALLY_FILLED)&order=created_at.desc&limit=5`,
  )
  const existing = Array.isArray(existingOrders) && existingOrders[0] ? existingOrders[0] : null

  if (existing && existing.binance_order_id) {
    const oid = Number.parseInt(String(existing.binance_order_id), 10)
    if (Number.isFinite(oid)) {
      await cancelBinanceOrder(apiKey, apiSecret, symbol, oid)
    }
    await patchEntryOrder(existing.id, { status: 'CANCELED', last_exchange_status: 'replaced' })
    const oldSpikeId = existing.spike_id
    if (oldSpikeId && SPIKE_ROW_UUID_RE.test(String(oldSpikeId))) {
      await patchSpike(oldSpikeId, {
        status: 'replaced',
        replaced_by_spike_id: spikeRow.id,
        skip_reason: 'newer_spike',
      })
    }
  }

  const placed = await placeRetestEntryOrder(apiKey, apiSecret, settings, spikeRow)
  const orderRows = await supabaseRest('/rest/v1/agent2_entry_orders?select=*', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      spike_id: spikeRow.id,
      symbol,
      binance_order_id: placed.binanceOrderId,
      client_order_id: placed.clientOrderId,
      stop_price: placed.stopPrice,
      status: 'NEW',
      last_exchange_status: String(placed.order?.algoStatus ?? placed.order?.status ?? 'NEW'),
    }),
  })
  if (!Array.isArray(orderRows) || !orderRows[0]) {
    throw new Error('failed to persist entry order row')
  }
  await patchSpike(spikeRow.id, { status: 'pending_entry' })
  for (const w of placed.warnings ?? []) pushAgent2Log('warn', `${symbol}: ${w}`)
  pushAgent2Log(
    'info',
    `armed TAKE_PROFIT_MARKET BUY ${symbol} trigger ${placed.stopPrice} algoId ${placed.binanceOrderId}`,
  )
}

export async function runAgent2ExecutionTick() {
  if (agent2ExecutionState.running) return
  const supabaseOk = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  if (!supabaseOk) return

  if (canUseAgent2ExecutionDbCoordination()) {
    try {
      const leaseOk = await tryAcquireAgent2ExecutionLease()
      agent2ExecutionState.leaseOwner = leaseOk
      if (!leaseOk) return
    } catch (e) {
      agent2ExecutionState.leaseOwner = false
      agent2ExecutionState.lastError = e instanceof Error ? e.message : String(e)
      pushAgent2Log('error', `lease ${agent2ExecutionState.lastError}`)
      return
    }
  } else {
    agent2ExecutionState.leaseOwner = true
  }

  agent2ExecutionState.running = true
  agent2ExecutionState.lastError = null
  try {
    const settings = await readAgent2Settings()
    const apiKey = process.env.BINANCE_API_KEY
    const apiSecret = process.env.BINANCE_API_SECRET

    if (!settings.agentEnabled || !settings.tradingEnabled) {
      const reason = !settings.agentEnabled ? 'agent_disabled' : 'trading_disabled'
      const pending = await listActiveEntryOrders()
      const haveKeys = Boolean(apiKey && apiSecret)
      if (!haveKeys && pending.length > 0) {
        pushAgent2Log('warn', `${reason}: Binance keys missing — cancel entry orders on exchange manually`)
      }
      for (const p of pending) {
        const oid = Number.parseInt(String(p.binance_order_id ?? ''), 10)
        if (haveKeys && Number.isFinite(oid)) {
          try {
            await cancelBinanceOrder(apiKey, apiSecret, p.symbol, oid)
          } catch {
            /* */
          }
        }
        await patchEntryOrder(p.id, { status: 'CANCELED', last_exchange_status: reason })
        if (p.spike_id) await patchSpike(p.spike_id, { status: 'canceled', skip_reason: reason })
      }
      return
    }

    if (!apiKey || !apiSecret) return

    const openTrades = await listAgent2OpenTrades(500)
    for (const tr of openTrades) {
      if (tr.bracket_state !== 'pending') continue
      const spikeRow = tr.spike_id ? await fetchSpikeById(tr.spike_id) : null
      if (!spikeRow) continue
      const ep = Number(tr.entry_price)
      const qty = String(tr.quantity ?? '')
      if (!Number.isFinite(ep) || ep <= 0 || !qty) continue
      try {
        const br = await placeExitBrackets(apiKey, apiSecret, tr, spikeRow, settings, ep)
        await patchTrade(tr.id, {
          bracket_state: 'placed',
          tp_algo_id: br.tpAlgoId,
          sl_algo_id: br.slAlgoId,
          tp_trigger_price: br.tpTrigger,
          sl_trigger_price: br.slTrigger,
        })
        pushAgent2Log('info', `bracket placed ${tr.symbol} TP ${br.tpTrigger} SL ${br.slTrigger}`)
      } catch (e) {
        await patchTrade(tr.id, { bracket_state: 'failed' })
        pushAgent2Log('error', `bracket failed ${tr.symbol}: ${e instanceof Error ? e.message : e}`)
      }
    }

    const entries = await listActiveEntryOrders()
    for (const ent of entries) {
      const oid = Number.parseInt(String(ent.binance_order_id ?? ''), 10)
      if (!Number.isFinite(oid)) continue
      let ex
      try {
        ex = await fetchBinanceOrder(apiKey, apiSecret, ent.symbol, oid)
      } catch (e) {
        pushAgent2Log('warn', `order query ${ent.symbol} ${oid}: ${e instanceof Error ? e.message : e}`)
        continue
      }
      if (!ex) continue
      const st = String(ex.status ?? '').toUpperCase()
      await patchEntryOrder(ent.id, { last_exchange_status: String(ex._algoStatus ?? st) })
      if (st === 'FILLED') {
        const avg = Number.parseFloat(String(ex?.avgPrice ?? ex?.price ?? ''))
        const cumQty = Number.parseFloat(String(ex?.executedQty ?? ex?.cumQty ?? ''))
        const { getSymbolSpec, quantizeToStep } = ctx()
        const spec = await getSymbolSpec(String(ent.symbol).toUpperCase())
        const q = quantizeToStep(cumQty, spec.stepSize, 'floor')

        const spikeRow = ent.spike_id ? await fetchSpikeById(ent.spike_id) : null
        if (spikeRow) await patchSpike(spikeRow.id, { status: 'filled' })
        await patchEntryOrder(ent.id, { status: 'FILLED' })

        const trade = await insertAgent2Trade({
          spike_id: ent.spike_id,
          symbol: String(ent.symbol).toUpperCase(),
          side: 'BUY',
          position_side: 'LONG',
          status: 'open',
          theoretical_entry: spikeRow ? Number(spikeRow.spike_low) : null,
          entry_price: Number.isFinite(avg) && avg > 0 ? avg : null,
          quantity: Number.isFinite(q) ? q : null,
          entry_order_id: oid,
          bracket_state: 'pending',
        })
        if (trade?.id) {
          pushAgent2Log('info', `entry filled ${ent.symbol} avg ${avg} → trade ${trade.id}`)
          try {
            const br = await placeExitBrackets(apiKey, apiSecret, trade, spikeRow, settings, avg)
            await patchTrade(trade.id, {
              bracket_state: 'placed',
              tp_algo_id: br.tpAlgoId,
              sl_algo_id: br.slAlgoId,
              tp_trigger_price: br.tpTrigger,
              sl_trigger_price: br.slTrigger,
            })
            pushAgent2Log('info', `bracket placed ${ent.symbol}`)
          } catch (e) {
            await patchTrade(trade.id, { bracket_state: 'failed' })
            pushAgent2Log('error', `bracket after fill failed ${ent.symbol}: ${e instanceof Error ? e.message : e}`)
          }
        }
      } else if (st === 'CANCELED' || st === 'EXPIRED' || st === 'REJECTED') {
        await patchEntryOrder(ent.id, { status: st })
        if (ent.spike_id) await patchSpike(ent.spike_id, { status: 'canceled', skip_reason: `exchange_${st}` })
      }
    }

    const rec = await reconcileAgent2OpenTradesWithExchange(apiKey, apiSecret)
    if (rec.closedNow > 0) {
      pushAgent2Log('info', `closed detected: ${rec.closedNow}`)
    }
  } catch (e) {
    agent2ExecutionState.lastError = e instanceof Error ? e.message : String(e)
    pushAgent2Log('error', `tick ${agent2ExecutionState.lastError}`)
  } finally {
    agent2ExecutionState.lastRunAt = Date.now()
    agent2ExecutionState.running = false
  }
}

/** @type {{ nextFireAt: number | null, lastRunAt: number | null, lastError: string | null, lastSpikeCount: number | null, running: boolean, scanLeaseOwner: boolean }} */
export const agent2SchedulerState = {
  nextFireAt: null,
  lastRunAt: null,
  lastError: null,
  lastSpikeCount: null,
  running: false,
  scanLeaseOwner: false,
}

export function startAgent2ScanScheduler({ futuresBase, logger = console }) {
  let timer = null
  let stopped = false
  const stop = () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  if (process.env.AGENT2_SCAN_SCHEDULER === 'false') {
    logger.log?.('[agent2-scan] scheduler off (AGENT2_SCAN_SCHEDULER=false)')
    return { stop, state: agent2SchedulerState }
  }

  async function scheduleNext() {
    if (stopped) return
    let s
    try {
      s = await readAgent2Settings()
    } catch (e) {
      agent2SchedulerState.lastError = e instanceof Error ? e.message : String(e)
      timer = setTimeout(scheduleNext, 60_000)
      return
    }
    const intervalMs = agent1IntervalMs(s.scanInterval)
    const { delayMs, nextFireAt } = msUntilNextScanAfterBarClose(
      Date.now(),
      s.scanSecondsAfterClose,
      intervalMs,
    )
    agent2SchedulerState.nextFireAt = nextFireAt
    timer = setTimeout(runTick, delayMs)
  }

  async function runTick() {
    if (stopped) return
    agent2SchedulerState.running = true
    agent2SchedulerState.lastError = null
    try {
      const out = await runAgent2ScanTick()
      if (out.skipped !== 'not_scan_lease_owner') {
        agent2SchedulerState.lastRunAt = Date.now()
        agent2SchedulerState.lastSpikeCount = out.spikes ?? 0
      }
    } catch (e) {
      agent2SchedulerState.lastError = e instanceof Error ? e.message : String(e)
      logger.error?.('[agent2-scan] tick failed', e)
    } finally {
      agent2SchedulerState.running = false
      scheduleNext()
    }
  }

  scheduleNext()
  logger.log?.('[agent2-scan] scheduler started')
  return { stop, state: agent2SchedulerState }
}

export async function runAgent2ScanOnce() {
  return runAgent2ScanTick()
}
