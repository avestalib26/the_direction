import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, CrosshairMode, LineSeries, createChart } from 'lightweight-charts'
import { synthTradeTime } from './spikeTpSlLightweightCharts.jsx'

const COL_BG = '#000000'
const COL_TEXT = '#e2e8f0'
const COL_GRID = '#1a1a1a'
const COL_EMA = '#f59e0b'
/** Candles: green = cumulative % up vs prior step, red = down (same on all four charts). */
const COL_CANDLE_UP = '#22c55e'
const COL_CANDLE_DOWN = '#ef4444'
const EMA_PERIOD_FIXED = 50

/** Must match `AGENT1_SCAN_INTERVALS` in server/agent1ScanIntervals.js */
const SHADOW_SCAN_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
]

/** How often the UI pulls the snapshot (server sim still advances on each closed bar of the chosen TF). */
const LIVE_POLL_MS = 20000

const TRADE_TABLE_INITIAL_ROWS = 20
const TRADE_TABLE_MORE_ROWS = 100

/** `slice(-0)` is treated as `slice(0)` (full array). Never use 0 as a visible row count when total > 0. */
function clampTradeTableRows(prev, total) {
  if (total <= 0) return TRADE_TABLE_INITIAL_ROWS
  const capped = Math.min(prev, total)
  if (capped === 0) return Math.min(TRADE_TABLE_INITIAL_ROWS, total)
  return capped
}

/** Last k rows (newest when array is oldest-first), newest first for display. */
function recentRowsNewestFirst(arr, visibleCount, total) {
  if (!Array.isArray(arr) || total <= 0) return []
  const k = Math.min(visibleCount, total)
  return [...arr.slice(-k)].reverse()
}

function fmtIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString()
}

/** Scheduler “Next fire” / sim status — India Standard Time (matches live ops tables). */
function fmtIst(msOrIso) {
  if (msOrIso == null) return '—'
  const t = typeof msOrIso === 'number' ? msOrIso : Date.parse(String(msOrIso))
  if (!Number.isFinite(t)) return '—'
  return `${new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' })} IST`
}

function fmtShortAgo(msOrIso) {
  if (msOrIso == null) return '—'
  const t = typeof msOrIso === 'number' ? msOrIso : Date.parse(String(msOrIso))
  if (!Number.isFinite(t)) return '—'
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 1) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function fmtLocalTime(msOrIso) {
  if (msOrIso == null) return '—'
  const t = typeof msOrIso === 'number' ? msOrIso : Date.parse(String(msOrIso))
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString()
}

function fmtPctConfig(v) {
  const n = Number(v)
  return Number.isFinite(n) ? `${n}%` : '—'
}

function fmtPrice(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (abs >= 1) {
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 })
}

function OngoingTpSlCell({ tpPrice, slPrice }) {
  const tp = Number(tpPrice)
  const sl = Number(slPrice)
  const tpOk = Number.isFinite(tp)
  const slOk = Number.isFinite(sl)
  if (!tpOk && !slOk) {
    return <span className="cell-mono">—</span>
  }
  return (
    <span className="cell-mono longsim5m-tp-sl-cell">
      <span title="Take profit">{tpOk ? fmtPrice(tp) : '—'}</span>
      <span className="longsim5m-meta-muted"> / </span>
      <span title="Stop loss">{slOk ? fmtPrice(sl) : '—'}</span>
    </span>
  )
}

/** Fallback: synthetic x when no candle window. */
function curveToLineDataSynth(curve) {
  const out = [{ time: synthTradeTime(0), value: 0 }]
  if (!Array.isArray(curve) || curve.length === 0) {
    out.push({ time: synthTradeTime(1), value: 0 })
    return out
  }
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]
    const k = Number.isFinite(p.tradeIndex) ? p.tradeIndex : i + 1
    const v = Number(p.cumulativePnlPct)
    if (!Number.isFinite(v)) continue
    out.push({ time: synthTradeTime(k), value: v })
  }
  if (out.length < 2) out.push({ time: synthTradeTime(1), value: 0 })
  return out
}

function curveToLineDataUtc(curve, firstOpenTimeMs) {
  const toSec = (ms) => {
    const u = Math.floor(Number(ms) / 1000)
    return Number.isFinite(u) ? u : null
  }
  const used = new Set()
  const uniq = (t) => {
    let x = t
    while (used.has(x)) x += 1
    used.add(x)
    return x
  }
  const t0 = toSec(firstOpenTimeMs)
  if (t0 == null) return curveToLineDataSynth(curve)

  const out = [{ time: uniq(t0), value: 0 }]
  if (!Array.isArray(curve) || curve.length === 0) {
    out.push({ time: uniq(t0 + 300), value: 0 })
    return out
  }
  for (const p of curve) {
    const ts = toSec(p.time ?? p.exitOpenTime)
    if (ts == null) continue
    const v = Number(p.cumulativePnlPct)
    if (!Number.isFinite(v)) continue
    out.push({ time: uniq(ts), value: v })
  }
  if (out.length < 2) {
    out.push({ time: uniq(t0 + 300), value: out[out.length - 1].value })
  }
  return out
}

function emaOnValues(values, period) {
  const out = values.map(() => null)
  if (!Array.isArray(values) || values.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    ema = values[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

function lineEmaData(lineData, period) {
  if (!Array.isArray(lineData) || lineData.length === 0) return null
  const vals = lineData.map((d) => Number(d.value))
  const emaArr = emaOnValues(vals, period)
  const out = []
  for (let i = 0; i < lineData.length; i++) {
    const v = emaArr[i]
    if (!Number.isFinite(v)) continue
    out.push({ time: lineData[i].time, value: v })
  }
  return out.length >= 2 ? out : null
}

function regimeEquityAbove(cum, emaVal) {
  if (!Number.isFinite(cum)) return false
  if (emaVal == null || !Number.isFinite(emaVal)) return true
  return cum > emaVal
}

/** Bearish / bullish cross events on exit-ordered cumulative Σ% (time = close of the bar that completes the cross). */
function buildEmaCrossEventsExitOrder(sortedExitAsc, emaPeriod) {
  const n = sortedExitAsc.length
  const values = [0]
  for (let i = 0; i < n; i++) {
    const p = Number(sortedExitAsc[i]?.pnlPct)
    const prev = values[values.length - 1]
    values.push(prev + (Number.isFinite(p) ? p : 0))
  }
  const emaArr = emaOnValues(values, emaPeriod)
  const events = []
  for (let k = 1; k <= n; k++) {
    const before = values[k - 1]
    const after = values[k]
    const eBefore = emaArr[k - 1]
    const eAfter = emaArr[k]
    const ab0 = regimeEquityAbove(before, eBefore)
    const ab1 = regimeEquityAbove(after, eAfter)
    const exitT = Number(sortedExitAsc[k - 1]?.time ?? sortedExitAsc[k - 1]?.exitOpenTime)
    if (!Number.isFinite(exitT)) continue
    if (ab0 && !ab1) events.push({ type: 'bear', time: exitT })
    else if (!ab0 && ab1) events.push({ type: 'bull', time: exitT })
  }
  return events
}

/** True if new entries are allowed at entryTimeMs: after last bearish cross before entry, we need a bullish cross. */
function entryAllowedBeforeCrossEvents(entryTimeMs, events) {
  const te = Number(entryTimeMs)
  if (!Number.isFinite(te)) return false
  let blocked = false
  for (const ev of events) {
    if (!Number.isFinite(ev.time)) continue
    if (ev.time >= te) break
    if (ev.type === 'bear') blocked = true
    else if (ev.type === 'bull') blocked = false
  }
  return !blocked
}

function appendFilteredOpenMarkStep(out, finalSum, markTimeMs, events, ongoingRows) {
  if (!Array.isArray(out) || ongoingRows == null) return
  let markMs = Number(markTimeMs)
  if (!Number.isFinite(markMs)) {
    for (const row of ongoingRows) {
      if (!entryAllowedBeforeCrossEvents(row?.entryOpenTime, events)) continue
      const ex = Number(row?.exitOpenTime)
      if (Number.isFinite(ex)) markMs = Number.isFinite(markMs) ? Math.max(markMs, ex) : ex
    }
  }
  let tt = Number.isFinite(markMs) ? Math.floor(markMs / 1000) : null
  if (!Number.isFinite(tt) && out.length > 0) tt = out[out.length - 1].time + 1
  if (!Number.isFinite(tt)) return
  while (out.some((x) => x.time === tt)) tt += 1
  out.push({ time: tt, value: finalSum })
}

/** Apply current allowed ongoing MTM as a constant overlay on every filtered step (what-if view). */
function applyOngoingMtmToAllFilteredSteps(data, ongoingMtmPct) {
  const mtm = Number(ongoingMtmPct)
  if (!Array.isArray(data)) return []
  if (!Number.isFinite(mtm) || mtm === 0) return data.map((p) => ({ ...p }))
  return data.map((p, idx) => {
    const v = Number(p?.value)
    if (!Number.isFinite(v)) return { ...p }
    // Keep the synthetic origin anchor unchanged for readability.
    if (idx === 0) return { ...p }
    return { ...p, value: v + mtm }
  })
}

/**
 * Realized PnL after EMA **cross** rule (exit-ordered curve): cumulative Σ% vs EMA on closed-trade steps.
 * Bearish cross (above→below) blocks **new** entries after that close; bullish cross unblocks. Trades opened
 * before a bearish cross still count at exit (TP/SL); trades opened while blocked are skipped.
 *
 * **Ongoing** rows (same cross regime): sum mark `pnlPct` for opens that were allowed at entry, append one
 * step at `markTimeMs` (last bar) like the main live curve’s open mark.
 */
function computeEmaFilteredClosedCurveCrossRegime(
  closedCurve,
  firstOpenTimeMs,
  emaPeriod,
  ongoingRows = [],
  markTimeMs = null,
) {
  const sortedExit = [...(closedCurve ?? [])].sort((a, b) => {
    const ax = Number(a?.time ?? a?.exitOpenTime)
    const bx = Number(b?.time ?? b?.exitOpenTime)
    if (Number.isFinite(ax) && Number.isFinite(bx) && ax !== bx) return ax - bx
    if (Number.isFinite(ax) !== Number.isFinite(bx)) return Number.isFinite(ax) ? -1 : 1
    const sy = String(a?.symbol ?? '').localeCompare(String(b?.symbol ?? ''))
    if (sy !== 0) return sy
    return Number(a?.entryOpenTime ?? 0) - Number(b?.entryOpenTime ?? 0)
  })
  const n = sortedExit.length
  const src0 = curveToLineDataUtc(sortedExit.length ? sortedExit : closedCurve ?? [], firstOpenTimeMs)
  const outClosedOnly = [{ time: src0[0].time, value: 0 }]
  if (n === 0) {
    const events = []
    let ongoingMtmPct = 0
    let ongoingKeptCount = 0
    if (Array.isArray(ongoingRows)) {
      for (const row of ongoingRows) {
        if (!entryAllowedBeforeCrossEvents(row?.entryOpenTime, events)) continue
        const u = Number(row?.pnlPct)
        if (!Number.isFinite(u)) continue
        ongoingKeptCount += 1
        ongoingMtmPct += u
      }
    }
    const out = [...outClosedOnly]
    if (ongoingKeptCount > 0) {
      appendFilteredOpenMarkStep(out, ongoingMtmPct, markTimeMs, events, ongoingRows ?? [])
    }
    if (out.length < 2) out.push({ time: out[0].time + 300, value: 0 })
    const dataOngoingEveryStep = applyOngoingMtmToAllFilteredSteps(outClosedOnly, ongoingMtmPct)
    if (dataOngoingEveryStep.length < 2) {
      dataOngoingEveryStep.push({
        time: dataOngoingEveryStep[0].time + 300,
        value: Number.isFinite(ongoingMtmPct) ? ongoingMtmPct : 0,
      })
    }
    const sumPnlPctEveryStep =
      dataOngoingEveryStep.length > 0
        ? Number(dataOngoingEveryStep[dataOngoingEveryStep.length - 1]?.value) || 0
        : 0
    return {
      data: out,
      dataOngoingEveryStep,
      keptCount: 0,
      totalCount: 0,
      sumPnlPct: ongoingMtmPct,
      sumPnlPctEveryStep,
      sumClosedFiltered: 0,
      ongoingKeptCount,
      ongoingMtmPct,
    }
  }

  const events = buildEmaCrossEventsExitOrder(sortedExit, emaPeriod)
  let sum = 0
  let kept = 0
  for (let i = 0; i < n; i++) {
    const row = sortedExit[i]
    if (!entryAllowedBeforeCrossEvents(row?.entryOpenTime, events)) continue
    const tradePnlPct = Number(row?.pnlPct)
    if (!Number.isFinite(tradePnlPct)) continue
    kept += 1
    sum += tradePnlPct
    const t = Math.floor(Number(row?.time ?? row?.exitOpenTime) / 1000)
    if (!Number.isFinite(t)) continue
    let tt = t
    while (outClosedOnly.some((x) => x.time === tt)) tt += 1
    outClosedOnly.push({ time: tt, value: sum })
  }

  let ongoingMtmPct = 0
  let ongoingKeptCount = 0
  if (Array.isArray(ongoingRows)) {
    for (const row of ongoingRows) {
      if (!entryAllowedBeforeCrossEvents(row?.entryOpenTime, events)) continue
      const u = Number(row?.pnlPct)
      if (!Number.isFinite(u)) continue
      ongoingKeptCount += 1
      ongoingMtmPct += u
    }
  }

  const dataOngoingEveryStep = applyOngoingMtmToAllFilteredSteps(outClosedOnly, ongoingMtmPct)
  if (dataOngoingEveryStep.length < 2 && dataOngoingEveryStep.length > 0) {
    dataOngoingEveryStep.push({
      time: dataOngoingEveryStep[0].time + 300,
      value: Number(dataOngoingEveryStep[0].value) || 0,
    })
  }

  const out = [...outClosedOnly]
  if (ongoingKeptCount > 0) {
    appendFilteredOpenMarkStep(out, sum + ongoingMtmPct, markTimeMs, events, ongoingRows ?? [])
  }

  if (out.length < 2) out.push({ time: out[0].time + 300, value: 0 })
  const sumTotal = sum + ongoingMtmPct
  const sumPnlPctEveryStep =
    dataOngoingEveryStep.length > 0
      ? Number(dataOngoingEveryStep[dataOngoingEveryStep.length - 1]?.value) || 0
      : 0
  return {
    data: out,
    dataOngoingEveryStep,
    keptCount: kept,
    totalCount: n,
    sumPnlPct: sumTotal,
    sumPnlPctEveryStep,
    sumClosedFiltered: sum,
    ongoingKeptCount,
    ongoingMtmPct,
  }
}

function chartSize(el) {
  return Math.max(280, el.clientWidth || el.offsetWidth || 600)
}

/** One candle per cumulative-PnL step: open = previous %, close = new % (same time scale as prior line chart). */
function pnlLineDataToCandlesticks(lineData) {
  if (!Array.isArray(lineData) || lineData.length < 2) return []
  const out = []
  for (let i = 1; i < lineData.length; i++) {
    const open = Number(lineData[i - 1].value)
    const close = Number(lineData[i].value)
    const t = lineData[i].time
    if (!Number.isFinite(open) || !Number.isFinite(close) || t == null) continue
    let hi = Math.max(open, close)
    let lo = Math.min(open, close)
    if (hi === lo) {
      hi += 1e-4
      lo -= 1e-4
    }
    out.push({ time: t, open, high: hi, low: lo, close })
  }
  return out
}

function SimPnlCandleChart({
  lineData,
  emaData = null,
  lineColor = COL_CANDLE_UP,
  downColor = COL_CANDLE_DOWN,
}) {
  const wrapRef = useRef(null)
  const candleData = useMemo(() => pnlLineDataToCandlesticks(lineData ?? []), [lineData])

  useLayoutEffect(() => {
    const el = wrapRef.current
    const line = lineData ?? []
    if (!el || line.length < 1) return undefined

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: COL_BG },
        textColor: COL_TEXT,
        fontFamily: 'system-ui, Segoe UI, sans-serif',
      },
      grid: {
        vertLines: { color: COL_GRID },
        horzLines: { color: COL_GRID },
      },
      crosshair: { mode: CrosshairMode.Normal },
      width: chartSize(el),
      height: 320,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      localization: {
        priceFormatter: (p) =>
          `${Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`,
      },
    })

    if (candleData.length >= 1) {
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: lineColor,
        downColor,
        borderUpColor: lineColor,
        borderDownColor: downColor,
        wickUpColor: lineColor,
        wickDownColor: downColor,
      })
      candleSeries.setData(candleData)
    } else {
      const series = chart.addSeries(LineSeries, {
        color: lineColor,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: true,
      })
      series.setData(line)
    }

    if (emaData && emaData.length >= 2) {
      const emaSeries = chart.addSeries(LineSeries, {
        color: COL_EMA,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      emaSeries.setData(emaData)
    }
    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: chartSize(el) })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [candleData, emaData, lineColor, downColor, lineData])

  return (
    <div
      ref={wrapRef}
      className="spike-tpsl-lw-chart longsim5m-chart"
      style={{ width: '100%', minHeight: 320, minWidth: 280 }}
    />
  )
}

export function LongSim5m() {
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')
  const [simParamsBusy, setSimParamsBusy] = useState(false)
  const [showOngoing1, setShowOngoing1] = useState(TRADE_TABLE_INITIAL_ROWS)
  const [showOngoing3, setShowOngoing3] = useState(TRADE_TABLE_INITIAL_ROWS)
  const [showClosed1, setShowClosed1] = useState(TRADE_TABLE_INITIAL_ROWS)
  const [showClosed3, setShowClosed3] = useState(TRADE_TABLE_INITIAL_ROWS)
  const [replayScanInterval, setReplayScanInterval] = useState('5m')
  const [replayMinQuoteVol, setReplayMinQuoteVol] = useState('')
  const [replayMaxSymbols, setReplayMaxSymbols] = useState('')
  const [replayBarCount, setReplayBarCount] = useState('')
  const [replayLongThreshold, setReplayLongThreshold] = useState('')
  const [replayShortThreshold, setReplayShortThreshold] = useState('')
  const [replayMaxSlLong, setReplayMaxSlLong] = useState('')
  const [replayMaxSlShort, setReplayMaxSlShort] = useState('')
  /** Authoritative pack from GET /api/agents/agent1/shadow-sim-config (Supabase row or code defaults). */
  const [shadowSimConfig, setShadowSimConfig] = useState(null)
  /** While true, do not overwrite replay inputs from polling (shadow-curve / config refresh). */
  const replayFormDirtyRef = useRef(false)
  const markReplayFormDirty = useCallback(() => {
    replayFormDirtyRef.current = true
  }, [])
  /** Bumps once per second so "Xs ago" stays accurate without polling every second. */
  const [, bumpAgeDisplay] = useState(0)

  const setupSectionRef = useRef(null)
  const chartsSectionRef = useRef(null)
  const ongoingSectionRef = useRef(null)
  const closedSectionRef = useRef(null)
  const [activeSimTab, setActiveSimTab] = useState('setup')

  const simSectionTabs = useMemo(
    () => [
      { id: 'setup', label: 'Setup', ref: setupSectionRef },
      { id: 'charts', label: 'Charts', ref: chartsSectionRef },
      { id: 'ongoing', label: 'Ongoing', ref: ongoingSectionRef },
      { id: 'closed', label: 'Closed', ref: closedSectionRef },
    ],
    [],
  )

  const onClickSimTab = useCallback((tab) => {
    setActiveSimTab(tab.id)
    const el = tab.ref.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const heads = simSectionTabs.map((t) => t.ref.current).filter(Boolean)
    if (heads.length === 0) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        const first = visible[0]
        if (!first) return
        const hit = simSectionTabs.find((t) => t.ref.current === first.target)
        if (hit) setActiveSimTab(hit.id)
      },
      {
        root: null,
        rootMargin: '-120px 0px -55% 0px',
        threshold: [0.15, 0.35, 0.6],
      },
    )
    for (const el of heads) observer.observe(el)
    return () => observer.disconnect()
  }, [simSectionTabs])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/agent1/shadow-curve', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      setPayload(data)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load simulation')
    }
  }, [])

  const loadShadowSimConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/agent1/shadow-sim-config', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setShadowSimConfig(null)
        return
      }
      setShadowSimConfig(data)
    } catch {
      setShadowSimConfig(null)
    }
  }, [])

  const ovrFormSyncKey = useMemo(
    () => JSON.stringify(payload?.shadowSimRuntimeOverrides ?? null),
    [payload?.shadowSimRuntimeOverrides],
  )

  useEffect(() => {
    if (replayFormDirtyRef.current) return

    const meta = payload?.settingsMeta
    const metaA3 = payload?.settingsMetaAgent3
    const o = payload?.shadowSimRuntimeOverrides ?? null
    const longDb = shadowSimConfig?.long
    const shortDb = shadowSimConfig?.short
    const longBase = longDb ?? meta?.shadowSimLongBaseline
    const shortBase = shortDb ?? metaA3?.shadowSimShortBaseline

    if (!longBase && !shortBase && !meta) return

    setReplayScanInterval(
      o?.scanInterval && typeof o.scanInterval === 'string'
        ? o.scanInterval
        : longBase?.scanInterval ?? meta?.scanInterval ?? '5m',
    )
    setReplayMinQuoteVol(
      o != null && o.scanMinQuoteVolume != null && Number.isFinite(Number(o.scanMinQuoteVolume))
        ? String(o.scanMinQuoteVolume)
        : longBase != null &&
            longBase.scanMinQuoteVolume != null &&
            Number.isFinite(Number(longBase.scanMinQuoteVolume))
          ? String(longBase.scanMinQuoteVolume)
          : meta != null &&
              meta.scanMinQuoteVolume != null &&
              Number.isFinite(Number(meta.scanMinQuoteVolume))
            ? String(meta.scanMinQuoteVolume)
            : '',
    )
    setReplayMaxSymbols(
      o != null && o.scanMaxSymbols != null && Number.isFinite(Number(o.scanMaxSymbols))
        ? String(o.scanMaxSymbols)
        : longBase != null &&
            longBase.scanMaxSymbols != null &&
            Number.isFinite(Number(longBase.scanMaxSymbols))
          ? String(longBase.scanMaxSymbols)
          : meta != null && meta.scanMaxSymbols != null && Number.isFinite(Number(meta.scanMaxSymbols))
            ? String(meta.scanMaxSymbols)
            : '',
    )
    if (payload) {
      setReplayBarCount(
        o != null && o.barCount != null && Number.isFinite(Number(o.barCount))
          ? String(o.barCount)
          : meta != null && meta.replayBarCount != null && Number.isFinite(Number(meta.replayBarCount))
            ? String(meta.replayBarCount)
            : '',
      )
    }
    setReplayLongThreshold(
      o != null && o.scanThresholdPct != null && Number.isFinite(Number(o.scanThresholdPct))
        ? String(o.scanThresholdPct)
        : longBase != null &&
            longBase.scanThresholdPct != null &&
            Number.isFinite(Number(longBase.scanThresholdPct))
          ? String(longBase.scanThresholdPct)
          : meta != null && meta.scanThresholdPct != null && Number.isFinite(Number(meta.scanThresholdPct))
            ? String(meta.scanThresholdPct)
            : '',
    )
    setReplayShortThreshold(
      o != null && o.shortThresholdPct != null && Number.isFinite(Number(o.shortThresholdPct))
        ? String(o.shortThresholdPct)
        : shortBase != null &&
            shortBase.scanThresholdPct != null &&
            Number.isFinite(Number(shortBase.scanThresholdPct))
          ? String(shortBase.scanThresholdPct)
          : metaA3 != null &&
              metaA3.scanThresholdPct != null &&
              Number.isFinite(Number(metaA3.scanThresholdPct))
            ? String(metaA3.scanThresholdPct)
            : '',
    )
    setReplayMaxSlLong(
      longBase != null && Number.isFinite(Number(longBase.maxSlPct))
        ? String(longBase.maxSlPct)
        : meta != null && Number.isFinite(Number(meta.maxSlPct))
          ? String(meta.maxSlPct)
          : '',
    )
    setReplayMaxSlShort(
      shortBase != null && Number.isFinite(Number(shortBase.maxSlPct))
        ? String(shortBase.maxSlPct)
        : metaA3 != null && Number.isFinite(Number(metaA3.maxSlPct))
          ? String(metaA3.maxSlPct)
          : '',
    )
  }, [payload, shadowSimConfig, ovrFormSyncKey])

  const applyReplayParams = useCallback(async () => {
    if (payload?.shadowSchedulerActive === false) return
    setSimParamsBusy(true)
    setError('')
    try {
      const longBase = shadowSimConfig?.long ?? payload?.settingsMeta?.shadowSimLongBaseline
      const shortBase = shadowSimConfig?.short ?? payload?.settingsMetaAgent3?.shadowSimShortBaseline

      const normNullFloat = (raw, baseline) => {
        const t = raw.trim()
        if (t === '') return null
        const v = Number.parseFloat(t)
        if (!Number.isFinite(v)) throw new Error('Invalid number')
        if (baseline != null && Number.isFinite(Number(baseline)) && Math.abs(v - Number(baseline)) < 1e-9) {
          return null
        }
        return v
      }
      const normNullInt = (raw, baseline) => {
        const t = raw.trim()
        if (t === '') return null
        const v = Number.parseInt(t, 10)
        if (!Number.isFinite(v)) throw new Error('Invalid integer')
        if (baseline != null && Number.isFinite(Number(baseline)) && v === Math.floor(Number(baseline))) {
          return null
        }
        return v
      }

      const slPatch = {}
      const slL = replayMaxSlLong.trim()
      const slS = replayMaxSlShort.trim()
      if (slL !== '') {
        const v = Number.parseFloat(slL)
        if (!Number.isFinite(v) || v <= 0) throw new Error('Long max SL % must be a number > 0')
        slPatch.maxSlPct = v
      }
      if (slS !== '') {
        const v = Number.parseFloat(slS)
        if (!Number.isFinite(v) || v <= 0) throw new Error('Short max SL % must be a number > 0')
        slPatch.shortMaxSlPct = v
      }
      if (Object.keys(slPatch).length > 0) {
        const resSl = await fetch('/api/agents/agent1/shadow-sim-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slPatch),
        })
        const dSl = await resSl.json().catch(() => ({}))
        if (!resSl.ok) {
          throw new Error(dSl.error || `shadow-sim-config failed (${resSl.status})`)
        }
      }

      const body = {
        scanInterval:
          replayScanInterval && replayScanInterval === longBase?.scanInterval ? null : replayScanInterval,
        scanMinQuoteVolume: normNullFloat(replayMinQuoteVol, longBase?.scanMinQuoteVolume),
        scanMaxSymbols: normNullInt(replayMaxSymbols, longBase?.scanMaxSymbols),
        barCount: (() => {
          if (replayBarCount.trim() === '') return null
          const v = Number.parseInt(replayBarCount.trim(), 10)
          if (!Number.isFinite(v) || v < 50 || v > 1500) throw new Error('Bars per symbol must be 50–1500')
          return v
        })(),
        scanThresholdPct: normNullFloat(replayLongThreshold, longBase?.scanThresholdPct),
        shortThresholdPct: normNullFloat(replayShortThreshold, shortBase?.scanThresholdPct),
      }
      const res = await fetch('/api/agents/agent1/shadow-sim-params', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      replayFormDirtyRef.current = false
      await load()
      await loadShadowSimConfig()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update replay parameters')
    } finally {
      setSimParamsBusy(false)
    }
  }, [
    load,
    loadShadowSimConfig,
    shadowSimConfig,
    payload?.shadowSchedulerActive,
    replayBarCount,
    replayLongThreshold,
    replayMaxSlLong,
    replayMaxSlShort,
    replayMaxSymbols,
    replayMinQuoteVol,
    replayScanInterval,
    replayShortThreshold,
    payload?.settingsMeta?.shadowSimLongBaseline,
    payload?.settingsMetaAgent3?.shadowSimShortBaseline,
  ])

  useEffect(() => {
    load()
    void loadShadowSimConfig()
    const t = setInterval(load, LIVE_POLL_MS)
    return () => clearInterval(t)
  }, [load, loadShadowSimConfig])

  useEffect(() => {
    const onShadowSim = () => {
      void load()
      void loadShadowSimConfig()
    }
    window.addEventListener('agent1-shadow-sim-changed', onShadowSim)
    return () => window.removeEventListener('agent1-shadow-sim-changed', onShadowSim)
  }, [load, loadShadowSimConfig])

  useEffect(() => {
    const id = setInterval(() => bumpAgeDisplay((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const sched = payload?.scheduler
  const shadowSchedulerActive = payload?.shadowSchedulerActive !== false
  const simulationPaused = payload?.simulationPaused === true
  const curve = payload?.curve
  const liveCurve = payload?.liveCurve
  const curveAgent3 = payload?.curveAgent3
  const liveCurveAgent3 = payload?.liveCurveAgent3
  const trades = payload?.trades
  const ongoingTrades = payload?.ongoingTrades
  const tradesA3 = payload?.agent3Trades
  const ongoingTradesA3 = payload?.agent3OngoingTrades
  const lastBarOpenTime = payload?.lastBarOpenTime
  const tradeN = Array.isArray(trades) ? trades.length : 0
  const tradeN3 = Array.isArray(tradesA3) ? tradesA3.length : 0
  const ongoingN = Array.isArray(ongoingTrades) ? ongoingTrades.length : 0
  const ongoingN3 = Array.isArray(ongoingTradesA3) ? ongoingTradesA3.length : 0

  useEffect(() => {
    setShowOngoing1((s) => clampTradeTableRows(s, ongoingN))
  }, [ongoingN])

  useEffect(() => {
    setShowOngoing3((s) => clampTradeTableRows(s, ongoingN3))
  }, [ongoingN3])

  useEffect(() => {
    setShowClosed1((s) => clampTradeTableRows(s, tradeN))
  }, [tradeN])

  useEffect(() => {
    setShowClosed3((s) => clampTradeTableRows(s, tradeN3))
  }, [tradeN3])

  const lineStartMs = useMemo(() => {
    if (Array.isArray(trades) && trades.length > 0) {
      const t0 = trades[0].spikeOpenTime ?? trades[0].entryOpenTime
      if (Number.isFinite(t0)) return t0
    }
    if (Array.isArray(curve) && curve.length > 0) {
      const t0 = curve[0].spikeOpenTime ?? curve[0].entryOpenTime
      if (Number.isFinite(t0)) return t0
    }
    return null
  }, [trades, curve])

  const lineStartMsA3 = useMemo(() => {
    if (Array.isArray(tradesA3) && tradesA3.length > 0) {
      const t0 = tradesA3[0].spikeOpenTime ?? tradesA3[0].entryOpenTime
      if (Number.isFinite(t0)) return t0
    }
    if (Array.isArray(curveAgent3) && curveAgent3.length > 0) {
      const t0 = curveAgent3[0].spikeOpenTime ?? curveAgent3[0].entryOpenTime
      if (Number.isFinite(t0)) return t0
    }
    return null
  }, [tradesA3, curveAgent3])

  const lineSource = Array.isArray(curve) ? curve : []
  const lineSourceA3 = Array.isArray(curveAgent3) ? curveAgent3 : []
  const lineData = useMemo(() => curveToLineDataUtc(lineSource, lineStartMs), [lineSource, lineStartMs])
  const lineDataA3 = useMemo(
    () => curveToLineDataUtc(lineSourceA3, lineStartMsA3),
    [lineSourceA3, lineStartMsA3],
  )
  const emaPeriod = EMA_PERIOD_FIXED
  const emaData = useMemo(() => lineEmaData(lineData, emaPeriod), [lineData, emaPeriod])
  const emaDataA3 = useMemo(() => lineEmaData(lineDataA3, emaPeriod), [lineDataA3, emaPeriod])
  const emaFiltered = useMemo(
    () =>
      computeEmaFilteredClosedCurveCrossRegime(
        curve,
        lineStartMs,
        emaPeriod,
        [],
        lastBarOpenTime,
      ),
    [curve, lineStartMs, emaPeriod, lastBarOpenTime],
  )
  const emaFilteredA3 = useMemo(
    () =>
      computeEmaFilteredClosedCurveCrossRegime(
        curveAgent3 ?? [],
        lineStartMsA3,
        emaPeriod,
        [],
        lastBarOpenTime,
      ),
    [curveAgent3, lineStartMsA3, emaPeriod, lastBarOpenTime],
  )

  const emaOnFilteredA1 = useMemo(
    () => lineEmaData(emaFiltered.data, emaPeriod),
    [emaFiltered.data, emaPeriod],
  )
  const emaOnFilteredA3 = useMemo(
    () => lineEmaData(emaFilteredA3.data, emaPeriod),
    [emaFilteredA3.data, emaPeriod],
  )
  const latestCum = lineData.length ? Number(lineData[lineData.length - 1]?.value) : null
  const latestEma = emaData?.length ? Number(emaData[emaData.length - 1]?.value) : null
  const isAboveEma =
    Number.isFinite(latestCum) && Number.isFinite(latestEma)
      ? latestCum > latestEma
      : null

  const latestCumA3 = lineDataA3.length ? Number(lineDataA3[lineDataA3.length - 1]?.value) : null
  const latestEmaA3 = emaDataA3?.length ? Number(emaDataA3[emaDataA3.length - 1]?.value) : null
  const isAboveEmaA3 =
    Number.isFinite(latestCumA3) && Number.isFinite(latestEmaA3)
      ? latestCumA3 > latestEmaA3
      : null

  const totalUnrealizedPct = useMemo(() => {
    let s = 0
    let seen = 0
    for (const t of ongoingTrades ?? []) {
      const v = Number(t?.pnlPct)
      if (!Number.isFinite(v)) continue
      s += v
      seen += 1
    }
    return seen > 0 ? s : null
  }, [ongoingTrades])

  const totalUnrealizedR = useMemo(() => {
    let s = 0
    let seen = 0
    for (const t of ongoingTrades ?? []) {
      const v = Number(t?.rMultiple)
      if (!Number.isFinite(v)) continue
      s += v
      seen += 1
    }
    return seen > 0 ? s : null
  }, [ongoingTrades])

  const totalUnrealizedPctA3 = useMemo(() => {
    let s = 0
    let seen = 0
    for (const t of ongoingTradesA3 ?? []) {
      const v = Number(t?.pnlPct)
      if (!Number.isFinite(v)) continue
      s += v
      seen += 1
    }
    return seen > 0 ? s : null
  }, [ongoingTradesA3])

  const totalUnrealizedRA3 = useMemo(() => {
    let s = 0
    let seen = 0
    for (const t of ongoingTradesA3 ?? []) {
      const v = Number(t?.rMultiple)
      if (!Number.isFinite(v)) continue
      s += v
      seen += 1
    }
    return seen > 0 ? s : null
  }, [ongoingTradesA3])

  const ongoing1Visible = useMemo(
    () => recentRowsNewestFirst(ongoingTrades, showOngoing1, ongoingN),
    [ongoingTrades, ongoingN, showOngoing1],
  )

  const ongoing3Visible = useMemo(
    () => recentRowsNewestFirst(ongoingTradesA3, showOngoing3, ongoingN3),
    [ongoingTradesA3, ongoingN3, showOngoing3],
  )

  const closed1Visible = useMemo(
    () => recentRowsNewestFirst(trades, showClosed1, tradeN),
    [trades, tradeN, showClosed1],
  )

  const closed3Visible = useMemo(
    () => recentRowsNewestFirst(tradesA3, showClosed3, tradeN3),
    [tradesA3, tradeN3, showClosed3],
  )

  const ongoing1Shown = Math.min(showOngoing1, ongoingN)
  const ongoing3Shown = Math.min(showOngoing3, ongoingN3)
  const closed1Shown = Math.min(showClosed1, tradeN)
  const closed3Shown = Math.min(showClosed3, tradeN3)

  return (
    <div className="vol-screener agent1-page longsim5m-page">
      <nav className="agent1-tabs" aria-label="A1 and A3 simulation sections">
        {simSectionTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`agent1-tab ${activeSimTab === tab.id ? 'agent1-tab--active' : ''}`}
            onClick={() => onClickSimTab(tab)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div ref={setupSectionRef} className="agent1-anchor-target">
      {sched ? (
        <div className="risk-summary agent1-risk-summary longsim5m-status">
          <div className="risk-chip">
            Tick: <strong>{sched.running ? '…' : sched.lastRunAt ? 'idle' : 'start'}</strong>
            {sched.lastRunAt != null && fmtIst(sched.lastRunAt) !== '—' ? (
              <span className="longsim5m-meta-muted" title="Last scheduler tick (UTC in tooltip)">
                {' '}
                · last {fmtIst(sched.lastRunAt)}
              </span>
            ) : null}
          </div>
          <div className="risk-chip">
            Next:{' '}
            <strong title={sched.nextFireAt != null ? fmtIso(sched.nextFireAt) : undefined}>
              {fmtIst(sched.nextFireAt)}
            </strong>
          </div>
          <div className="risk-chip" title="Agent 1 ongoing unrealized PnL (sum of open legs)">
            A1 unrealized:{' '}
            <strong
              className={
                Number.isFinite(Number(totalUnrealizedPct))
                  ? Number(totalUnrealizedPct) >= 0
                    ? 'pnl-pos'
                    : 'pnl-neg'
                  : ''
              }
              style={{ fontSize: '1.02em' }}
            >
              {Number.isFinite(Number(totalUnrealizedPct))
                ? `${Number(totalUnrealizedPct) >= 0 ? '+' : ''}${Number(totalUnrealizedPct).toFixed(3)}%`
                : '—'}
            </strong>
          </div>
          <div className="risk-chip" title="Agent 3 ongoing unrealized PnL (sum of open legs)">
            A3 unrealized:{' '}
            <strong
              className={
                Number.isFinite(Number(totalUnrealizedPctA3))
                  ? Number(totalUnrealizedPctA3) >= 0
                    ? 'pnl-pos'
                    : 'pnl-neg'
                  : ''
              }
              style={{ fontSize: '1.02em' }}
            >
              {Number.isFinite(Number(totalUnrealizedPctA3))
                ? `${Number(totalUnrealizedPctA3) >= 0 ? '+' : ''}${Number(totalUnrealizedPctA3).toFixed(3)}%`
                : '—'}
            </strong>
          </div>
          {simulationPaused && shadowSchedulerActive ? (
            <div className="risk-chip" style={{ color: '#fbbf24' }} title="Full replay and mark polls are paused; last curve is frozen.">
              Simulation paused
            </div>
          ) : null}
          {!shadowSchedulerActive ? (
            <div className="risk-chip muted" title="Enable AGENT1_SHADOW_SCHEDULER on the API (not false) and restart.">
              Scheduler off in config
            </div>
          ) : null}
          {sched.lastError ? (
            <div className="risk-chip" style={{ color: '#f87171' }}>
              {sched.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="longsim5m-replay-params">
        <summary className="longsim5m-replay-params-summary">
          Replay parameters <span className="longsim5m-meta-muted">(simulation only; optional overrides)</span>
        </summary>
        <div className="longsim5m-replay-params-body">
          <div className="longsim5m-replay-params-grid">
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label">Timeframe</span>
              <select
                className="backtest1-input longsim5m-replay-select"
                value={replayScanInterval}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayScanInterval(e.target.value)
                }}
              >
                {SHADOW_SCAN_INTERVALS.map((iv) => (
                  <option key={iv} value={iv}>
                    {iv}
                  </option>
                ))}
              </select>
            </label>
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label">Long spike threshold %</span>
              <input
                type="text"
                inputMode="decimal"
                className="backtest1-input"
                placeholder="e.g. 3"
                value={replayLongThreshold}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayLongThreshold(e.target.value)
                }}
              />
            </label>
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label">Short spike threshold %</span>
              <input
                type="text"
                inputMode="decimal"
                className="backtest1-input"
                placeholder="e.g. 3"
                value={replayShortThreshold}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayShortThreshold(e.target.value)
                }}
              />
            </label>
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label" title="max_sl_pct — tightens spike-R stop if wider than this % of entry">
                Long max SL % (DB)
              </span>
              <input
                type="text"
                inputMode="decimal"
                className="backtest1-input"
                placeholder="e.g. 1"
                value={replayMaxSlLong}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayMaxSlLong(e.target.value)
                }}
              />
            </label>
            <label className="longsim5m-replay-field">
              <span
                className="longsim5m-replay-label"
                title="short_max_sl_pct — same for Agent 3 short leg"
              >
                Short max SL % (DB)
              </span>
              <input
                type="text"
                inputMode="decimal"
                className="backtest1-input"
                placeholder="e.g. 1"
                value={replayMaxSlShort}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayMaxSlShort(e.target.value)
                }}
              />
            </label>
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label">Min 24h quote volume</span>
              <input
                type="text"
                inputMode="decimal"
                className="backtest1-input"
                placeholder="e.g. 20000000"
                value={replayMinQuoteVol}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayMinQuoteVol(e.target.value)
                }}
              />
            </label>
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label">Max symbols</span>
              <input
                type="text"
                inputMode="numeric"
                className="backtest1-input"
                placeholder="1–800"
                value={replayMaxSymbols}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayMaxSymbols(e.target.value)
                }}
              />
            </label>
            <label className="longsim5m-replay-field">
              <span className="longsim5m-replay-label">Bars per symbol</span>
              <input
                type="text"
                inputMode="numeric"
                className="backtest1-input"
                placeholder="50–1500"
                value={replayBarCount}
                disabled={!shadowSchedulerActive || simParamsBusy}
                onChange={(e) => {
                  markReplayFormDirty()
                  setReplayBarCount(e.target.value)
                }}
              />
            </label>
          </div>
          <div className="longsim5m-replay-actions">
            <button
              type="button"
              className="btn-refresh"
              disabled={!shadowSchedulerActive || simParamsBusy}
              onClick={() => void applyReplayParams()}
            >
              {simParamsBusy ? '…' : 'Apply replay params'}
            </button>
          </div>
        </div>
      </details>

      <div className="longsim5m-toolbar">
        <div className="longsim5m-meta">
          <span
            className="longsim5m-live"
            title="UI polls every few seconds; curve updates after the server finishes a replay step (aligned to the effective timeframe)."
          >
            <span className="longsim5m-live-dot" aria-hidden />
            Live
          </span>
          <span className="longsim5m-meta-sep">·</span>
          {payload?.mode === 'market' ? (
            <span title="24h volume-ranked USDT perps; min volume & max symbols from shadow sim config (env + optional overrides).">
              Market{' '}
              <strong>{payload.universe?.symbolsWithData ?? '—'}</strong>
              /{payload.universe?.symbolsRequested ?? '—'}
              {payload.universe?.symbolsErrored > 0 ? (
                <span className="longsim5m-meta-muted">
                  {' '}
                  ({payload.universe.symbolsErrored} err)
                </span>
              ) : null}
            </span>
          ) : (
            <span className="cell-mono">{payload?.symbol ?? '—'}</span>
          )}
          <span className="longsim5m-meta-sep">·</span>
          <span title="Kline interval used for this replay">
            TF <strong>{payload?.settingsMeta?.scanInterval ?? '—'}</strong>
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span>
            {payload?.settingsMeta?.replayBarCount ?? payload?.barCount ?? '—'} bars/sym
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span title="24h quote-volume floor for tradable symbols in this simulation">
            min vol{' '}
            <strong>
              {Number.isFinite(Number(payload?.settingsMeta?.effectiveMinQuoteVolume))
                ? `${(Number(payload.settingsMeta.effectiveMinQuoteVolume) / 1_000_000).toFixed(0)}M`
                : '10M'}
            </strong>
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span
            title={
              (payload?.settingsMeta?.shadowTradeGeometryNote
                ? `${payload.settingsMeta.shadowTradeGeometryNote} `
                : '') +
              'Values: agent1_shadow_sim_config.max_sl_pct (long) and short_max_sl_pct (Agent 3); defaults 1% in supabase/agent1_shadow_sim_config.sql. Change via PATCH /api/agents/agent1/shadow-sim-config.'
            }
          >
            SL cap A1 <strong>{fmtPctConfig(payload?.settingsMeta?.maxSlPct)}</strong> · A3{' '}
            <strong>{fmtPctConfig(payload?.settingsMetaAgent3?.maxSlPct)}</strong> · TP{' '}
            <strong>{payload?.settingsMeta?.tpR ?? 2}R</strong>
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span>
            A1 <strong>{tradeN}</strong> closes · A3 <strong>{tradeN3}</strong> closes
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span>
            open <strong>{ongoingN}</strong> / <strong>{ongoingN3}</strong>
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span className="longsim5m-meta-muted" title="Server snapshot time (ISO)">
            live {fmtShortAgo(payload?.updatedAt)}
          </span>
        </div>
        <div className="longsim5m-chart-toggle">
          <span className="longsim5m-ema-fixed">EMA {EMA_PERIOD_FIXED} (fixed)</span>
        </div>
      </div>

      {error ? (
        <div className="positions-error" role="alert" style={{ marginTop: '0.75rem' }}>
          <p className="positions-error-msg">{error}</p>
        </div>
      ) : null}
      </div>

      <div ref={chartsSectionRef} className="agent1-anchor-target">
      <section className="longsim5m-chart-block" aria-label="Cumulative PnL Agent 1">
        <h3 className="longsim5m-chart-label">Agent 1 — cumulative PnL % (candle per step, closed trades only)</h3>
        <p className="hourly-spikes-hint longsim5m-chart-hint">
          Green / red = cumulative % up or down vs the prior step (needs two or more points; otherwise a line is
          shown). Amber line = EMA({emaPeriod}) on the same series. Gate = cumulative &gt; EMA. Current:{' '}
          <strong className={isAboveEma == null ? '' : isAboveEma ? 'pnl-pos' : 'pnl-neg'}>
            {isAboveEma == null ? 'warming up' : isAboveEma ? 'above EMA' : 'below EMA'}
          </strong>
          .
        </p>
        <SimPnlCandleChart lineData={lineData} emaData={emaData} />
      </section>
      <section className="longsim5m-chart-block" aria-label="Cumulative PnL Agent 3">
        <h3 className="longsim5m-chart-label">Agent 3 — cumulative PnL % (candle per step, closed trades only)</h3>
        <p className="hourly-spikes-hint longsim5m-chart-hint">
          Same green / red convention; amber = EMA({emaPeriod}). Current:{' '}
          <strong className={isAboveEmaA3 == null ? '' : isAboveEmaA3 ? 'pnl-pos' : 'pnl-neg'}>
            {isAboveEmaA3 == null ? 'warming up' : isAboveEmaA3 ? 'above EMA' : 'below EMA'}
          </strong>
          .
        </p>
        <SimPnlCandleChart lineData={lineDataA3} emaData={emaDataA3} />
      </section>

      <section className="longsim5m-chart-block" aria-label="EMA rule realized curve Agent 1">
        <h3 className="longsim5m-chart-label">Agent 1 — realized PnL after EMA rule (candles)</h3>
        <p className="hourly-spikes-hint longsim5m-chart-hint">
          On the exit-ordered Σ% curve vs EMA({emaPeriod}), a <strong>bearish cross</strong> blocks <strong>new</strong>{' '}
          entries after that close; a <strong>bullish cross</strong> unblocks. <strong>Closed</strong> trades opened while
          blocked are omitted; allowed closes add realized TP/SL %. Ongoing/open legs are ignored here. Amber = EMA on
          this staircase.
        </p>
        <div className="risk-summary longsim5m-filter-summary">
          <div className="risk-chip">
            Closes kept: <strong>{emaFiltered.keptCount}</strong> / {emaFiltered.totalCount}
          </div>
          <div className="risk-chip">
            Σ% (chart end, closed-only):{' '}
            <strong className={emaFiltered.sumPnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
              {emaFiltered.sumPnlPct >= 0 ? '+' : ''}
              {emaFiltered.sumPnlPct.toFixed(3)}%
            </strong>
          </div>
        </div>
        <SimPnlCandleChart lineData={emaFiltered.data} emaData={emaOnFilteredA1} />
      </section>

      <section className="longsim5m-chart-block" aria-label="EMA rule realized curve Agent 3">
        <h3 className="longsim5m-chart-label">Agent 3 — realized PnL after EMA rule (candles)</h3>
        <p className="hourly-spikes-hint longsim5m-chart-hint">
          Same cross regime as Agent 1 for shorts: blocked entries after a bearish cross; allowed closes only.
          Ongoing/open legs are ignored. Amber = EMA on filtered equity.
        </p>
        <div className="risk-summary longsim5m-filter-summary">
          <div className="risk-chip">
            Closes kept: <strong>{emaFilteredA3.keptCount}</strong> / {emaFilteredA3.totalCount}
          </div>
          <div className="risk-chip">
            Σ% (chart end, closed-only):{' '}
            <strong className={emaFilteredA3.sumPnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
              {emaFilteredA3.sumPnlPct >= 0 ? '+' : ''}
              {emaFilteredA3.sumPnlPct.toFixed(3)}%
            </strong>
          </div>
        </div>
        <SimPnlCandleChart lineData={emaFilteredA3.data} emaData={emaOnFilteredA3} />
      </section>
      </div>

      <div ref={ongoingSectionRef} className="agent1-anchor-target">
      {ongoingN > 0 ? (
        <>
          <h3 className="vol-screener-title agent1-section-title">Ongoing trades — Agent 1 (live mark)</h3>
          <div className="risk-summary longsim5m-filter-summary">
            <div className="risk-chip">
              Total unrealized %:{' '}
              <strong className={Number(totalUnrealizedPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {Number.isFinite(Number(totalUnrealizedPct))
                  ? `${Number(totalUnrealizedPct) >= 0 ? '+' : ''}${Number(totalUnrealizedPct).toFixed(3)}%`
                  : '—'}
              </strong>
            </div>
            <div className="risk-chip">
              Total unrealized R:{' '}
              <strong className={Number(totalUnrealizedR) >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {Number.isFinite(Number(totalUnrealizedR))
                  ? `${Number(totalUnrealizedR) >= 0 ? '+' : ''}${Number(totalUnrealizedR).toFixed(3)}`
                  : '—'}
              </strong>
            </div>
          </div>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Sym</th>
                  <th>Entry time</th>
                  <th>Entry price</th>
                  <th>Mark price</th>
                  <th>Unrealized %</th>
                  <th title="Take-profit and stop-loss prices from replay geometry">TP / SL</th>
                </tr>
              </thead>
              <tbody>
                {ongoing1Visible.map((t) => (
                  <tr key={`open-${t.symbol ?? ''}-${t.entryOpenTime}-${t.exitOpenTime}`}>
                    <td className="cell-mono">{t.symbol ?? '—'}</td>
                    <td className="cell-mono">{fmtLocalTime(t.entryOpenTime)}</td>
                    <td className="cell-mono">{fmtPrice(t.entryPrice)}</td>
                    <td
                      className="cell-mono"
                      title={t.exitOpenTime != null ? `Mark time: ${fmtLocalTime(t.exitOpenTime)}` : undefined}
                    >
                      {fmtPrice(t.exitPrice)}
                    </td>
                    <td className={`cell-mono ${Number(t.pnlPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                      {Number.isFinite(Number(t.pnlPct))
                        ? `${Number(t.pnlPct) >= 0 ? '+' : ''}${Number(t.pnlPct).toFixed(3)}%`
                        : '—'}
                    </td>
                    <td>
                      <OngoingTpSlCell tpPrice={t.tpPrice} slPrice={t.slPrice} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="longsim5m-table-pager">
            {ongoingN > ongoing1Shown ? (
              <button
                type="button"
                className="longsim5m-table-more"
                onClick={() =>
                  setShowOngoing1((n) => Math.min(n + TRADE_TABLE_MORE_ROWS, ongoingN))
                }
              >
                100 more
              </button>
            ) : null}
            <span className="longsim5m-meta-muted">
              {ongoing1Shown} of {ongoingN} rows (latest at top)
            </span>
          </div>
        </>
      ) : null}

      {ongoingN3 > 0 ? (
        <>
          <h3 className="vol-screener-title agent1-section-title">Ongoing trades — Agent 3 (live mark)</h3>
          <div className="risk-summary longsim5m-filter-summary">
            <div className="risk-chip">
              Total unrealized %:{' '}
              <strong className={Number(totalUnrealizedPctA3) >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {Number.isFinite(Number(totalUnrealizedPctA3))
                  ? `${Number(totalUnrealizedPctA3) >= 0 ? '+' : ''}${Number(totalUnrealizedPctA3).toFixed(3)}%`
                  : '—'}
              </strong>
            </div>
            <div className="risk-chip">
              Total unrealized R:{' '}
              <strong className={Number(totalUnrealizedRA3) >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {Number.isFinite(Number(totalUnrealizedRA3))
                  ? `${Number(totalUnrealizedRA3) >= 0 ? '+' : ''}${Number(totalUnrealizedRA3).toFixed(3)}`
                  : '—'}
              </strong>
            </div>
          </div>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Sym</th>
                  <th>Entry time</th>
                  <th>Entry price</th>
                  <th>Mark price</th>
                  <th>Unrealized %</th>
                  <th title="Take-profit and stop-loss prices from replay geometry">TP / SL</th>
                </tr>
              </thead>
              <tbody>
                {ongoing3Visible.map((t) => (
                  <tr key={`open-a3-${t.symbol ?? ''}-${t.entryOpenTime}-${t.exitOpenTime}`}>
                    <td className="cell-mono">{t.symbol ?? '—'}</td>
                    <td className="cell-mono">{fmtLocalTime(t.entryOpenTime)}</td>
                    <td className="cell-mono">{fmtPrice(t.entryPrice)}</td>
                    <td
                      className="cell-mono"
                      title={t.exitOpenTime != null ? `Mark time: ${fmtLocalTime(t.exitOpenTime)}` : undefined}
                    >
                      {fmtPrice(t.exitPrice)}
                    </td>
                    <td className={`cell-mono ${Number(t.pnlPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                      {Number.isFinite(Number(t.pnlPct))
                        ? `${Number(t.pnlPct) >= 0 ? '+' : ''}${Number(t.pnlPct).toFixed(3)}%`
                        : '—'}
                    </td>
                    <td>
                      <OngoingTpSlCell tpPrice={t.tpPrice} slPrice={t.slPrice} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="longsim5m-table-pager">
            {ongoingN3 > ongoing3Shown ? (
              <button
                type="button"
                className="longsim5m-table-more"
                onClick={() =>
                  setShowOngoing3((n) => Math.min(n + TRADE_TABLE_MORE_ROWS, ongoingN3))
                }
              >
                100 more
              </button>
            ) : null}
            <span className="longsim5m-meta-muted">
              {ongoing3Shown} of {ongoingN3} rows (latest at top)
            </span>
          </div>
        </>
      ) : null}
      </div>

      <div ref={closedSectionRef} className="agent1-anchor-target">
      {tradeN > 0 ? (
        <>
          <h3 className="vol-screener-title agent1-section-title">Closed trades — Agent 1</h3>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Sym</th>
                  <th>Spike O</th>
                  <th>Entry O</th>
                  <th>Exit O</th>
                  <th>Outcome</th>
                  <th>R</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th title="Price return entry → exit (1× notional, no leverage)">Realized %</th>
                </tr>
              </thead>
              <tbody>
                {closed1Visible.map((t, idx) => (
                  <tr key={`${t.symbol ?? ''}-${t.entryOpenTime}-${t.spikeOpenTime}-${t.exitOpenTime}`}>
                    <td>{tradeN - idx}</td>
                    <td className="cell-mono">{t.symbol ?? '—'}</td>
                    <td className="cell-mono">{t.spikeOpenTime}</td>
                    <td className="cell-mono">{t.entryOpenTime}</td>
                    <td className="cell-mono">{t.exitOpenTime}</td>
                    <td>{t.outcome}</td>
                    <td className="cell-mono">
                      {t.rMultiple != null && Number.isFinite(t.rMultiple) ? t.rMultiple.toFixed(3) : '—'}
                    </td>
                    <td className="cell-mono">{t.entryPrice}</td>
                    <td className="cell-mono">{t.exitPrice}</td>
                    <td className={`cell-mono ${Number(t.pnlPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                      {Number.isFinite(Number(t.pnlPct))
                        ? `${Number(t.pnlPct) >= 0 ? '+' : ''}${Number(t.pnlPct).toFixed(3)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="longsim5m-table-pager">
            {tradeN > closed1Shown ? (
              <button
                type="button"
                className="longsim5m-table-more"
                onClick={() =>
                  setShowClosed1((n) => Math.min(n + TRADE_TABLE_MORE_ROWS, tradeN))
                }
              >
                100 more
              </button>
            ) : null}
            <span className="longsim5m-meta-muted">
              {closed1Shown} of {tradeN} rows (latest at top)
            </span>
          </div>
        </>
      ) : null}

      {tradeN3 > 0 ? (
        <>
          <h3 className="vol-screener-title agent1-section-title">Closed trades — Agent 3</h3>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Sym</th>
                  <th>Spike O</th>
                  <th>Entry O</th>
                  <th>Exit O</th>
                  <th>Outcome</th>
                  <th>R</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th title="Price return entry → exit (1× notional, no leverage)">Realized %</th>
                </tr>
              </thead>
              <tbody>
                {closed3Visible.map((t, idx) => (
                  <tr key={`a3-${t.symbol ?? ''}-${t.entryOpenTime}-${t.spikeOpenTime}-${t.exitOpenTime}`}>
                    <td>{tradeN3 - idx}</td>
                    <td className="cell-mono">{t.symbol ?? '—'}</td>
                    <td className="cell-mono">{t.spikeOpenTime}</td>
                    <td className="cell-mono">{t.entryOpenTime}</td>
                    <td className="cell-mono">{t.exitOpenTime}</td>
                    <td>{t.outcome}</td>
                    <td className="cell-mono">
                      {t.rMultiple != null && Number.isFinite(t.rMultiple) ? t.rMultiple.toFixed(3) : '—'}
                    </td>
                    <td className="cell-mono">{t.entryPrice}</td>
                    <td className="cell-mono">{t.exitPrice}</td>
                    <td className={`cell-mono ${Number(t.pnlPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                      {Number.isFinite(Number(t.pnlPct))
                        ? `${Number(t.pnlPct) >= 0 ? '+' : ''}${Number(t.pnlPct).toFixed(3)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="longsim5m-table-pager">
            {tradeN3 > closed3Shown ? (
              <button
                type="button"
                className="longsim5m-table-more"
                onClick={() =>
                  setShowClosed3((n) => Math.min(n + TRADE_TABLE_MORE_ROWS, tradeN3))
                }
              >
                100 more
              </button>
            ) : null}
            <span className="longsim5m-meta-muted">
              {closed3Shown} of {tradeN3} rows (latest at top)
            </span>
          </div>
        </>
      ) : null}
      </div>
    </div>
  )
}
