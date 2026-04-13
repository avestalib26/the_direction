import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import {
  BREADTH_MOMENTUM_EMA_PERIOD,
  computeBreadthMomentumSeries,
} from './breadthInsights'

const UP = '#0ecb81'
const DOWN = '#f6465d'
const LINE_DIM = '#c99400'
const EMA_LINE = '#2962ff'

/** Sum of each coin's open→close % for that candle (equal-weight coins, raw sum). */
function sumCoinPctPerCandle(symbolRows, nCandles) {
  const out = new Array(nCandles).fill(0)
  if (!symbolRows.length || nCandles === 0) return out
  for (let j = 0; j < nCandles; j++) {
    let sum = 0
    for (const row of symbolRows) {
      const p = row.candles[j]?.changePct
      if (p != null && Number.isFinite(p)) {
        sum += p
      }
    }
    out[j] = sum
  }
  return out
}

function cumulativeSum(values) {
  const out = []
  let s = 0
  for (const v of values) {
    s += v
    out.push(s)
  }
  return out
}

function assignUniqueChartTimes(candlesAsc) {
  const used = new Set()
  return candlesAsc.map((c) => {
    let t = Math.floor(c.openTime / 1000)
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
      secondsVisible: false,
      rightOffset: 2,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  }
}

function syncVisibleRanges(charts) {
  const unsub = []
  let lock = false
  for (const source of charts) {
    const fn = (range) => {
      if (lock || range == null) return
      lock = true
      for (const c of charts) {
        if (c !== source) {
          c.timeScale().setVisibleRange(range)
        }
      }
      lock = false
    }
    source.timeScale().subscribeVisibleTimeRangeChange(fn)
    unsub.push(() => source.timeScale().unsubscribeVisibleTimeRangeChange(fn))
  }
  return () => {
    for (const u of unsub) u()
  }
}

export function BreadthBarCharts({ candles, symbolRows }) {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  const ref1 = useRef(null)
  const ref2 = useRef(null)
  const ref3 = useRef(null)
  const ref4 = useRef(null)
  const ref5 = useRef(null)
  const ref6 = useRef(null)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  const hasSymbolRows = symbolRows.length > 0

  useEffect(() => {
    if (!candles.length) return

    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime)
    const enriched = assignUniqueChartTimes(sorted)
    const n = enriched.length

    const layout = chartLayout(dark)
    const charts = []
    const cleanupFns = []

    const mk = (container) => {
      const c = createChart(container, { ...layout, autoSize: true })
      charts.push(c)
      return c
    }

    // —— Chart 1: counts ——
    if (ref1.current) {
      const ch = mk(ref1.current)
      const g = ch.addSeries(HistogramSeries, {
        color: UP,
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
        base: 0,
      })
      const r = ch.addSeries(HistogramSeries, {
        color: DOWN,
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
        base: 0,
      })
      g.setData(enriched.map((c) => ({ time: c.chartTime, value: c.green })))
      r.setData(
        enriched.map((c) => ({ time: c.chartTime, value: -c.red })),
      )
      ch.timeScale().fitContent()
    }

    // —— Chart 2: % ——
    if (ref2.current) {
      const ch = mk(ref2.current)
      const g = ch.addSeries(HistogramSeries, {
        color: UP,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        base: 0,
      })
      const r = ch.addSeries(HistogramSeries, {
        color: DOWN,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        base: 0,
      })
      g.setData(
        enriched.map((c) => ({ time: c.chartTime, value: c.greenPct })),
      )
      r.setData(
        enriched.map((c) => ({ time: c.chartTime, value: -c.redPct })),
      )
      ch.timeScale().fitContent()
    }

    // —— Chart 3: net breadth ——
    if (ref3.current) {
      const mom = computeBreadthMomentumSeries(
        sorted,
        BREADTH_MOMENTUM_EMA_PERIOD,
      )
      const ch = mk(ref3.current)
      const line = ch.addSeries(LineSeries, {
        color: LINE_DIM,
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      })
      line.setData(
        mom.map((m, i) => ({
          time: enriched[i].chartTime,
          value: m.netBreadth,
        })),
      )
      ch.timeScale().fitContent()
    }

    // —— Chart 4: EMA ——
    if (ref4.current) {
      const mom = computeBreadthMomentumSeries(
        sorted,
        BREADTH_MOMENTUM_EMA_PERIOD,
      )
      const ch = mk(ref4.current)
      const line = ch.addSeries(LineSeries, {
        color: EMA_LINE,
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      })
      line.setData(
        mom.map((m, i) => ({
          time: enriched[i].chartTime,
          value: m.emaNet,
        })),
      )
      ch.timeScale().fitContent()
    }

    if (hasSymbolRows && ref5.current && ref6.current) {
      const sums = sumCoinPctPerCandle(symbolRows, n)
      const cum = cumulativeSum(sums)

      // —— Chart 5: sum of coin % ——
      const ch5 = mk(ref5.current)
      const h5 = ch5.addSeries(HistogramSeries, {
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        base: 0,
      })
      h5.setData(
        enriched.map((c, i) => ({
          time: c.chartTime,
          value: sums[i],
          color: sums[i] >= 0 ? UP : DOWN,
        })),
      )
      ch5.timeScale().fitContent()

      // —— Chart 6: cumulative ——
      const ch6 = mk(ref6.current)
      const acc = dark ? '#f0b90b' : '#c99400'
      const area = ch6.addSeries(AreaSeries, {
        lineColor: acc,
        topColor: dark ? 'rgba(240, 185, 11, 0.35)' : 'rgba(201, 148, 0, 0.35)',
        bottomColor: dark ? 'rgba(240, 185, 11, 0.02)' : 'rgba(201, 148, 0, 0.02)',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      })
      area.setData(
        cum.map((v, i) => ({
          time: enriched[i].chartTime,
          value: v,
        })),
      )
      ch6.timeScale().fitContent()
    }

    const unsubSync = syncVisibleRanges(charts)
    cleanupFns.push(unsubSync)

    return () => {
      for (const u of cleanupFns) u()
      for (const c of charts) c.remove()
    }
  }, [candles, symbolRows, dark, hasSymbolRows])

  if (!candles.length) return null

  return (
    <section className="breadth-charts" aria-label="Breadth bar charts">
      <h2 className="breadth-detail-title">Breadth charts (1–6)</h2>
      <p className="breadth-lwc-hint">
        <strong>TradingView-style:</strong> drag to pan · mouse wheel or pinch to
        zoom · all charts below share the same time range (zoom one, the rest
        follow).
      </p>

      <figure className="breadth-chart-figure">
        <figcaption className="breadth-chart-title">1 · Coin counts per candle</figcaption>
        <p className="breadth-chart-sub">
          Green histogram up, red down from zero — same candle time on the axis.
        </p>
        <div ref={ref1} className="breadth-lwc-pane" />
      </figure>

      <figure className="breadth-chart-figure">
        <figcaption className="breadth-chart-title">
          2 · Green % and red % per candle
        </figcaption>
        <p className="breadth-chart-sub">
          Same layout as chart 1: green % above zero, red % as negative bars below.
        </p>
        <div ref={ref2} className="breadth-lwc-pane" />
      </figure>

      <figure className="breadth-chart-figure">
        <figcaption className="breadth-chart-title">
          3 · Net breadth (green% − red%)
        </figcaption>
        <p className="breadth-chart-sub">
          Line = participation skew per bar. Crosshair shows exact values.
        </p>
        <div ref={ref3} className="breadth-lwc-pane" />
      </figure>

      <figure className="breadth-chart-figure">
        <figcaption className="breadth-chart-title">
          4 · Breadth momentum EMA ({BREADTH_MOMENTUM_EMA_PERIOD})
        </figcaption>
        <p className="breadth-chart-sub">
          EMA of chart 3’s net breadth — smoother trend (same % units).
        </p>
        <div ref={ref4} className="breadth-lwc-pane" />
      </figure>

      {hasSymbolRows ? (
        <>
          <figure className="breadth-chart-figure">
            <figcaption className="breadth-chart-title">
              5 · Sum of coin % change (per candle)
            </figcaption>
            <p className="breadth-chart-sub">
              Sum of every coin’s open→close % for that candle (scales with symbol
              count).
            </p>
            <div ref={ref5} className="breadth-lwc-pane" />
          </figure>

          <figure className="breadth-chart-figure">
            <figcaption className="breadth-chart-title">
              6 · Cumulative sum of coin % (area)
            </figcaption>
            <p className="breadth-chart-sub">
              Running total of chart 5’s per-candle sums — drift over the window.
            </p>
            <div ref={ref6} className="breadth-lwc-pane" />
          </figure>
        </>
      ) : (
        <p className="breadth-chart-missing">
          Charts 5–6 need symbol rows (re-run breadth).
        </p>
      )}
    </section>
  )
}
