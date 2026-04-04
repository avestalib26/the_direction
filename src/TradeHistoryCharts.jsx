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
function assignUniqueChartTimes(closesAsc) {
  const used = new Set()
  return closesAsc.map((c) => {
    let t = Math.floor(c.closedAt / 1000)
    while (used.has(t)) t += 1
    used.add(t)
    return { ...c, chartTime: t }
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
      secondsVisible: true,
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

export function TradeHistoryCharts({ closes }) {
  const barWrapRef = useRef(null)
  const lineWrapRef = useRef(null)
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [crosshair, setCrosshair] = useState(null)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  useEffect(() => {
    if (!closes.length || !barWrapRef.current || !lineWrapRef.current) return

    const asc = [...closes].sort((a, b) => a.closedAt - b.closedAt)
    const enriched = assignUniqueChartTimes(asc)
    let cum = 0
    const rows = enriched.map((c) => {
      cum += c.realizedPnl
      return { ...c, cumulativePnl: cum }
    })

    const metaByTime = new Map()
    for (const c of rows) {
      metaByTime.set(c.chartTime, c)
    }

    const histData = rows.map((c) => ({
      time: c.chartTime,
      value: c.realizedPnl,
      color: c.realizedPnl >= 0 ? UP : DOWN,
    }))

    const lineData = rows.map((c) => ({
      time: c.chartTime,
      value: c.cumulativePnl,
    }))

    function metaFromParam(param) {
      if (param.time === undefined || param.time === null) return null
      const t = typeof param.time === 'number' ? param.time : null
      if (t === null) return null
      const m = metaByTime.get(t)
      if (!m) return null
      return {
        timeUtc: new Date(m.closedAt).toISOString().replace('T', ' ').slice(0, 19),
        symbol: m.symbol,
        orderId: m.orderId,
        side: m.positionSide,
        pnl: m.realizedPnl,
        fills: m.fills,
        cum: m.cumulativePnl,
      }
    }

    const setFromCrosshair = (param) => {
      const row = metaFromParam(param)
      setCrosshair(row)
    }

    const onChartClick = (param) => {
      const row = metaFromParam(param)
      if (!row) {
        setSelected(null)
        return
      }
      setSelected(row)
    }

    const baseOpts = chartLayout(dark)
    const barChart = createChart(barWrapRef.current, {
      ...baseOpts,
      autoSize: true,
    })
    const lineChart = createChart(lineWrapRef.current, {
      ...baseOpts,
      autoSize: true,
    })

    const histSeries = barChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      base: 0,
    })
    histSeries.setData(histData)

    const lineSeries = lineChart.addSeries(LineSeries, {
      color: dark ? '#f0b90b' : '#c99400',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
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

    barChart.subscribeCrosshairMove(setFromCrosshair)
    lineChart.subscribeCrosshairMove(setFromCrosshair)

    barChart.subscribeClick(onChartClick)
    lineChart.subscribeClick(onChartClick)

    barChart.timeScale().fitContent()
    lineChart.timeScale().fitContent()

    return () => {
      barChart.timeScale().unsubscribeVisibleTimeRangeChange(syncFromBar)
      lineChart.timeScale().unsubscribeVisibleTimeRangeChange(syncFromLine)
      barChart.unsubscribeCrosshairMove(setFromCrosshair)
      lineChart.unsubscribeCrosshairMove(setFromCrosshair)
      barChart.unsubscribeClick(onChartClick)
      lineChart.unsubscribeClick(onChartClick)
      barChart.remove()
      lineChart.remove()
    }
  }, [closes, dark])

  if (!closes.length) return null

  const active = selected ?? crosshair

  return (
    <div className="trade-tv-charts">
      <p className="trade-tv-hint">
        Drag to pan · scroll / pinch to zoom · <strong>tap or click</strong> a bar
        or line point to pin values (tap empty chart to clear). Hover still shows
        a live preview.
      </p>

      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">Realized PnL per close (bars)</h3>
        <div ref={barWrapRef} className="trade-tv-pane" />
      </div>

      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">Cumulative PnL (line)</h3>
        <div ref={lineWrapRef} className="trade-tv-pane" />
      </div>

      <div
        className={`trade-tv-crosshair ${active ? 'trade-tv-crosshair--on' : ''}`}
        aria-live="polite"
      >
        {active ? (
          <div className="trade-tv-crosshair-inner">
            {selected ? (
              <span className="trade-tv-pinned-badge" aria-label="Pinned selection">
                Pinned
              </span>
            ) : (
              <span className="trade-tv-preview-badge">Preview</span>
            )}
            <span className="trade-tv-tag">{active.timeUtc} UTC</span>
            <span className="trade-tv-tag">{active.symbol}</span>
            <span className="trade-tv-tag">#{active.orderId}</span>
            <span className="trade-tv-tag">{active.side}</span>
            <span
              className={`trade-tv-tag ${active.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
            >
              PnL {active.pnl >= 0 ? '+' : ''}
              {active.pnl.toFixed(4)}
            </span>
            <span className="trade-tv-tag">fills {active.fills}</span>
            <span className="trade-tv-tag">
              cum {active.cum >= 0 ? '+' : ''}
              {active.cum.toFixed(4)}
            </span>
            {selected && (
              <button
                type="button"
                className="trade-tv-clear"
                onClick={() => setSelected(null)}
              >
                Clear
              </button>
            )}
          </div>
        ) : (
          <span className="trade-tv-crosshair-placeholder">
            Tap a bar or point to pin · hover for preview · tap empty area to
            clear pin
          </span>
        )}
      </div>
    </div>
  )
}
