import { ColorType, createChart, LineSeries } from 'lightweight-charts'
import { useLayoutEffect, useMemo, useRef } from 'react'

const COL_BG = 'rgba(22, 26, 32, 0.98)'
const COL_TEXT = '#B7BDC6'
const COL_GRID = 'rgba(255, 255, 255, 0.06)'
const COL_POS = '#0ecb81'
const COL_NEG = '#f6465d'

function assignUniqueChartTimes(rowsAsc) {
  const used = new Set()
  return rowsAsc.map((r) => {
    let t = Math.floor(r.closedAtMs / 1000)
    if (!Number.isFinite(t)) t = 0
    while (used.has(t)) t += 1
    used.add(t)
    return { ...r, chartTime: t }
  })
}

/**
 * Cumulative net PnL (USDT) — `points` from GET /api/agents/agent1/closed-trades-pnl-curve or
 * /api/agents/agent3/closed-trades-pnl-curve.
 */
export function Agent1ClosedTradesCumPnlChart({ points }) {
  const containerRef = useRef(null)

  const lineData = useMemo(() => {
    if (!Array.isArray(points) || points.length === 0) return null
    const rows = points
      .map((p) => {
        const raw = p.closedAt ?? p.closed_at
        const ms = raw != null ? new Date(raw).getTime() : NaN
        const cum = Number(p.cumPnlUsdt)
        return {
          closedAtMs: ms,
          value: Number.isFinite(cum) ? cum : 0,
        }
      })
      .filter((r) => Number.isFinite(r.closedAtMs))
    if (rows.length === 0) return null
    const enriched = assignUniqueChartTimes(rows)
    const line = enriched.map((r) => ({ time: r.chartTime, value: r.value }))
    if (line.length >= 1) {
      return [{ time: line[0].time - 1, value: 0 }, ...line]
    }
    return line
  }, [points])

  const lastVal = lineData?.length ? lineData[lineData.length - 1].value : 0
  const lineColor = lastVal >= 0 ? COL_POS : COL_NEG

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !lineData || lineData.length < 1) return undefined

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
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      localization: {
        priceFormatter: (p) =>
          `${Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`,
      },
    })

    const series = chart.addSeries(LineSeries, {
      color: lineColor,
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
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
  }, [lineData, lineColor])

  if (!lineData?.length) {
    return <p className="hourly-spikes-hint">No points to plot.</p>
  }

  return <div ref={containerRef} className="spike-tpsl-lw-chart agent1-closed-pnl-curve-chart" />
}
