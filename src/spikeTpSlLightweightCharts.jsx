/**
 * TradingView Lightweight Charts (canvas) — avoids huge SVG DOM that can blank the page.
 * X-axis uses synthetic UTC timestamps (1 minute per trade index) so every bar is unique.
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'
import { EQUITY_STACK_BASE, normalizeEquityEmaPeriod } from './equityEmaInteractiveFilter.js'

const PER_TRADE_CAP = 3500
const SYNTH_BASE = 1577836800 // 2020-01-01 00:00 UTC (seconds)

export function synthTradeTime(tradeIndex) {
  return SYNTH_BASE + Math.max(0, tradeIndex) * 60
}

function tradePriceReturnPctFromRow(t) {
  const e = t.entryPrice ?? t.entry
  const x = t.exitPrice
  if (!Number.isFinite(e) || e === 0 || !Number.isFinite(x)) return 0
  if (t.side === 'short') return ((e - x) / e) * 100
  return ((x - e) / e) * 100
}

function computeEmaOnSeries(closes, period) {
  const out = closes.map(() => null)
  if (!Array.isArray(closes) || closes.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

function buildPerTradeRows(perTradePricePctChron, tradesFallback) {
  let raw = perTradePricePctChron
  if (Array.isArray(raw) && raw.length > 0) {
    raw = raw.map((x) => {
      const v = Number(x)
      return Number.isFinite(v) ? v : 0
    })
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    if (!Array.isArray(tradesFallback) || tradesFallback.length === 0) {
      return { rows: [], total: 0, clientSampled: false }
    }
    const sorted = [...tradesFallback].sort((a, b) => {
      if (a.entryOpenTime !== b.entryOpenTime) return a.entryOpenTime - b.entryOpenTime
      return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
    })
    raw = sorted.map(tradePriceReturnPctFromRow)
  }
  const total = raw.length
  if (total <= PER_TRADE_CAP) {
    return {
      rows: raw.map((pct, chronIndex) => ({ pct, chronIndex })),
      total,
      clientSampled: false,
    }
  }
  const rows = []
  for (let k = 0; k < PER_TRADE_CAP; k++) {
    const chronIndex = Math.floor((k / (PER_TRADE_CAP - 1)) * (total - 1))
    rows.push({ pct: raw[chronIndex], chronIndex })
  }
  return { rows, total, clientSampled: true }
}

function equityToLineData(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  const data = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const k = Number.isFinite(p.tradeIndex) ? p.tradeIndex : i
    const v = Number(p.pnlPctFromStart)
    if (!Number.isFinite(v)) continue
    data.push({ time: synthTradeTime(k), value: v })
  }
  return data.length >= 2 ? data : null
}

function btcOverlayLineData(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  const data = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const k = Number.isFinite(p.tradeIndex) ? p.tradeIndex : i
    const v = Number(p.btcCloseUsd)
    if (!Number.isFinite(v)) continue
    data.push({ time: synthTradeTime(k), value: v })
  }
  return data.length >= 2 ? data : null
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

const COL_BG = 'rgba(22, 26, 32, 0.98)'
const COL_TEXT = '#B7BDC6'
const COL_GRID = 'rgba(255, 255, 255, 0.06)'
const COL_POS = '#0ecb81'
const COL_NEG = '#f6465d'
const COL_BTC = '#f0b90b'
const COL_EMA_SLOW = '#f59e0b'

export function SpikeTpSlEquityLightChart({
  points,
  /** Optional second line: e.g. unfiltered cumulative when the main line is EMA-filtered (dimmer). */
  baselinePoints = null,
  showFootnote = true,
}) {
  const containerRef = useRef(null)
  const lineData = useMemo(() => equityToLineData(points), [points])
  const baselineData = useMemo(() => (baselinePoints ? equityToLineData(baselinePoints) : null), [baselinePoints])
  const btcData = useMemo(() => btcOverlayLineData(points), [points])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !lineData) return undefined

    const showBtc = btcData && btcData.length >= 2
    const showBaseline = baselineData && baselineData.length >= 2

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
      leftPriceScale: {
        visible: showBtc,
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      rightPriceScale: {
        visible: true,
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    if (showBaseline) {
      const baseSeries = chart.addSeries(LineSeries, {
        color: 'rgba(183, 189, 198, 0.35)',
        lineWidth: 1,
        priceScaleId: 'right',
        priceFormat: {
          type: 'custom',
          minMove: 0.01,
          formatter: (p) => `${Number(p).toFixed(2)}%`,
        },
      })
      baseSeries.setData(baselineData)
    }

    const last = lineData[lineData.length - 1]?.value ?? 0
    const series = chart.addSeries(LineSeries, {
      color: last >= 0 ? COL_POS : COL_NEG,
      lineWidth: 2,
      priceScaleId: 'right',
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (p) => `${Number(p).toFixed(2)}%`,
      },
    })
    series.setData(lineData)

    if (showBtc) {
      const btcSeries = chart.addSeries(LineSeries, {
        color: COL_BTC,
        lineWidth: 1,
        priceScaleId: 'left',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      })
      btcSeries.setData(btcData)
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
  }, [lineData, baselineData, btcData])

  if (!lineData) {
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot the curve.</p>
    )
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      {showFootnote ? (
        <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
          <strong>TradingView Lightweight Charts</strong> — time axis is synthetic (one step per trade #).
          <strong> Right axis</strong>: cumulative Σ price %.
          {baselineData && baselineData.length >= 2 ? (
            <>
              {' '}
              <strong>Dim line</strong>: all trades (unfiltered). <strong>Bold line</strong>: filtered mode — flat
              stretches mean consecutive trades did not pass the entry gate, so the running Σ does not move.
            </>
          ) : null}
          {btcData && btcData.length >= 2 ? (
            <>
              {' '}
              <strong>Left axis</strong>: BTCUSDT close at each trade&apos;s entry bar (same interval as backtest).
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

export function SpikeTpSlPerTradeLightChart({
  perTradePricePctChron,
  tradesFallback,
  totalTradeRows,
  serverSubsampled,
}) {
  const containerRef = useRef(null)
  const pack = useMemo(
    () => buildPerTradeRows(perTradePricePctChron, tradesFallback),
    [perTradePricePctChron, tradesFallback],
  )

  const histData = useMemo(() => {
    if (!pack.rows.length) return null
    return pack.rows.map((r, i) => {
      const pct = Number.isFinite(Number(r.pct)) ? Number(r.pct) : 0
      const color = pct > 0 ? COL_POS : pct < 0 ? COL_NEG : '#848e9c'
      return {
        time: synthTradeTime(i + 1),
        value: pct,
        color,
      }
    })
  }, [pack.rows])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !histData) return undefined

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
      rightPriceScale: { borderColor: COL_GRID },
      localization: {
        priceFormatter: (p) => `${Number(p).toFixed(3)}%`,
      },
    })

    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
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
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot per-trade bars.</p>
    )
  }

  const fullN =
    Number.isFinite(totalTradeRows) && totalTradeRows > 0 ? totalTradeRows : pack.total

  return (
    <div className="spike-tpsl-lw-host">
      {serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          API sent <strong>{histData.length}</strong> trade % values of <strong>{fmtInt(fullN)}</strong> total
          (payload cap). Chart uses those points.
        </p>
      )}
      {pack.clientSampled && !serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          Showing <strong>{histData.length}</strong> of <strong>{pack.total}</strong> trades (cap {PER_TRADE_CAP}).
        </p>
      )}
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
      <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
        <strong>TradingView Lightweight Charts</strong> — each bar is one trade&apos;s price % (green / red);
        time axis is synthetic by trade order. Full run: <strong>{fmtInt(fullN)}</strong> trades.
      </p>
    </div>
  )
}

/**
 * Stacked equity candlesticks: each bar is cumulative 100 + Σ trade % (wins/losses stack); bodies only; EMA on close.
 */
export function SpikeTpSlPerTradeCandleLightChart({
  perTradePricePctChron,
  tradesFallback,
  totalTradeRows,
  serverSubsampled,
  emaPeriod = 50,
  showFooterHint = true,
  /** `pnlFromZero` = same cumulative Σ price % axis as the equity line chart; `stack100` = 100 + Σ (legacy). */
  cumulativePnlScale = 'stack100',
}) {
  const containerRef = useRef(null)
  const emaPeriodSafe = normalizeEquityEmaPeriod(emaPeriod)

  const pack = useMemo(
    () => buildPerTradeRows(perTradePricePctChron, tradesFallback),
    [perTradePricePctChron, tradesFallback],
  )

  const candleData = useMemo(() => {
    if (!pack.rows.length) return null
    const used = new Set()
    const rows = []
    const base = cumulativePnlScale === 'pnlFromZero' ? 0 : EQUITY_STACK_BASE
    let level = base
    for (let i = 0; i < pack.rows.length; i++) {
      const pct = Number(pack.rows[i].pct)
      const p = Number.isFinite(pct) ? pct : 0
      const open = level
      const close = level + p
      level = close
      let high = Math.max(open, close)
      let low = Math.min(open, close)
      if (!(high > low)) {
        const pad = 1e-4
        high = open + pad
        low = open - pad
      }
      let t = synthTradeTime(i + 1)
      while (used.has(t)) t += 1
      used.add(t)
      rows.push({ time: t, open, high, low, close })
    }
    return rows.length > 0 ? rows : null
  }, [pack.rows, cumulativePnlScale])

  const emaLineData = useMemo(() => {
    if (!candleData) return null
    const closes = candleData.map((r) => r.close)
    const emaArr = computeEmaOnSeries(closes, emaPeriodSafe)
    const out = []
    for (let i = 0; i < candleData.length; i++) {
      const v = emaArr[i]
      if (v == null || !Number.isFinite(v)) continue
      out.push({ time: candleData[i].time, value: v })
    }
    return out.length >= 2 ? out : null
  }, [candleData, emaPeriodSafe])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !candleData || candleData.length === 0) return undefined

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
      crosshair: { mode: CrosshairMode.Normal },
      width: el.clientWidth,
      height: 320,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      localization: {
        priceFormatter: (p) =>
          cumulativePnlScale === 'pnlFromZero'
            ? `${Number(p).toFixed(2)}%`
            : Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
    })
    candleSeries.setData(candleData)

    if (emaLineData && emaLineData.length >= 2) {
      const emaSeries = chart.addSeries(LineSeries, {
        color: COL_EMA_SLOW,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      emaSeries.setData(emaLineData)
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
  }, [candleData, emaLineData, emaPeriodSafe, cumulativePnlScale])

  if (!candleData) {
    return (
      <p className="hourly-spikes-hint">Run a backtest with at least one trade to plot stacked equity candles.</p>
    )
  }

  const fullN =
    Number.isFinite(totalTradeRows) && totalTradeRows > 0 ? totalTradeRows : pack.total

  return (
    <div className="spike-tpsl-lw-host spike-tpsl-pertrade-candle-host">
      {serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          API sent <strong>{candleData.length}</strong> stacked bars of <strong>{fmtInt(fullN)}</strong> total
          (payload cap). Same subsample as the histogram.
        </p>
      )}
      {pack.clientSampled && !serverSubsampled && (
        <p className="hourly-spikes-hint spike-tpsl-pertrade-sample-hint">
          Showing <strong>{candleData.length}</strong> of <strong>{pack.total}</strong> trades (cap{' '}
          {PER_TRADE_CAP}).
        </p>
      )}
      <div ref={containerRef} className="spike-tpsl-lw-chart spike-tpsl-pertrade-candle-chart" />
      {showFooterHint ? (
        <p className="hourly-spikes-hint spike-tpsl-lw-axis-hint">
          <strong>TradingView Lightweight Charts</strong> —{' '}
          {cumulativePnlScale === 'pnlFromZero' ? (
            <>
              <strong>cumulative Σ price %</strong> (same scale as the equity line): each candle body is one
              trade&apos;s return added to the running total (no wicks).
            </>
          ) : (
            <>
              <strong>stacked equity</strong> (starts at {EQUITY_STACK_BASE}): each candle body is that trade&apos;s
              P&amp;L % added to the running total (no wicks).
            </>
          )}{' '}
          <strong style={{ color: COL_EMA_SLOW }}>EMA {emaPeriodSafe}</strong> on cumulative close — starts after
          enough bars (warmup). Filter uses <strong>cumulative &gt; EMA</strong> before each trade. Time = trade order
          (synthetic). Full run: <strong>{fmtInt(fullN)}</strong> trades.
        </p>
      ) : null}
    </div>
  )
}

function candlestickRowsFromOpenTimeApi(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null
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

/**
 * OHLC candlesticks + EMA on close (TradingView Lightweight Charts). `candles`: API rows with openTime ms.
 */
export function BtcOhlcEmaChart({ candles, emaPeriod = 50 }) {
  const containerRef = useRef(null)
  const candleData = useMemo(() => candlestickRowsFromOpenTimeApi(candles), [candles])
  const emaLineData = useMemo(() => {
    if (!candleData?.length || !Number.isFinite(emaPeriod) || emaPeriod < 2) return null
    const closes = candleData.map((c) => c.close)
    const emaArr = computeEmaOnSeries(closes, emaPeriod)
    const out = []
    for (let i = 0; i < candleData.length; i++) {
      const v = emaArr[i]
      if (v == null || !Number.isFinite(v)) continue
      out.push({ time: candleData[i].time, value: v })
    }
    return out.length >= 2 ? out : null
  }, [candleData, emaPeriod])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !candleData?.length) return undefined

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
      height: 300,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
    })
    candleSeries.setData(candleData)

    if (emaLineData && emaLineData.length >= 2) {
      const lineSeries = chart.addSeries(LineSeries, {
        color: COL_EMA_SLOW,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      lineSeries.setData(emaLineData)
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
  }, [candleData, emaLineData])

  if (!candleData?.length) {
    return <p className="hourly-spikes-hint">No OHLC series (enable chart candles on the run).</p>
  }

  return (
    <div className="spike-tpsl-lw-host">
      <div ref={containerRef} className="spike-tpsl-lw-chart" />
    </div>
  )
}
