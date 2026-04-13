import { useCallback, useMemo, useState } from 'react'

const DEFAULT_CANDLES = 1500
const DEFAULT_THRESHOLD = 3
const DEFAULT_MAX_EVENTS = 8

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const d = a >= 1 ? 4 : 6
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

/** Per-trade PnL % from model side + next bar body % (long / short / flat). */
function tradePnlPct(r) {
  if (r.suggestedTradePnlPct != null && Number.isFinite(r.suggestedTradePnlPct)) {
    return r.suggestedTradePnlPct
  }
  const p = r.outcome?.predicted ?? r.direction?.predicted
  const b = r.targetBodyPctActual
  if (p == null || b == null || !Number.isFinite(b)) return null
  if (p === 'continuation') return b
  if (p === 'reversal') return -b
  if (p === 'neutral') return 0
  return null
}

function sumSuggestedPnlPct(rows) {
  return rows.reduce((s, r) => {
    const p = tradePnlPct(r)
    return p != null && Number.isFinite(p) ? s + p : s
  }, 0)
}

/** Realized % move on the hour after the spike: (close−open)/open on i+1. */
function nextBarBodyPctActual(r) {
  const b = r.targetBodyPctActual
  return b != null && Number.isFinite(b) ? b : null
}

function sumNextBarBodyPctActual(rows) {
  return rows.reduce((s, r) => {
    const b = nextBarBodyPctActual(r)
    return b != null ? s + b : s
  }, 0)
}

function GptPnlBarChart({
  rows,
  pnlFn = nextBarBodyPctActual,
  emptyMessage = 'No bars to plot (missing next-candle body %).',
  ariaLabel = 'Realized next-hour body percent per event',
}) {
  const chart = useMemo(() => {
    const series = rows
      .map((r, i) => ({
        i,
        label: String(i + 1),
        pnl: pnlFn(r),
        t: r.targetOpenTime ?? r.openTime,
      }))
      .filter((x) => x.pnl != null && Number.isFinite(x.pnl))

    const W = 560
    const H = 212
    const padL = 40
    const padR = 12
    const padT = 12
    const padB = 22
    const innerW = W - padL - padR
    const innerH = H - padT - padB

    if (series.length === 0) {
      return { series: [], bars: [], zeroY: padT + innerH / 2, w: W, h: H, minV: 0, maxV: 0 }
    }

    const vals = series.map((s) => s.pnl)
    let minV = Math.min(0, ...vals)
    let maxV = Math.max(0, ...vals)
    if (minV === maxV) {
      minV -= 0.05
      maxV += 0.05
    }
    const span = maxV - minV
    const yAt = (v) => padT + ((maxV - v) / span) * innerH
    const zeroY = yAt(0)
    const n = series.length
    const slotW = innerW / n
    const barW = Math.max(2, slotW * 0.62)
    const bars = series.map((s, j) => {
      const cx = padL + j * slotW + slotW / 2
      const x0 = cx - barW / 2
      const y0 = yAt(s.pnl)
      const top = Math.min(zeroY, y0)
      const bh = Math.abs(y0 - zeroY)
      return {
        ...s,
        x: x0,
        y: top,
        width: barW,
        height: Math.max(bh, 0.5),
        neg: s.pnl < 0,
        labX: cx,
        labY: H - 6,
      }
    })

    return { series, bars, zeroY, w: W, h: H, minV, maxV, padL, padR, padT, padB }
  }, [rows, pnlFn])

  if (chart.series.length === 0) {
    return (
      <p className="hourly-spikes-hint gpt-bt-pnl-empty">{emptyMessage}</p>
    )
  }

  const { bars, zeroY, w, h, minV, maxV, padL, padR } = chart

  return (
    <div className="gpt-bt-pnl-chart-wrap">
      <svg
        className="gpt-bt-pnl-chart"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={ariaLabel}
      >
        <text className="gpt-bt-pnl-axis" x={4} y={16}>
          {maxV.toFixed(2)}%
        </text>
        <text className="gpt-bt-pnl-axis" x={4} y={h - 4}>
          {minV.toFixed(2)}%
        </text>
        <line
          className="gpt-bt-pnl-zero"
          x1={padL}
          y1={zeroY}
          x2={w - padR}
          y2={zeroY}
        />
        {bars.map((b) => (
          <g key={`${b.t}-${b.i}`}>
            <rect
              className={
                b.neg ? 'gpt-bt-pnl-bar gpt-bt-pnl-bar--neg' : 'gpt-bt-pnl-bar gpt-bt-pnl-bar--pos'
              }
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              rx={1}
            />
            <text className="gpt-bt-pnl-xlabel" x={b.labX} y={b.labY} textAnchor="middle">
              {b.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

async function runGptBacktest(body) {
  const res = await fetch('/api/gpt-backtest/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export function GptBacktest() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [candleCount, setCandleCount] = useState(String(DEFAULT_CANDLES))
  const [thresholdPct, setThresholdPct] = useState(String(DEFAULT_THRESHOLD))
  const [maxEvents, setMaxEvents] = useState(String(DEFAULT_MAX_EVENTS))
  const [model, setModel] = useState('gpt-4o-mini')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const cc = Number.parseInt(String(candleCount).replace(/,/g, ''), 10)
      const th = Number.parseFloat(String(thresholdPct))
      const me = Number.parseInt(String(maxEvents), 10)
      const out = await runGptBacktest({
        symbol: symbol.trim(),
        candleCount: cc,
        thresholdPct: th,
        maxEvents: me,
        model: model.trim() || undefined,
      })
      setData(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }, [symbol, candleCount, thresholdPct, maxEvents, model])

  return (
    <div className="vol-screener gpt-backtest">
      <h1 className="vol-screener-title">GPT backtest</h1>
      <p className="vol-screener-lead">
        Fetches <strong>1h</strong> USDT-M klines and flags <strong>green candles</strong> whose
        body is at least <strong>threshold %</strong> above open (spike at{' '}
        <code className="inline-code">i</code>). Sends a <strong>50-candle OHLCV window</strong>{' '}
        ending at that bar to OpenAI with volume context and asks whether the <strong>next</strong> hour (
        <code className="inline-code">i+1</code>) is likely <strong>continuation</strong> (bullish bar),
        <strong>reversal</strong> (bearish fade), or <strong>neutral</strong> (tiny body) — framed as
        follow-through vs mean reversion, not generic &quot;will it go up.&quot; No price targets.
        Ground truth maps the same: bullish hour → continuation, bearish → reversal, flat → neutral.
        Requires{' '}
        <code className="inline-code">OPENAI_API_KEY</code> in server{' '}
        <code className="inline-code">.env</code>.
      </p>

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Symbol</span>
          <input
            className="vol-screener-input"
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="BTCUSDT"
            autoComplete="off"
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">1h candles to fetch</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="numeric"
            value={candleCount}
            onChange={(e) => setCandleCount(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min green body (% vs open)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="decimal"
            value={thresholdPct}
            onChange={(e) => setThresholdPct(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Max GPT calls (events)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="numeric"
            value={maxEvents}
            onChange={(e) => setMaxEvents(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">OpenAI model</span>
          <input
            className="vol-screener-input"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <div className="vol-screener-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Running…' : 'Run backtest'}
          </button>
        </div>
      </div>

      {error && (
        <p className="vol-screener-warn" role="alert">
          {error}
        </p>
      )}

      {data && !error && (
        <>
          <p className="vol-screener-meta">
            <strong>{data.symbol}</strong> · {data.candleCountFetched} candles · spike events ≥{' '}
            {data.thresholdPct}%: <strong>{data.greenEventsFound}</strong> · evaluated:{' '}
            <strong>{data.eventsEvaluated}</strong>
            {data.eventsRemaining > 0
              ? ` · not run (cap): ${data.eventsRemaining}`
              : ''}
            {data.outcomeEvaluated != null && data.outcomeEvaluated > 0
              ? ` · outcome: ${data.outcomeHits ?? 0}/${data.outcomeEvaluated}`
              : data.directionEvaluated != null && data.directionEvaluated > 0
                ? ` · outcome: ${data.directionHits ?? 0}/${data.directionEvaluated}`
                : (() => {
                    const rows = data.results.filter(
                      (r) => r.outcome?.predicted != null || r.direction?.predicted != null,
                    )
                    const hits = rows.filter(
                      (r) => (r.outcome ?? r.direction)?.match === true,
                    ).length
                    return rows.length > 0 ? ` · outcome: ${hits}/${rows.length}` : ''
                  })()}
            {data.results.length > 0
              ? (() => {
                  const total =
                    data.suggestedPnlTotalPct != null &&
                    Number.isFinite(data.suggestedPnlTotalPct)
                      ? data.suggestedPnlTotalPct
                      : sumSuggestedPnlPct(data.results)
                  const n =
                    data.suggestedPnlTradeCount != null
                      ? data.suggestedPnlTradeCount
                      : data.results.filter((r) => tradePnlPct(r) != null).length
                  return n > 0
                    ? ` · suggested trade PnL (sum): ${total.toFixed(3)}% over ${n} trade(s)`
                    : ''
                })()
              : ''}
            {data.results.length > 0
              ? (() => {
                  const n = data.results.filter((r) => nextBarBodyPctActual(r) != null).length
                  if (n === 0) return ''
                  const sum = sumNextBarBodyPctActual(data.results)
                  return ` · next hour realized body (sum): ${sum.toFixed(3)}% over ${n} bar(s)`
                })()
              : ''}
          </p>

          {data.results.length === 0 && (
            <p className="hourly-spikes-hint">
              No qualifying green candles in this range — lower the threshold or fetch more
              candles.
            </p>
          )}

          {data.results.length > 0 && (
            <div className="gpt-bt-pnl-section">
              <h2 className="hourly-spikes-h2">Next hour realized body %</h2>
              <p className="hourly-spikes-hint">
                Each bar is the <strong>actual</strong> % move of the candle after the spike (
                <code className="inline-code">i+1</code>): (close − open) / open. One bar per backtest
                event. Green above zero, red below. The meta line shows the sum of those % moves.
              </p>
              <GptPnlBarChart rows={data.results} />
            </div>
          )}

          {data.results.length > 0 && (
            <div className="table-wrap gpt-bt-table-wrap">
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>i / i+1</th>
                    <th>Target candle open</th>
                    <th>Spike body %</th>
                    <th>Act outcome</th>
                    <th>Pred outcome</th>
                    <th>OK</th>
                    <th className="cell-right">Target body % (i+1)</th>
                    <th className="cell-right">Trade PnL %</th>
                    <th>API</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, j) => {
                    const pnl = tradePnlPct(r)
                    return (
                    <tr key={`${r.targetOpenTime}-${j}`}>
                      <td className="cell-mono">
                        {r.spikeIndex ?? r.index} → {r.targetIndex ?? '—'}
                      </td>
                      <td className="cell-mono">{fmtTime(r.targetOpenTime ?? r.openTime)}</td>
                      <td className="cell-mono">
                        {r.spikeBodyPct != null
                          ? `${r.spikeBodyPct.toFixed(2)}%`
                          : r.bodyPctActual != null
                            ? `${r.bodyPctActual.toFixed(2)}%`
                            : '—'}
                      </td>
                      <td className="cell-mono">
                        {r.outcome?.actual ?? r.direction?.actual ?? '—'}
                      </td>
                      <td className="cell-mono">
                        {r.outcome?.predicted ?? r.direction?.predicted ?? '—'}
                      </td>
                      <td className="cell-mono">
                        {(r.outcome ?? r.direction)?.match === true
                          ? '✓'
                          : (r.outcome ?? r.direction)?.match === false
                            ? '✗'
                            : '—'}
                      </td>
                      <td className="cell-mono cell-right">
                        {r.targetBodyPctActual != null
                          ? `${r.targetBodyPctActual.toFixed(2)}%`
                          : '—'}
                      </td>
                      <td
                        className={`cell-mono cell-right${
                          pnl != null && pnl < 0 ? ' gpt-bt-pnl-cell-neg' : ''
                        }${pnl != null && pnl > 0 ? ' gpt-bt-pnl-cell-pos' : ''}`}
                      >
                        {pnl != null ? `${pnl.toFixed(3)}%` : '—'}
                      </td>
                      <td className="gpt-bt-err">
                        {r.error ? (
                          <span title={r.error}>
                            {r.error.length > 56 ? `${r.error.slice(0, 56)}…` : r.error}
                          </span>
                        ) : (
                          'ok'
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data.results.length > 0 && (
            <div className="table-wrap gpt-bt-table-wrap">
              <h2 className="hourly-spikes-h2">Actual OHLC on target candle (i+1)</h2>
              <p className="hourly-spikes-hint">
                For reference only; the model was not asked to predict these prices.
              </p>
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th className="cell-right">O</th>
                    <th className="cell-right">H</th>
                    <th className="cell-right">L</th>
                    <th className="cell-right">C</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, j) => (
                    <tr key={`d-${r.targetOpenTime ?? r.openTime}-${j}`}>
                      <td className="cell-mono">
                        {fmtTime(r.targetOpenTime ?? r.openTime)}
                      </td>
                      <td className="cell-mono cell-right">{fmt(r.actual.open)}</td>
                      <td className="cell-mono cell-right">{fmt(r.actual.high)}</td>
                      <td className="cell-mono cell-right">{fmt(r.actual.low)}</td>
                      <td className="cell-mono cell-right">{fmt(r.actual.close)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
