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

export function FiveMinScreenerCharts({ timeline, interval = '5m', intervalMinutes = 5 }) {
  const next5Ref = useRef(null)
  const next10Ref = useRef(null)
  const contRef = useRef(null)
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  useEffect(() => {
    if (!Array.isArray(timeline) || timeline.length < 2) return
    if (!next5Ref.current || !next10Ref.current || !contRef.current) return

    const points = timeline.map((t) => ({
      time: Math.floor(t.openTime / 1000),
      next1Sum: Number(t.next1PctSum ?? 0),
      next2Sum: Number(t.next2PctSum ?? 0),
      spikes: Number(t.spikeCount ?? 0),
    }))
    const meta = new Map(points.map((p, i) => [p.time, { ...p, idx: i }]))
    const d5 = points.map((p) => ({
      time: p.time,
      value: p.next1Sum,
      color: p.next1Sum >= 0 ? POS : NEG,
    }))
    const d10 = points.map((p) => ({
      time: p.time,
      value: p.next2Sum,
      color: p.next2Sum >= 0 ? POS : NEG,
    }))
    const contSet = new Set()
    for (let i = 0; i < points.length; i++) {
      if (points[i].next1Sum <= 0) continue
      const n1 = points[i + 1]
      if (n1) contSet.add(n1.time)
    }
    const dCont = points
      .filter((p) => contSet.has(p.time))
      .map((p) => ({
        time: p.time,
        value: p.next1Sum,
        color: p.next1Sum >= 0 ? POS : NEG,
      }))
    let cum5 = 0
    let cum10 = 0
    const d5Cum = points.map((p) => {
      cum5 += p.next1Sum
      return { time: p.time, value: cum5 }
    })
    const d10Cum = points.map((p) => {
      cum10 += p.next2Sum
      return { time: p.time, value: cum10 }
    })
    let cumCont = 0
    const dContCum = dCont.map((p) => {
      cumCont += p.value
      return { time: p.time, value: cumCont }
    })

    const base = chartLayout(dark)
    const c5 = createChart(next5Ref.current, { ...base, autoSize: true })
    const c10 = createChart(next10Ref.current, { ...base, autoSize: true })
    const cCont = createChart(contRef.current, { ...base, autoSize: true })

    const s5 = c5.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      base: 0,
    })
    const s10 = c10.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      base: 0,
    })
    const sCont = cCont.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      base: 0,
    })
    const l5 = c5.addSeries(LineSeries, {
      color: '#f0b90b',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const l10 = c10.addSeries(LineSeries, {
      color: '#f0b90b',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const lCont = cCont.addSeries(LineSeries, {
      color: '#f0b90b',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    s5.setData(d5)
    s10.setData(d10)
    sCont.setData(dCont)
    l5.setData(d5Cum)
    l10.setData(d10Cum)
    lCont.setData(dContCum)

    const setFromParam = (param) => {
      if (param.time == null) return
      const ts = typeof param.time === 'number' ? param.time : null
      if (ts == null) return
      const m = meta.get(ts)
      if (!m) return
      setHover({
        timeUtc: new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19),
        spikes: m.spikes,
        next1: m.next1Sum,
        next2: m.next2Sum,
        cum5: d5Cum[m.idx]?.value ?? 0,
        cum10: d10Cum[m.idx]?.value ?? 0,
        cont: contSet.has(ts) ? m.next1Sum : null,
      })
    }

    let lock = false
    const syncAll = (src, range) => {
      if (lock || range === null) return
      lock = true
      if (src !== 'c5') c5.timeScale().setVisibleRange(range)
      if (src !== 'c10') c10.timeScale().setVisibleRange(range)
      if (src !== 'cont') cCont.timeScale().setVisibleRange(range)
      lock = false
    }
    const syncFrom5 = (range) => syncAll('c5', range)
    const syncFrom10 = (range) => syncAll('c10', range)
    const syncFromCont = (range) => syncAll('cont', range)

    c5.timeScale().subscribeVisibleTimeRangeChange(syncFrom5)
    c10.timeScale().subscribeVisibleTimeRangeChange(syncFrom10)
    cCont.timeScale().subscribeVisibleTimeRangeChange(syncFromCont)
    c5.subscribeCrosshairMove(setFromParam)
    c10.subscribeCrosshairMove(setFromParam)
    cCont.subscribeCrosshairMove(setFromParam)
    c5.timeScale().fitContent()
    c10.timeScale().fitContent()
    cCont.timeScale().fitContent()

    return () => {
      c5.timeScale().unsubscribeVisibleTimeRangeChange(syncFrom5)
      c10.timeScale().unsubscribeVisibleTimeRangeChange(syncFrom10)
      cCont.timeScale().unsubscribeVisibleTimeRangeChange(syncFromCont)
      c5.unsubscribeCrosshairMove(setFromParam)
      c10.unsubscribeCrosshairMove(setFromParam)
      cCont.unsubscribeCrosshairMove(setFromParam)
      c5.remove()
      c10.remove()
      cCont.remove()
    }
  }, [timeline, dark])

  if (!Array.isArray(timeline) || timeline.length < 2) return null

  return (
    <div className="trade-tv-charts">
      <p className="trade-tv-hint">
        Drag to pan · scroll / pinch to zoom. Bars show interval sums across all spikes found in
        each {interval} bucket.
      </p>

      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">
          Next {interval} % sum bars + cumulative line
        </h3>
        <div ref={next5Ref} className="trade-tv-pane" />
      </div>

      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">
          Next {intervalMinutes * 2}m % sum bars + cumulative line
        </h3>
        <div ref={next10Ref} className="trade-tv-pane" />
      </div>

      <div className="trade-tv-chart-block">
        <h3 className="trade-tv-chart-label">
          Next bar after green signal (sequential) + cumulative line
        </h3>
        <div ref={contRef} className="trade-tv-pane" />
      </div>

      <div className={`trade-tv-crosshair ${hover ? 'trade-tv-crosshair--on' : ''}`}>
        {hover ? (
          <div className="trade-tv-crosshair-inner">
            <span className="trade-tv-preview-badge">Preview</span>
            <span className="trade-tv-tag">{hover.timeUtc} UTC</span>
            <span className="trade-tv-tag">spikes {hover.spikes}</span>
            <span className={`trade-tv-tag ${hover.next1 >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
              next{interval} {hover.next1 >= 0 ? '+' : ''}
              {hover.next1.toFixed(2)}%
            </span>
            <span className={`trade-tv-tag ${hover.cum5 >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
              cum {interval} {hover.cum5 >= 0 ? '+' : ''}
              {hover.cum5.toFixed(2)}%
            </span>
            <span className={`trade-tv-tag ${hover.next2 >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
              next{intervalMinutes * 2}m {hover.next2 >= 0 ? '+' : ''}
              {hover.next2.toFixed(2)}%
            </span>
            <span className={`trade-tv-tag ${hover.cum10 >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
              cum {intervalMinutes * 2}m {hover.cum10 >= 0 ? '+' : ''}
              {hover.cum10.toFixed(2)}%
            </span>
            {hover.cont != null && (
              <span className={`trade-tv-tag ${hover.cont >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                cont {hover.cont >= 0 ? '+' : ''}
                {hover.cont.toFixed(2)}%
              </span>
            )}
          </div>
        ) : (
          <span className="trade-tv-crosshair-placeholder">Hover bars to inspect interval values.</span>
        )}
      </div>
    </div>
  )
}

