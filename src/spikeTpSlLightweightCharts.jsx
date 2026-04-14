/**
 * TradingView Lightweight Charts (canvas) — avoids huge SVG DOM that can blank the page.
 * X-axis uses synthetic UTC timestamps (1 minute per trade index) so every bar is unique.
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'

const PER_TRADE_CAP = 3500
const SYNTH_BASE = 1577836800 // 2020-01-01 00:00 UTC (seconds)

export function synthTradeTime(tradeIndex) {
  return SYNTH_BASE + Math.max(0, tradeIndex) * 60
}

function tradePriceReturnPctFromRow(t) {
  const e = t.entryPrice ?? t.entry
  const x = t.exitPrice
  if (!Number.isFinite(e) || e === 0 || !Number.isFinite(x)) return 0
  if (t.side === 'short') return ((e - x) / e) * 100
  return ((x - e) / e) * 100
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

export function SpikeTpSlEquityLightChart({ points }) {
  const containerRef = useRef(null)
  const lineData = useMemo(() => equityToLineData(points), [points])
  const btcData = useMemo(() => btcOverlayLineData(points), [points])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !lineData) return undefined

    const showBtc = btcData && btcData.length >= 2

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
      localization: {
        priceFormatter: (p) => `${Number(p).toFixed(2)}%`,
      },
    })

    const last = lineData[lineData.length - 1]?.value ?? 0
    const series = chart.addSeries(LineSeries, {
      color: last >= 0 ? COL_POS : COL_NEG,
      lineWidth: 2,
      priceScaleId: 'right',
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
  }, [lineData, btcData])

  if (!lineData) {
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot the curve.</p>
    )
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
        <strong>TradingView Lightweight Charts</strong> — time axis is synthetic (one step per trade #).
        <strong> Right axis</strong>: cumulative Σ price %.
        {btcData && btcData.length >= 2 ? (
          <>
            {' '}
            <strong>Left axis</strong>: BTCUSDT close at each trade&apos;s entry bar (same interval as backtest).
          </>
        ) : null}
      </p>
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
