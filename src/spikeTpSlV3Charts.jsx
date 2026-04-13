/**
 * Monthly / multi-day v3 charts: daily cumulative Σ price %; trade-count histogram; BTC 1d candles.
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'

const COL_BG = 'rgba(22, 26, 32, 0.98)'
const COL_TEXT = '#B7BDC6'
const COL_GRID = 'rgba(255, 255, 255, 0.06)'
const COL_POS = '#0ecb81'
const COL_NEG = '#f6465d'
const COL_LINE = '#f0b90b'

function baseLayout(width, height) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: COL_BG },
      textColor: COL_TEXT,
      fontFamily: 'system-ui, Segoe UI, sans-serif',
    },
    grid: {
      vertLines: { color: COL_GRID },
      horzLines: { color: COL_GRID },
    },
    width,
    height,
    timeScale: {
      borderColor: COL_GRID,
      timeVisible: false,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    rightPriceScale: { borderColor: COL_GRID },
  }
}

/** @param {{ daily: object[] }} props */
export function SpikeTpSlV3CumulativeLineChart({ daily }) {
  const containerRef = useRef(null)
  const lineData = useMemo(() => {
    if (!Array.isArray(daily) || daily.length === 0) return null
    return daily.map((d) => ({
      time: d.date,
      value: Number(d.cumulativeSumPricePct),
    }))
  }, [daily])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !lineData) return undefined

    const chart = createChart(el, {
      ...baseLayout(el.clientWidth, 300),
      localization: {
        priceFormatter: (p) => `${Number(p).toFixed(2)}%`,
      },
    })

    const series = chart.addSeries(LineSeries, {
      color: COL_LINE,
      lineWidth: 2,
    })
    series.setData(lineData)
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
    return (
      <p className="hourly-spikes-hint">Run a backtest to plot cumulative Σ price % by UTC day.</p>
    )
  }

  return (
    <div className="spike-tpsl-lw-host spike-tpsl-v3-chart-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart spike-tpsl-v3-chart-tall" />
      <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
        End-of-day cumulative <strong>Σ price %</strong> (sum of per-trade entry→exit % for all entries on or
        before that UTC day). Not compounded.
      </p>
    </div>
  )
}

/** @param {{ daily: object[] }} props */
export function SpikeTpSlV3TradesHistogramChart({ daily }) {
  const containerRef = useRef(null)
  const histData = useMemo(() => {
    if (!Array.isArray(daily) || daily.length === 0) return null
    return daily.map((d) => {
      const v = Number(d.totalTrades) || 0
      const dayPct = Number(d.sumPricePct)
      return {
        time: d.date,
        value: v,
        color: dayPct >= 0 ? COL_POS : COL_NEG,
      }
    })
  }, [daily])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !histData) return undefined

    const chart = createChart(el, {
      ...baseLayout(el.clientWidth, 220),
    })

    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
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
    return null
  }

  return (
    <div className="spike-tpsl-lw-host spike-tpsl-v3-chart-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
        <strong>Trades opened</strong> per UTC day (bar height). Color = that day&apos;s Σ price % (green if
        positive, red if negative).
      </p>
    </div>
  )
}

/** @param {{ btcDaily: object[] }} props */
export function SpikeTpSlV3BtcDailyChart({ btcDaily }) {
  const containerRef = useRef(null)
  const data = useMemo(() => {
    if (!Array.isArray(btcDaily) || btcDaily.length === 0) return null
    return btcDaily.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
  }, [btcDaily])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !data) return undefined

    const chart = createChart(el, {
      ...baseLayout(el.clientWidth, 340),
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
      wickVisible: true,
    })
    series.setData(data)
    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [data])

  if (!data) {
    return <p className="hourly-spikes-hint">No BTC daily data.</p>
  }

  return (
    <div className="spike-tpsl-lw-host spike-tpsl-v3-chart-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart spike-tpsl-v3-chart-tall" />
      <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
        <strong>BTCUSDT</strong> perpetual — <strong>1d</strong> candles (UTC), same calendar span as the
        backtest range.
      </p>
    </div>
  )
}
