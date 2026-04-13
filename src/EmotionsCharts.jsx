import {
  ColorType,
  CrosshairMode,
  createChart,
  LineSeries,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

const DOWN = '#f6465d'
const AMBER = '#f0b90b'

function chartLayout(isDark) {
  const bg = isDark ? '#1e2329' : '#ffffff'
  const text = isDark ? '#b7bdc6' : '#474d57'
  const grid = isDark ? '#2b3139' : '#eaecef'
  const border = isDark ? '#2b3139' : '#eaecef'
  return {
    layout: {
      background: { type: ColorType.Solid, color: bg },
      textColor: text,
      fontSize: 11,
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
      scaleMargins: { top: 0.1, bottom: 0.1 },
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

/**
 * @param {{ equityPoints: { chartTime: number, cum: number, drawdownFromPeak: number }[], markers: { time: number, position: string, color: string, shape: string, text: string }[] }} props
 */
export function EmotionsCharts({ equityPoints, markers }) {
  const eqRef = useRef(null)
  const ddRef = useRef(null)
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  const [chartError, setChartError] = useState(null)

  useEffect(() => {
    if (!equityPoints?.length || !eqRef.current || !ddRef.current) return

    let eqChart
    let ddChart
    try {
      const baseOpts = chartLayout(dark)
      eqChart = createChart(eqRef.current, { ...baseOpts, autoSize: true })
      ddChart = createChart(ddRef.current, { ...baseOpts, autoSize: true })

      const eqSeries = eqChart.addSeries(LineSeries, {
        color: dark ? AMBER : '#b8860b',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      })
      const eqData = equityPoints.map((p) => ({
        time: p.chartTime,
        value: p.cum,
      }))
      eqSeries.setData(eqData)

      const ddSeries = ddChart.addSeries(LineSeries, {
        color: DOWN,
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      })
      const ddData = equityPoints.map((p) => ({
        time: p.chartTime,
        value: Number.isFinite(p.drawdownFromPeak) ? p.drawdownFromPeak * 100 : 0,
      }))
      ddSeries.setData(ddData)

      const safeMarkers = (Array.isArray(markers) ? markers : []).filter(
        (m) => m && Number.isFinite(m.time),
      )
      if (safeMarkers.length) {
        try {
          eqSeries.setMarkers(safeMarkers)
        } catch (me) {
          console.warn('[EmotionsCharts] setMarkers', me)
        }
      }

      let lock = false
      const syncA = (range) => {
        if (lock || range === null) return
        lock = true
        ddChart.timeScale().setVisibleRange(range)
        lock = false
      }
      const syncB = (range) => {
        if (lock || range === null) return
        lock = true
        eqChart.timeScale().setVisibleRange(range)
        lock = false
      }
      eqChart.timeScale().subscribeVisibleTimeRangeChange(syncA)
      ddChart.timeScale().subscribeVisibleTimeRangeChange(syncB)

      eqChart.timeScale().fitContent()
      ddChart.timeScale().fitContent()

      return () => {
        try {
          eqChart.timeScale().unsubscribeVisibleTimeRangeChange(syncA)
          ddChart.timeScale().unsubscribeVisibleTimeRangeChange(syncB)
        } catch {
          /* ignore */
        }
        eqChart.remove()
        ddChart.remove()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[EmotionsCharts]', e)
      queueMicrotask(() => setChartError(msg))
      return () => {
        try {
          eqChart?.remove()
          ddChart?.remove()
        } catch {
          /* ignore */
        }
      }
    }
  }, [equityPoints, markers, dark])

  if (!equityPoints?.length) return null

  return (
    <div className="emotions-charts trade-tv-charts">
      {chartError && (
        <div className="positions-error emotions-chart-error" role="alert">
          <p className="positions-error-title">Chart failed to render</p>
          <p className="positions-error-msg">{chartError}</p>
          <p className="trade-tv-hint">Scores and tables below still work. Try refreshing the page.</p>
        </div>
      )}
      <p className="trade-tv-hint emotions-charts-hint">
        Cumulative realized PnL (top) and drawdown from rolling peak (bottom). Green
        markers: new equity high; red: drawdown thresholds; amber burst: compressed
        tempo. Pan/zoom synced.
      </p>
      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">Cumulative realized PnL (USDT)</h3>
        <div ref={eqRef} className="trade-tv-pane emotions-chart-pane" />
      </div>
      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">Drawdown from peak (%)</h3>
        <div ref={ddRef} className="trade-tv-pane emotions-chart-pane" />
      </div>
    </div>
  )
}
