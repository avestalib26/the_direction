import { ColorType, createChart, LineSeries } from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

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
    rightPriceScale: {
      borderColor: border,
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor: border,
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  }
}

function assignUniqueChartTimes(tradesAsc) {
  const used = new Set()
  return tradesAsc.map((t) => {
    let ts = Math.floor(t.exitTime / 1000)
    while (used.has(ts)) ts += 1
    used.add(ts)
    return { ...t, chartTime: ts }
  })
}

/** Cumulative sum of USDT PnL (notional × PnL% / 100 per trade). */
export function Backtest2WeightedChart({ trades }) {
  const wrapRef = useRef(null)
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

  useEffect(() => {
    if (!trades?.length || !wrapRef.current) return

    const ordered = [...trades].sort((a, b) => a.tradeNum - b.tradeNum)
    const withTime = assignUniqueChartTimes(ordered)
    let cum = 0
    const lineData = withTime.map((t) => {
      cum += t.pnlUsd
      return { time: t.chartTime, value: cum }
    })

    const chart = createChart(wrapRef.current, {
      ...chartLayout(dark),
      autoSize: true,
    })

    const series = chart.addSeries(LineSeries, {
      color: dark ? '#2962ff' : '#1e53e5',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    series.setData(lineData)
    chart.timeScale().fitContent()

    return () => {
      chart.remove()
    }
  }, [trades, dark])

  if (!trades?.length) return null

  return (
    <div className="backtest1-chart-block">
      <h3 className="backtest1-chart-label">Cumulative PnL (USDT)</h3>
      <p className="backtest1-chart-hint">
        Running sum of USDT PnL per trade:{' '}
        <strong>notional × (PnL % ÷ 100)</strong>, where notional = margin ×
        leverage × stake. Stake resets after wins and multiplies after losses.
      </p>
      <div ref={wrapRef} className="backtest1-chart-pane" />
    </div>
  )
}
