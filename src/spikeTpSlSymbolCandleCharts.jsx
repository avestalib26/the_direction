/**
 * Per-symbol OHLC (TradingView Lightweight Charts candlesticks) for Spike TP/SL v1.
 * Data comes from the backtest response (same klines window as the run).
 */
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
} from 'lightweight-charts'
import { useEffect, useMemo, useRef, useState } from 'react'

const COL_POS = '#0ecb81'
const COL_NEG = '#f6465d'
const COL_EMA = '#f59e0b'

function chartLayout(dark) {
  const bg = dark ? '#1e2329' : '#ffffff'
  const text = dark ? '#b7bdc6' : '#474d57'
  const grid = dark ? '#2b3139' : '#eaecef'
  const border = dark ? '#2b3139' : '#eaecef'
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
    crosshair: { mode: CrosshairMode.Normal },
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
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  }
}

function candleRowsFromApi(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return []
  const used = new Set()
  return candles.map((c) => {
    let t = Math.floor(Number(c.openTime) / 1000)
    if (!Number.isFinite(t)) t = 0
    while (used.has(t)) t += 1
    used.add(t)
    return {
      time: t,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }
  })
}

/** EMA points aligned to main-interval open times (from server). */
function emaLineFromApi(chartEma) {
  if (!Array.isArray(chartEma) || chartEma.length === 0) return []
  const used = new Set()
  const out = []
  for (const row of chartEma) {
    const ema = row.ema
    if (ema == null || !Number.isFinite(Number(ema))) continue
    let t = Math.floor(Number(row.openTime) / 1000)
    if (!Number.isFinite(t)) t = 0
    while (used.has(t)) t += 1
    used.add(t)
    out.push({ time: t, value: Number(ema) })
  }
  out.sort((a, b) => Number(a.time) - Number(b.time))
  return out
}

function markerDataForSymbol(chartTradeMarkers, symbol, tMin, tMax) {
  if (!Array.isArray(chartTradeMarkers) || chartTradeMarkers.length === 0) {
    return {
      candleMarkers: [],
      spikeLineData: [],
      entryLineData: [],
      occurrenceLineData: [],
      closeLineData: [],
    }
  }

  const spikeTimes = new Set()
  const entryTimes = new Set()
  const occurrenceTimes = new Set()
  const closeTimes = new Set()

  for (const row of chartTradeMarkers) {
    if (row.symbol !== symbol) continue

    if (Number.isFinite(row.spikeOpenTime)) {
      const sec = Math.floor(row.spikeOpenTime / 1000)
      if (sec >= tMin && sec <= tMax) spikeTimes.add(sec)
    }
    if (Number.isFinite(row.entryOpenTime)) {
      const sec = Math.floor(row.entryOpenTime / 1000)
      if (sec >= tMin && sec <= tMax) entryTimes.add(sec)
    }
    if (Number.isFinite(row.occurrenceOpenTime)) {
      const sec = Math.floor(row.occurrenceOpenTime / 1000)
      if (sec >= tMin && sec <= tMax) occurrenceTimes.add(sec)
    }
    if (Number.isFinite(row.exitOpenTime)) {
      const sec = Math.floor(row.exitOpenTime / 1000)
      if (sec >= tMin && sec <= tMax) closeTimes.add(sec)
    }
  }

  const candleMarkers = []
  const spikeLineData = []
  const entryLineData = []
  const occurrenceLineData = []
  const closeLineData = []

  for (const sec of [...spikeTimes].sort((a, b) => a - b)) {
    candleMarkers.push({
      time: sec,
      position: 'belowBar',
      color: '#a855f7',
      shape: 'arrowUp',
      text: 'Spike',
    })
    spikeLineData.push({
      time: sec,
      value: 1,
      color: 'rgba(168, 85, 247, 0.40)',
    })
  }

  for (const sec of [...entryTimes].sort((a, b) => a - b)) {
    candleMarkers.push({
      time: sec,
      position: 'aboveBar',
      color: '#2563eb',
      shape: 'arrowDown',
      text: 'Entry',
    })
    entryLineData.push({
      time: sec,
      value: 1,
      color: 'rgba(37, 99, 235, 0.34)',
    })
  }

  for (const sec of [...occurrenceTimes].sort((a, b) => a - b)) {
    candleMarkers.push({
      time: sec,
      position: 'aboveBar',
      color: '#facc15',
      shape: 'circle',
      text: 'Occurrence',
    })
    occurrenceLineData.push({
      time: sec,
      value: 1,
      color: 'rgba(250, 204, 21, 0.55)',
    })
  }

  for (const sec of [...closeTimes].sort((a, b) => a - b)) {
    candleMarkers.push({
      time: sec,
      position: 'belowBar',
      color: '#22c55e',
      shape: 'circle',
      text: 'Close',
    })
    closeLineData.push({
      time: sec,
      value: 1,
      color: 'rgba(34, 197, 94, 0.52)',
    })
  }

  candleMarkers.sort((a, b) => Number(a.time) - Number(b.time))
  return { candleMarkers, spikeLineData, entryLineData, occurrenceLineData, closeLineData }
}

/** Filter-rejected long setups: yellow verticals at spike + would-be entry (same times as live trades). */
function skippedMarkerDataForSymbol(chartSkippedMarkers, symbol, tMin, tMax) {
  if (!Array.isArray(chartSkippedMarkers) || chartSkippedMarkers.length === 0) {
    return { candleMarkers: [], skipSpikeLineData: [], skipEntryLineData: [] }
  }

  const spikeTimes = new Set()
  const entryTimes = new Set()

  for (const row of chartSkippedMarkers) {
    const isEmaSkip =
      row.reason === 'ema96_5m' ||
      row.reason === 'ema96_5m_long' ||
      row.reason === 'ema96_5m_slope_long' ||
      row.reason === 'ema96_5m_short'
    if (row.symbol !== symbol || !isEmaSkip) continue
    if (Number.isFinite(row.spikeOpenTime)) {
      const sec = Math.floor(row.spikeOpenTime / 1000)
      if (sec >= tMin && sec <= tMax) spikeTimes.add(sec)
    }
    if (Number.isFinite(row.entryOpenTime)) {
      const sec = Math.floor(row.entryOpenTime / 1000)
      if (sec >= tMin && sec <= tMax) entryTimes.add(sec)
    }
  }

  const candleMarkers = []
  const skipSpikeLineData = []
  const skipEntryLineData = []

  for (const sec of [...spikeTimes].sort((a, b) => a - b)) {
    candleMarkers.push({
      time: sec,
      position: 'belowBar',
      color: '#ca8a04',
      shape: 'circle',
      text: 'Skip spike',
    })
    skipSpikeLineData.push({
      time: sec,
      value: 1,
      color: 'rgba(234, 179, 8, 0.48)',
    })
  }

  for (const sec of [...entryTimes].sort((a, b) => a - b)) {
    candleMarkers.push({
      time: sec,
      position: 'aboveBar',
      color: '#ca8a04',
      shape: 'circle',
      text: 'Skip entry',
    })
    skipEntryLineData.push({
      time: sec,
      value: 1,
      color: 'rgba(202, 138, 4, 0.44)',
    })
  }

  candleMarkers.sort((a, b) => Number(a.time) - Number(b.time))
  return { candleMarkers, skipSpikeLineData, skipEntryLineData }
}

function SymbolCandleChart({
  symbol,
  candles,
  chartEma,
  chartTradeMarkers,
  chartSkippedMarkers,
  interval,
}) {
  const wrapRef = useRef(null)
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  const rows = useMemo(() => candleRowsFromApi(candles), [candles])
  const emaRows = useMemo(() => emaLineFromApi(chartEma), [chartEma])

  const markerBundle = useMemo(() => {
    if (rows.length === 0) {
      return {
        candleMarkers: [],
        spikeLineData: [],
        entryLineData: [],
        occurrenceLineData: [],
        closeLineData: [],
        skipSpikeLineData: [],
        skipEntryLineData: [],
      }
    }
    const lo = rows[0].time
    const hi = rows[rows.length - 1].time
    const trade = markerDataForSymbol(chartTradeMarkers, symbol, lo, hi)
    const skip = skippedMarkerDataForSymbol(chartSkippedMarkers, symbol, lo, hi)
    const candleMarkers = [...trade.candleMarkers, ...skip.candleMarkers].sort(
      (a, b) => Number(a.time) - Number(b.time),
    )
    return {
      candleMarkers,
      spikeLineData: trade.spikeLineData,
      entryLineData: trade.entryLineData,
      occurrenceLineData: trade.occurrenceLineData,
      closeLineData: trade.closeLineData,
      skipSpikeLineData: skip.skipSpikeLineData,
      skipEntryLineData: skip.skipEntryLineData,
    }
  }, [rows, chartTradeMarkers, chartSkippedMarkers, symbol])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el || rows.length < 2) return undefined

    const chart = createChart(el, { ...chartLayout(dark), autoSize: true })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
      wickVisible: true,
    })
    series.setData(rows)

    if (emaRows.length > 0) {
      const emaSeries = chart.addSeries(LineSeries, {
        color: COL_EMA,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      emaSeries.setData(emaRows)
    }

    // Dedicated hidden scale: histogram columns become vertical marker lines without distorting OHLC prices.
    const spikeLineSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'marker-lines',
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const entryLineSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'marker-lines',
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const occurrenceLineSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'marker-lines',
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const closeLineSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'marker-lines',
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const skipSpikeLineSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'marker-lines',
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const skipEntryLineSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'marker-lines',
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('marker-lines').applyOptions({
      visible: false,
      autoScale: true,
      scaleMargins: { top: 0, bottom: 0 },
    })
    spikeLineSeries.setData(markerBundle.spikeLineData)
    entryLineSeries.setData(markerBundle.entryLineData)
    occurrenceLineSeries.setData(markerBundle.occurrenceLineData)
    closeLineSeries.setData(markerBundle.closeLineData)
    skipSpikeLineSeries.setData(markerBundle.skipSpikeLineData)
    skipEntryLineSeries.setData(markerBundle.skipEntryLineData)

    if (markerBundle.candleMarkers.length > 0) {
      try {
        series.setMarkers(markerBundle.candleMarkers)
      } catch {
        // no-op if markers API differs by runtime type version
      }
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
  }, [rows, emaRows, markerBundle, dark])

  if (rows.length < 2) {
    return (
      <div className="spike-tpsl-sym-candle-block">
        <h3 className="spike-tpsl-sym-candle-title">{symbol}</h3>
        <p className="hourly-spikes-hint">Not enough bars to plot.</p>
      </div>
    )
  }

  return (
    <div className="spike-tpsl-sym-candle-block">
      <h3 className="spike-tpsl-sym-candle-title">{symbol}</h3>
      <div ref={wrapRef} className="spike-tpsl-sym-candle-chart" style={{ minHeight: 260 }} />
      <p className="hourly-spikes-hint spike-tpsl-sym-candle-foot">
        <strong>{interval}</strong> ? <strong style={{ color: COL_EMA }}>EMA 96</strong> (5m close, mapped to
        chart times){' '}
        ? markers: <strong style={{ color: '#a855f7' }}>Spike</strong> /{' '}
        <strong style={{ color: '#2563eb' }}>Entry</strong> (taken) /{' '}
        <strong style={{ color: '#facc15' }}>Occurrence</strong> /{' '}
        <strong style={{ color: '#22c55e' }}>Close</strong>{' '}
        ? <strong style={{ color: '#ca8a04' }}>Skip</strong> (EMA filter rejected)
      </p>
    </div>
  )
}

export function SpikeTpSlSymbolCandleCharts({
  chartCandlesBySymbol,
  chartEmaBySymbol,
  chartTradeMarkers,
  chartSkippedMarkers,
  interval,
  chartMaxCandlesPerSymbol,
  chartMaxSymbols,
  chartSymbolsReturned,
  chartSymbolsWithTradesTotal,
}) {
  const symbols = useMemo(() => {
    const o = chartCandlesBySymbol
    if (!o || typeof o !== 'object') return []
    return Object.keys(o).sort()
  }, [chartCandlesBySymbol])

  if (symbols.length === 0) return null

  const cappedSyms =
    chartSymbolsWithTradesTotal != null &&
    chartSymbolsReturned != null &&
    chartSymbolsWithTradesTotal > chartSymbolsReturned

  return (
    <section className="hourly-spikes-section spike-tpsl-ohlc-section">
      <h2 className="hourly-spikes-h2">OHLC: symbols with trades or filter skips</h2>
      <p className="hourly-spikes-hint">
        <strong>TradingView Lightweight Charts</strong> (candlesticks). Same kline interval and window as this
        run (last <strong>{chartMaxCandlesPerSymbol ?? 'N'}</strong> bars per chart if the series was longer).
        {cappedSyms ? (
          <>
            {' '}
            Showing <strong>{chartSymbolsReturned}</strong> of <strong>{chartSymbolsWithTradesTotal}</strong>{' '}
            symbols (cap <strong>{chartMaxSymbols}</strong>; raise{' '}
            <code className="inline-code">SPIKE_TPSL_CHART_MAX_SYMBOLS</code> on the server if needed).
          </>
        ) : null}
      </p>
      <div className="spike-tpsl-sym-candle-stack">
        {symbols.map((sym) => (
          <SymbolCandleChart
            key={sym}
            symbol={sym}
            candles={chartCandlesBySymbol[sym]}
            chartEma={chartEmaBySymbol?.[sym]}
            chartTradeMarkers={chartTradeMarkers}
            chartSkippedMarkers={chartSkippedMarkers}
            interval={interval}
          />
        ))}
      </div>
    </section>
  )
}
