import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

const POS = '#0ecb81'
const NEG = '#f6465d'
const CUM = '#2962ff'

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

function uniqueTimes(slots) {
  const used = new Set()
  return slots.map((s) => {
    let t = Math.floor(s.openTime / 1000)
    while (used.has(t)) t += 1
    used.add(t)
    return { ...s, chartTime: t }
  })
}

function netForSlot(slot, netMode) {
  if (netMode === 'directionalNext') {
    return Number(slot.directionalNet ?? 0)
  }
  return Number(slot.longShortNetNextSum ?? 0)
}

/**
 * Per time-slot net (histogram) + cumulative sum (line).
 * `slots` should be enriched (see fiveMinSlotMetrics.js). `netMode` picks per-leg vs directional.
 */
export function FiveMinNetCumulativeChart({
  slots,
  interval = '5m',
  netMode = 'perLeg',
}) {
  const paneRef = useRef(null)
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
    if (!Array.isArray(slots) || slots.length === 0 || !paneRef.current) return

    const sorted = uniqueTimes(
      [...slots].sort((a, b) => a.openTime - b.openTime),
    )
    const hist = sorted.map((s) => {
      const net = netForSlot(s, netMode)
      return {
        time: s.chartTime,
        value: net,
        color: net >= 0 ? POS : NEG,
      }
    })
    let cum = 0
    const line = sorted.map((s) => {
      cum += netForSlot(s, netMode)
      return { time: s.chartTime, value: cum }
    })

    const chart = createChart(paneRef.current, {
      ...chartLayout(dark),
      autoSize: true,
    })
    const h = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      base: 0,
    })
    const l = chart.addSeries(LineSeries, {
      color: CUM,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: true,
      priceLineVisible: false,
    })
    h.setData(hist)
    l.setData(line)
    chart.timeScale().fitContent()

    return () => chart.remove()
  }, [slots, dark, netMode])

  if (!Array.isArray(slots) || slots.length === 0) return null

  const isDir = netMode === 'directionalNext'
  return (
    <div className="trade-tv-chart-block" style={{ marginBottom: '1rem' }}>
      <h3 className="trade-tv-chart-label">
        {isDir
          ? `Total % gain — directional next bar (wick Σ sign × total next %) per ${interval} slot + cumulative`
          : `Net long+/short− per ${interval} slot (bars) + cumulative % (line)`}
      </h3>
      <p className="backtest1-chart-hint" style={{ marginBottom: '0.5rem' }}>
        {isDir ? (
          <>
            <strong>Total % gain</strong>: each bar is the one-bar P&amp;L % from the rule (wick Σ
            &gt; 0 → long the <strong>sum</strong> of all spike next-bar %; wick Σ &lt; 0 → short that
            sum). The blue line is <strong>cumulative total % gain</strong> (running sum of those %
            points) through time.
          </>
        ) : (
          <>
            Each bar is <strong>Σ next (↑) − Σ next (↓)</strong> (long each ↑ leg, short each ↓ leg);
            the blue line is the running sum.
          </>
        )}
      </p>
      <div ref={paneRef} className="trade-tv-pane" />
    </div>
  )
}
