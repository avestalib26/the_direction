import {
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

const UP = '#0ecb81'
const DOWN = '#f6465d'
const CUM = '#2962ff'

function assignUniqueChartTimes(rowsAsc) {
  const used = new Set()
  return rowsAsc.map((r) => {
    let t = Math.floor(r.closedAtMs / 1000)
    while (used.has(t)) t += 1
    used.add(t)
    return { ...r, chartTime: t }
  })
}

function chartLayout(isDark) {
  const bg = isDark ? '#1e2329' : '#ffffff'
  const text = isDark ? '#b7bdc6' : '#474d57'
  const grid = isDark ? '#2b3139' : '#eaecef'
  const border = isDark ? '#2b3139' : '#eaecef'
  return {
    layout: {
      background: { type: ColorType.Solid, color: bg },
      textColor: text,
      fontSize: 12,
      fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif",
    },
    grid: {
      vertLines: { color: grid },
      horzLines: { color: grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: isDark ? '#6a6d78' : '#9598a1',
        labelBackgroundColor: isDark ? '#474d57' : '#848e9c',
      },
      horzLine: {
        color: isDark ? '#6a6d78' : '#9598a1',
        labelBackgroundColor: isDark ? '#474d57' : '#848e9c',
      },
    },
    rightPriceScale: {
      borderColor: border,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  }
}

/**
 * Per-close realized PnL (histogram) + cumulative USDT (line). Agent 2 closed trades only.
 */
export function Agent2ClosedTradesCharts({ closedTrades }) {
  const barRef = useRef(null)
  const lineRef = useRef(null)
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  useEffect(() => {
    if (!Array.isArray(closedTrades) || closedTrades.length === 0 || !barRef.current || !lineRef.current)
      return

    const normalized = closedTrades
      .map((t) => {
        const raw = t.closed_at ?? t.closedAt
        const ms = raw != null ? new Date(raw).getTime() : NaN
        const pnl = Number(t.realized_pnl_usdt)
        return {
          id: t.id,
          symbol: t.symbol,
          closedAtMs: ms,
          realizedPnl: Number.isFinite(pnl) ? pnl : 0,
        }
      })
      .filter((r) => Number.isFinite(r.closedAtMs))

    const asc = [...normalized].sort((a, b) => a.closedAtMs - b.closedAtMs)
    const enriched = assignUniqueChartTimes(asc)
    let cum = 0
    const rows = enriched.map((r) => {
      cum += r.realizedPnl
      return { ...r, cumulativePnl: cum }
    })

    const histData = rows.map((r) => ({
      time: r.chartTime,
      value: r.realizedPnl,
      color: r.realizedPnl >= 0 ? UP : DOWN,
    }))
    const lineData = rows.map((r) => ({
      time: r.chartTime,
      value: r.cumulativePnl,
    }))

    const baseOpts = chartLayout(dark)
    const barChart = createChart(barRef.current, { ...baseOpts, autoSize: true })
    const lineChart = createChart(lineRef.current, { ...baseOpts, autoSize: true })

    const histSeries = barChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      base: 0,
    })
    histSeries.setData(histData)

    const lineSeries = lineChart.addSeries(LineSeries, {
      color: CUM,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      lastValueVisible: true,
      priceLineVisible: true,
    })
    lineSeries.setData(lineData)

    let lock = false
    const syncFromBar = (range) => {
      if (lock || range === null) return
      lock = true
      lineChart.timeScale().setVisibleRange(range)
      lock = false
    }
    const syncFromLine = (range) => {
      if (lock || range === null) return
      lock = true
      barChart.timeScale().setVisibleRange(range)
      lock = false
    }
    barChart.timeScale().subscribeVisibleTimeRangeChange(syncFromBar)
    lineChart.timeScale().subscribeVisibleTimeRangeChange(syncFromLine)

    barChart.timeScale().fitContent()
    lineChart.timeScale().fitContent()

    return () => {
      barChart.timeScale().unsubscribeVisibleTimeRangeChange(syncFromBar)
      lineChart.timeScale().unsubscribeVisibleTimeRangeChange(syncFromLine)
      barChart.remove()
      lineChart.remove()
    }
  }, [closedTrades, dark])

  if (!Array.isArray(closedTrades) || closedTrades.length === 0) return null

  return (
    <div className="agent2-equity-charts" style={{ marginBottom: '1rem' }}>
      <h4 className="vol-screener-title agent1-section-title" style={{ marginBottom: '0.35rem' }}>
        Agent 2 equity (closed trades only)
      </h4>
      <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem' }}>
        Top: realized P&amp;L per close (USDT). Bottom: cumulative realized P&amp;L. Time axis = close
        time (up to 100 trades).
      </p>
      <div ref={barRef} className="trade-tv-pane agent2-equity-pane agent2-equity-pane--bars" />
      <div ref={lineRef} className="trade-tv-pane agent2-equity-pane agent2-equity-pane--line" />
    </div>
  )
}
