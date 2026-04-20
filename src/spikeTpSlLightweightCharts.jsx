/**
 * TradingView Lightweight Charts (canvas) — avoids huge SVG DOM that can blank the page.
 * X-axis uses synthetic UTC timestamps (1 minute per trade index) so every bar is unique.
 */
import { useLayoutEffect, useMemo, useRef, useEffect, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'
import { EQUITY_STACK_BASE, normalizeEquityEmaPeriod } from './equityEmaInteractiveFilter.js'

const PER_TRADE_CAP = 3500
const SYNTH_BASE = 1577836800 // 2020-01-01 00:00 UTC (seconds)

export function synthTradeTime(tradeIndex) {
  return SYNTH_BASE + Math.max(0, tradeIndex) * 60
}

/** X-time for long/short compare mode: `pointIndex` is 0…totalPoints−1 on the equity curve (matches line chart). */
export function compareProgressSynthTimeFromPointIndex(pointIndex, totalPoints) {
  const n = totalPoints
  if (!Number.isFinite(n) || n < 2) return synthTradeTime(0)
  const pi = Math.max(0, Math.min(n - 1, Math.floor(pointIndex)))
  const progress = pi / (n - 1)
  const tIdx = Math.round(progress * 200000)
  return synthTradeTime(tIdx)
}

function tradePriceReturnPctFromRow(t) {
  const e = t.entryPrice ?? t.entry
  const x = t.exitPrice
  if (!Number.isFinite(e) || e === 0 || !Number.isFinite(x)) return 0
  if (t.side === 'short') return ((e - x) / e) * 100
  return ((x - e) / e) * 100
}

function computeEmaOnSeries(closes, period) {
  const out = closes.map(() => null)
  if (!Array.isArray(closes) || closes.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

/** Bollinger on `closes`: SMA(period) ± mult × population stdev over the window. */
function computeBollingerBands(closes, period, mult) {
  const n = closes.length
  const middle = new Array(n).fill(null)
  const upper = new Array(n).fill(null)
  const lower = new Array(n).fill(null)
  const p = Math.floor(period)
  const m = Number(mult)
  if (!Array.isArray(closes) || n < p || p < 2 || !Number.isFinite(m) || m <= 0) {
    return { middle, upper, lower }
  }
  for (let i = p - 1; i < n; i++) {
    let sum = 0
    for (let j = 0; j < p; j++) sum += closes[i - p + 1 + j]
    const sma = sum / p
    let varSum = 0
    for (let j = 0; j < p; j++) {
      const d = closes[i - p + 1 + j] - sma
      varSum += d * d
    }
    const stdev = Math.sqrt(varSum / p)
    middle[i] = sma
    upper[i] = sma + m * stdev
    lower[i] = sma - m * stdev
  }
  return { middle, upper, lower }
}

function buildPerTradeRows(perTradePricePctChron, tradesFallback) {
  let raw = perTradePricePctChron
  if (Array.isArray(raw) && raw.length > 0) {
    raw = raw.map((x) => {
      const v = Number(x)
      return Number.isFinite(v) ? v : 0
    })
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    if (!Array.isArray(tradesFallback) || tradesFallback.length === 0) {
      return { rows: [], total: 0, clientSampled: false }
    }
    const sorted = [...tradesFallback].sort((a, b) => {
      if (a.entryOpenTime !== b.entryOpenTime) return a.entryOpenTime - b.entryOpenTime
      return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
    })
    raw = sorted.map(tradePriceReturnPctFromRow)
  }
  const total = raw.length
  if (total <= PER_TRADE_CAP) {
    return {
      rows: raw.map((pct, chronIndex) => ({ pct, chronIndex })),
      total,
      clientSampled: false,
    }
  }
  const rows = []
  for (let k = 0; k < PER_TRADE_CAP; k++) {
    const chronIndex = Math.floor((k / (PER_TRADE_CAP - 1)) * (total - 1))
    rows.push({ pct: raw[chronIndex], chronIndex })
  }
  return { rows, total, clientSampled: true }
}

function equityToLineData(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  const data = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const k = Number.isFinite(p.tradeIndex) ? p.tradeIndex : i
    const v = Number(p.pnlPctFromStart)
    if (!Number.isFinite(v)) continue
    data.push({ time: synthTradeTime(k), value: v })
  }
  return data.length >= 2 ? data : null
}

/** Same run progress (0→last trade) on x for both series so different trade counts are comparable. */
function equityToCompareProgressLineData(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  const n = points.length
  const data = []
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const v = Number(p.pnlPctFromStart)
    if (!Number.isFinite(v)) continue
    data.push({ time: compareProgressSynthTimeFromPointIndex(i, n), value: v })
  }
  return data.length >= 2 ? data : null
}

function btcOverlayLineData(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  const data = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const k = Number.isFinite(p.tradeIndex) ? p.tradeIndex : i
    const v = Number(p.btcCloseUsd)
    if (!Number.isFinite(v)) continue
    data.push({ time: synthTradeTime(k), value: v })
  }
  return data.length >= 2 ? data : null
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

const COL_BG = 'rgba(22, 26, 32, 0.98)'
const COL_TEXT = '#B7BDC6'
const COL_GRID = 'rgba(255, 255, 255, 0.06)'
const COL_POS = '#0ecb81'
const COL_NEG = '#f6465d'
const COL_BTC = '#f0b90b'
const COL_EMA_SLOW = '#f59e0b'
const COL_COMPARE_LONG = '#22c55e'
const COL_COMPARE_SHORT = '#ea580c'
const COL_COMPARE_LONG2 = '#0ea5e9'
const COL_COMPARE_SHORT2 = '#a855f7'
const COL_BB_BAND = 'rgba(96, 165, 250, 0.55)'
const COL_BB_MID = 'rgba(147, 197, 253, 0.45)'

/**
 * Cumulative Σ price % curves on one y-scale (Agent 1 vs 3, optional Agent 4 & 5).
 * X-axis = normalized progress through each run (start → end), not wall-clock time.
 * @param {{ points: unknown, side: 'long'|'short', label: string, color?: string }[]} [extraCompareSeries]
 */
export function SpikeTpSlCompareEquityChart({
  longPoints,
  shortPoints,
  extraCompareSeries = null,
  showFootnote = true,
  /** Called with chart after mount; `null` on cleanup — used to sync time scale with other panels. */
  onChartReady = null,
  /** Optional background activity bars: [{ time, state }] where state: 0=none,1=long,2=short,3=both. */
  activityBars = null,
}) {
  const containerRef = useRef(null)
  const onChartReadyRef = useRef(onChartReady)
  useEffect(() => {
    onChartReadyRef.current = onChartReady
  }, [onChartReady])
  const comparePack = useMemo(() => {
    const shortLines = []
    const longLines = []
    const pushShort = (points, label, color) => {
      const data = equityToCompareProgressLineData(points)
      if (!data || data.length < 2) return
      const lastV = data[data.length - 1]?.value ?? 0
      const lineColor = lastV >= 0 ? color : COL_NEG
      shortLines.push({ data, label, lineColor })
    }
    const pushLong = (points, label, color) => {
      const data = equityToCompareProgressLineData(points)
      if (!data || data.length < 2) return
      const lastV = data[data.length - 1]?.value ?? 0
      const lineColor = lastV >= 0 ? color : COL_NEG
      longLines.push({ data, label, lineColor })
    }
    if (shortPoints) pushShort(shortPoints, 'Agent 3 (short / red spike)', COL_COMPARE_SHORT)
    if (longPoints) pushLong(longPoints, 'Agent 1 (long / green spike)', COL_COMPARE_LONG)
    if (Array.isArray(extraCompareSeries)) {
      for (const ex of extraCompareSeries) {
        if (!ex?.points) continue
        const side = ex.side === 'short' ? 'short' : 'long'
        const defaultCol = side === 'short' ? COL_COMPARE_SHORT2 : COL_COMPARE_LONG2
        const col = typeof ex.color === 'string' && ex.color ? ex.color : defaultCol
        const label = ex.label || (side === 'short' ? 'Short' : 'Long')
        if (side === 'short') pushShort(ex.points, label, col)
        else pushLong(ex.points, label, col)
      }
    }
    const drawSeries = [...shortLines, ...longLines]
    const legendItems = []
    if (longLines[0]) legendItems.push(longLines[0])
    if (shortLines[0]) legendItems.push(shortLines[0])
    for (let i = 1; i < longLines.length; i++) legendItems.push(longLines[i])
    for (let i = 1; i < shortLines.length; i++) legendItems.push(shortLines[i])
    return { drawSeries, legendItems }
  }, [longPoints, shortPoints, extraCompareSeries])
  const { drawSeries, legendItems } = comparePack
  const activityData = useMemo(() => {
    if (!Array.isArray(activityBars) || activityBars.length < 2) return null
    const out = []
    for (const row of activityBars) {
      const t = Number(row?.time)
      const s = Number(row?.state)
      if (!Number.isFinite(t) || !Number.isFinite(s) || s <= 0) continue
      const color =
        s >= 3
          ? 'rgba(245, 158, 11, 0.22)'
          : s === 1
            ? 'rgba(34, 197, 94, 0.18)'
            : 'rgba(234, 88, 12, 0.18)'
      out.push({ time: t, value: 1, color })
    }
    return out.length >= 2 ? out : null
  }, [activityBars])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    if (!drawSeries.length) {
      onChartReadyRef.current?.(null)
      return undefined
    }

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
      width: el.clientWidth,
      height: 300,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      leftPriceScale: {
        visible: false,
        borderColor: COL_GRID,
        scaleMargins: { top: 0, bottom: 0 },
      },
      rightPriceScale: {
        visible: true,
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    const fmtPct = {
      type: 'custom',
      minMove: 0.01,
      formatter: (p) => `${Number(p).toFixed(2)}%`,
    }

    if (activityData && activityData.length >= 2) {
      chart.addSeries(HistogramSeries, {
        priceScaleId: 'left',
        base: 0,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
      }).setData(activityData)
    }

    for (const row of drawSeries) {
      chart.addSeries(LineSeries, {
        color: row.lineColor,
        lineWidth: 2,
        priceScaleId: 'right',
        priceFormat: fmtPct,
      }).setData(row.data)
    }

    chart.timeScale().fitContent()
    onChartReadyRef.current?.(chart)

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      onChartReadyRef.current?.(null)
      ro.disconnect()
      chart.remove()
    }
  }, [drawSeries, activityData])

  if (!drawSeries.length) {
    return (
      <p className="hourly-spikes-hint">
        Run the backtest(s) with at least one closed trade to plot the comparison lines.
      </p>
    )
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div className="spike-tpsl-compare-legend" aria-hidden="false">
        {legendItems.map((row, li) => (
          <span key={`${row.label}-${li}`} className="spike-tpsl-compare-legend__item">
            <span
              className="spike-tpsl-compare-legend__swatch"
              style={{ background: row.lineColor }}
            />{' '}
            {row.label}
          </span>
        ))}
        {activityData ? (
          <span className="spike-tpsl-compare-legend__item">
            <span className="spike-tpsl-compare-legend__swatch" style={{ background: 'rgba(245, 158, 11, 0.38)' }} />{' '}
            Activity fill: green=Agent 1, orange=Agent 3, amber=both
          </span>
        ) : null}
      </div>
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      {showFootnote ? (
        <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
          <strong>Compare mode</strong>: horizontal axis is <strong>progress through each run</strong> (0% → 100% of
          trades), not calendar time, so different trade counts align for shape comparison. <strong>Right axis</strong>:
          cumulative Σ price % (same engine as quick backtest).
          {activityData ? ' Vertical fills show when each agent is active under EMA gate.' : ''}
        </p>
      ) : null}
    </div>
  )
}

export function SpikeTpSlEquityLightChart({
  points,
  /** Optional second line: e.g. unfiltered cumulative when the main line is EMA-filtered (dimmer). */
  baselinePoints = null,
  showFootnote = true,
}) {
  const containerRef = useRef(null)
  const lineData = useMemo(() => equityToLineData(points), [points])
  const baselineData = useMemo(() => (baselinePoints ? equityToLineData(baselinePoints) : null), [baselinePoints])
  const btcData = useMemo(() => btcOverlayLineData(points), [points])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !lineData) return undefined

    const showBtc = btcData && btcData.length >= 2
    const showBaseline = baselineData && baselineData.length >= 2

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
      width: el.clientWidth,
      height: 280,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      leftPriceScale: {
        visible: showBtc,
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      rightPriceScale: {
        visible: true,
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    if (showBaseline) {
      const baseSeries = chart.addSeries(LineSeries, {
        color: 'rgba(183, 189, 198, 0.35)',
        lineWidth: 1,
        priceScaleId: 'right',
        priceFormat: {
          type: 'custom',
          minMove: 0.01,
          formatter: (p) => `${Number(p).toFixed(2)}%`,
        },
      })
      baseSeries.setData(baselineData)
    }

    const last = lineData[lineData.length - 1]?.value ?? 0
    const series = chart.addSeries(LineSeries, {
      color: last >= 0 ? COL_POS : COL_NEG,
      lineWidth: 2,
      priceScaleId: 'right',
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (p) => `${Number(p).toFixed(2)}%`,
      },
    })
    series.setData(lineData)

    if (showBtc) {
      const btcSeries = chart.addSeries(LineSeries, {
        color: COL_BTC,
        lineWidth: 1,
        priceScaleId: 'left',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      })
      btcSeries.setData(btcData)
    }

    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [lineData, baselineData, btcData])

  if (!lineData) {
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot the curve.</p>
    )
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      {showFootnote ? (
        <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
          <strong>TradingView Lightweight Charts</strong> — time axis is synthetic (one step per trade #).
          <strong> Right axis</strong>: cumulative Σ price %.
          {baselineData && baselineData.length >= 2 ? (
            <>
              {' '}
              <strong>Dim line</strong>: all trades (unfiltered). <strong>Bold line</strong>: filtered mode — flat
              stretches mean consecutive trades did not pass the entry gate, so the running Σ does not move.
            </>
          ) : null}
          {btcData && btcData.length >= 2 ? (
            <>
              {' '}
              <strong>Left axis</strong>: BTCUSDT close at each trade&apos;s entry bar (same interval as backtest).
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

export function SpikeTpSlPerTradeLightChart({
  perTradePricePctChron,
  tradesFallback,
  totalTradeRows,
  serverSubsampled,
}) {
  const containerRef = useRef(null)
  const pack = useMemo(
    () => buildPerTradeRows(perTradePricePctChron, tradesFallback),
    [perTradePricePctChron, tradesFallback],
  )

  const histData = useMemo(() => {
    if (!pack.rows.length) return null
    return pack.rows.map((r, i) => {
      const pct = Number.isFinite(Number(r.pct)) ? Number(r.pct) : 0
      const color = pct > 0 ? COL_POS : pct < 0 ? COL_NEG : '#848e9c'
      return {
        time: synthTradeTime(i + 1),
        value: pct,
        color,
      }
    })
  }, [pack.rows])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !histData) return undefined

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
      width: el.clientWidth,
      height: 280,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: COL_GRID },
      localization: {
        priceFormatter: (p) => `${Number(p).toFixed(3)}%`,
      },
    })

    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    })
    series.setData(histData)
    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [histData])

  if (!histData) {
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot per-trade bars.</p>
    )
  }

  const fullN =
    Number.isFinite(totalTradeRows) && totalTradeRows > 0 ? totalTradeRows : pack.total

  return (
    <div className="spike-tpsl-lw-host">
      {serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          API sent <strong>{histData.length}</strong> trade % values of <strong>{fmtInt(fullN)}</strong> total
          (payload cap). Chart uses those points.
        </p>
      )}
      {pack.clientSampled && !serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          Showing <strong>{histData.length}</strong> of <strong>{pack.total}</strong> trades (cap {PER_TRADE_CAP}).
        </p>
      )}
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
        <strong>TradingView Lightweight Charts</strong> — each bar is one trade&apos;s price % (green / red);
        time axis is synthetic by trade order. Full run: <strong>{fmtInt(fullN)}</strong> trades.
      </p>
    </div>
  )
}

/**
 * Stacked equity candlesticks: each bar is cumulative 100 + Σ trade % (wins/losses stack); bodies only; EMA on close.
 */
export function SpikeTpSlPerTradeCandleLightChart({
  perTradePricePctChron,
  tradesFallback,
  totalTradeRows,
  serverSubsampled,
  emaPeriod = 50,
  showFooterHint = true,
  /** `pnlFromZero` = same cumulative Σ price % axis as the equity line chart; `stack100` = 100 + Σ (legacy). */
  cumulativePnlScale = 'stack100',
  /**
   * `synthIndex` — one step per trade (default). `compareProgress` — x matches long/short compare line chart
   * (requires `compareProgressEquityPointCount`).
   */
  chartTimeMode = 'synthIndex',
  /** Length of `equityCurve` from the same backtest; candle *i* aligns with equity point index *i+1*. */
  compareProgressEquityPointCount = null,
  onChartReady = null,
  /** When true, show a checkbox to overlay Bollinger bands (SMA ± σ) on cumulative closes. */
  bollingerToggle = false,
  /** SMA period for Bollinger middle (default 20). */
  bollingerPeriod = 20,
  /** Standard deviation multiplier (default 2). */
  bollingerStdMult = 2,
}) {
  const containerRef = useRef(null)
  const onChartReadyRef = useRef(onChartReady)
  useEffect(() => {
    onChartReadyRef.current = onChartReady
  }, [onChartReady])
  const [bollingerVisible, setBollingerVisible] = useState(false)
  const emaPeriodSafe = normalizeEquityEmaPeriod(emaPeriod)
  const bollingerPeriodSafe = Math.max(2, Math.min(500, Math.floor(Number(bollingerPeriod)) || 20))
  const bollingerMultSafe =
    Number.isFinite(Number(bollingerStdMult)) && Number(bollingerStdMult) > 0 ? Number(bollingerStdMult) : 2

  const pack = useMemo(
    () => buildPerTradeRows(perTradePricePctChron, tradesFallback),
    [perTradePricePctChron, tradesFallback],
  )

  const candleData = useMemo(() => {
    if (!pack.rows.length) return null
    const used = new Set()
    const rows = []
    const base = cumulativePnlScale === 'pnlFromZero' ? 0 : EQUITY_STACK_BASE
    let level = base
    const nEq =
      chartTimeMode === 'compareProgress' && Number.isFinite(Number(compareProgressEquityPointCount))
        ? Math.max(2, Math.floor(Number(compareProgressEquityPointCount)))
        : null
    for (let i = 0; i < pack.rows.length; i++) {
      const pct = Number(pack.rows[i].pct)
      const p = Number.isFinite(pct) ? pct : 0
      const open = level
      const close = level + p
      level = close
      let high = Math.max(open, close)
      let low = Math.min(open, close)
      if (!(high > low)) {
        const pad = 1e-4
        high = open + pad
        low = open - pad
      }
      let t
      if (chartTimeMode === 'compareProgress' && nEq != null) {
        t = compareProgressSynthTimeFromPointIndex(i + 1, nEq)
      } else {
        t = synthTradeTime(i + 1)
      }
      while (used.has(t)) t += 1
      used.add(t)
      rows.push({ time: t, open, high, low, close })
    }
    return rows.length > 0 ? rows : null
  }, [pack.rows, cumulativePnlScale, chartTimeMode, compareProgressEquityPointCount])

  const emaLineData = useMemo(() => {
    if (!candleData) return null
    const closes = candleData.map((r) => r.close)
    const emaArr = computeEmaOnSeries(closes, emaPeriodSafe)
    const out = []
    for (let i = 0; i < candleData.length; i++) {
      const v = emaArr[i]
      if (v == null || !Number.isFinite(v)) continue
      out.push({ time: candleData[i].time, value: v })
    }
    return out.length >= 2 ? out : null
  }, [candleData, emaPeriodSafe])

  const bollingerLinePack = useMemo(() => {
    if (!candleData || candleData.length < bollingerPeriodSafe) return null
    const closes = candleData.map((r) => r.close)
    const { middle, upper, lower } = computeBollingerBands(closes, bollingerPeriodSafe, bollingerMultSafe)
    const upperData = []
    const middleData = []
    const lowerData = []
    for (let i = 0; i < candleData.length; i++) {
      const t = candleData[i].time
      const u = upper[i]
      const mid = middle[i]
      const lo = lower[i]
      if (u != null && Number.isFinite(u)) upperData.push({ time: t, value: u })
      if (mid != null && Number.isFinite(mid)) middleData.push({ time: t, value: mid })
      if (lo != null && Number.isFinite(lo)) lowerData.push({ time: t, value: lo })
    }
    if (upperData.length < 2 || middleData.length < 2 || lowerData.length < 2) return null
    return { upperData, middleData, lowerData }
  }, [candleData, bollingerPeriodSafe, bollingerMultSafe])

  const showBollingerOverlay = Boolean(bollingerToggle && bollingerVisible && bollingerLinePack)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !candleData || candleData.length === 0) {
      onChartReadyRef.current?.(null)
      return undefined
    }

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
      width: el.clientWidth,
      height: 320,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      localization: {
        priceFormatter: (p) =>
          cumulativePnlScale === 'pnlFromZero'
            ? `${Number(p).toFixed(2)}%`
            : Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
      },
    })

    const lineFmt =
      cumulativePnlScale === 'pnlFromZero'
        ? {
            type: 'custom',
            minMove: 0.01,
            formatter: (p) => `${Number(p).toFixed(2)}%`,
          }
        : {
            type: 'custom',
            minMove: 0.01,
            formatter: (p) =>
              Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
          }

    if (showBollingerOverlay && bollingerLinePack) {
      const { upperData, middleData, lowerData } = bollingerLinePack
      chart.addSeries(LineSeries, {
        color: COL_BB_BAND,
        lineWidth: 1,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: lineFmt,
      }).setData(lowerData)
      chart.addSeries(LineSeries, {
        color: COL_BB_BAND,
        lineWidth: 1,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: lineFmt,
      }).setData(upperData)
      chart.addSeries(LineSeries, {
        color: COL_BB_MID,
        lineWidth: 1,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: lineFmt,
      }).setData(middleData)
    }

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
    })
    candleSeries.setData(candleData)

    if (emaLineData && emaLineData.length >= 2) {
      const emaSeries = chart.addSeries(LineSeries, {
        color: COL_EMA_SLOW,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: false,
        priceFormat: lineFmt,
      })
      emaSeries.setData(emaLineData)
    }

    chart.timeScale().fitContent()
    onChartReadyRef.current?.(chart)

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      onChartReadyRef.current?.(null)
      ro.disconnect()
      chart.remove()
    }
  }, [
    candleData,
    emaLineData,
    emaPeriodSafe,
    cumulativePnlScale,
    showBollingerOverlay,
    bollingerLinePack,
  ])

  if (!candleData) {
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot stacked equity candles.</p>
    )
  }

  const fullN =
    Number.isFinite(totalTradeRows) && totalTradeRows > 0 ? totalTradeRows : pack.total

  return (
    <div className="spike-tpsl-lw-host spike-tpsl-pertrade-candle-host">
      {bollingerToggle ? (
        <label
          className="spike-tpsl-bollinger-toggle"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '0.5rem',
            fontSize: '0.8125rem',
            color: COL_TEXT,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={bollingerVisible}
            onChange={(e) => setBollingerVisible(e.target.checked)}
            disabled={!bollingerLinePack}
          />
          <span>
            Bollinger bands (SMA {bollingerPeriodSafe}, {bollingerMultSafe}σ on cumulative close)
            {!bollingerLinePack ? ' — need more trades' : ''}
          </span>
        </label>
      ) : null}
      {serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          API sent <strong>{candleData.length}</strong> stacked bars of <strong>{fmtInt(fullN)}</strong> total
          (payload cap). Same subsample as the histogram.
        </p>
      )}
      {pack.clientSampled && !serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          Showing <strong>{candleData.length}</strong> of <strong>{pack.total}</strong> trades (cap{' '}
          {PER_TRADE_CAP}).
        </p>
      )}
      <div ref={containerRef} className="spike-tpsl-lw-chart spike-tpsl-pertrade-candle-chart" />
      {showFooterHint ? (
        <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
          <strong>TradingView Lightweight Charts</strong> —{' '}
          {cumulativePnlScale === 'pnlFromZero' ? (
            <>
              <strong>cumulative Σ price %</strong> (same scale as the equity line): each candle body is one
              trade&apos;s return added to the running total (no wicks).
            </>
          ) : (
            <>
              <strong>stacked equity</strong> (starts at {EQUITY_STACK_BASE}): each candle body is that trade&apos;s
              P&amp;L % added to the running total (no wicks).
            </>
          )}{' '}
          <strong style={{ color: COL_EMA_SLOW }}>EMA {emaPeriodSafe}</strong> on cumulative close — starts after
          enough bars (warmup). Filter uses <strong>cumulative &gt; EMA</strong> before each trade. Time = trade order
          (synthetic). Full run: <strong>{fmtInt(fullN)}</strong> trades.
        </p>
      ) : null}
    </div>
  )
}

function candlestickRowsFromOpenTimeApi(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null
  const used = new Set()
  return candles.map((c) => {
    let t = Math.floor(Number(c.openTime) / 1000)
    if (!Number.isFinite(t)) t = 0
    while (used.has(t)) t += 1
    used.add(t)
    return {
      time: t,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }
  })
}

/**
 * OHLC candlesticks + EMA on close (TradingView Lightweight Charts). `candles`: API rows with openTime ms.
 */
export function BtcOhlcEmaChart({ candles, emaPeriod = 50 }) {
  const containerRef = useRef(null)
  const candleData = useMemo(() => candlestickRowsFromOpenTimeApi(candles), [candles])
  const emaLineData = useMemo(() => {
    if (!candleData?.length || !Number.isFinite(emaPeriod) || emaPeriod < 2) return null
    const closes = candleData.map((c) => c.close)
    const emaArr = computeEmaOnSeries(closes, emaPeriod)
    const out = []
    for (let i = 0; i < candleData.length; i++) {
      const v = emaArr[i]
      if (v == null || !Number.isFinite(v)) continue
      out.push({ time: candleData[i].time, value: v })
    }
    return out.length >= 2 ? out : null
  }, [candleData, emaPeriod])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !candleData?.length) return undefined

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
      width: el.clientWidth,
      height: 300,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
    })
    candleSeries.setData(candleData)

    if (emaLineData && emaLineData.length >= 2) {
      const lineSeries = chart.addSeries(LineSeries, {
        color: COL_EMA_SLOW,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      lineSeries.setData(emaLineData)
    }

    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [candleData, emaLineData])

  if (!candleData?.length) {
    return <p className="hourly-spikes-hint">No OHLC series (enable chart candles on the run).</p>
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
    </div>
  )
}

/**
 * Simulated account balance (USDT). `points`: `{ time, value }` with synthetic times (e.g. compareProgress or synth index).
 */
export function SpikeTpSlAccountBalanceLightChart({ points, showFootnote = true }) {
  const containerRef = useRef(null)
  const lineData = useMemo(() => {
    if (!Array.isArray(points) || points.length < 2) return null
    const data = []
    for (const p of points) {
      const t = p.time
      const v = Number(p.value)
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      data.push({ time: t, value: v })
    }
    return data.length >= 2 ? data : null
  }, [points])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !lineData) return undefined

    const startVal = lineData[0]?.value ?? 0
    const lastVal = lineData[lineData.length - 1]?.value ?? 0

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
      width: el.clientWidth,
      height: 260,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    chart.addSeries(LineSeries, {
      color: lastVal >= startVal ? COL_POS : COL_NEG,
      lineWidth: 2,
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (p) => `${Number(p).toFixed(2)} USDT`,
      },
    }).setData(lineData)

    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [lineData])

  if (!lineData) {
    return <p className="hourly-spikes-hint">Not enough trades to plot account balance.</p>
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      {showFootnote ? (
        <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
          <strong>Right axis</strong>: simulated balance (USDT). X-axis matches the run&apos;s trade progress (same as
          cumulative Σ chart when using compare mode).
        </p>
      ) : null}
    </div>
  )
}
