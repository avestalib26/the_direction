import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
} from 'lightweight-charts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function chartLayout(isDark) {
  const bg = isDark ? '#1e2329' : '#ffffff'
  const text = isDark ? '#b7bdc6' : '#474d57'
  const grid = isDark ? '#2b3139' : '#eaecef'
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
      borderColor: grid,
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor: grid,
      timeVisible: true,
      secondsVisible: false,
    },
  }
}

function assignUniqueTimes(rows) {
  const used = new Set()
  return rows.map((r) => {
    let t = Math.floor(r.openTime / 1000)
    while (used.has(t)) t += 1
    used.add(t)
    return { ...r, chartTime: t }
  })
}

async function fetchRegimeBreadth(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) q.set(k, String(v))
  }
  const res = await fetch(`/api/binance/market-regime-breadth?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export function RegimeBreadthPanel() {
  const [minQuoteVolume, setMinQuoteVolume] = useState(2_000_000)
  const [maxSymbols, setMaxSymbols] = useState(150)
  const [dailyLimit, setDailyLimit] = useState(400)
  const [minHistoryDays, setMinHistoryDays] = useState(90)
  const [zWindow, setZWindow] = useState(20)
  const [k, setK] = useState(5)
  const [regimeThreshold, setRegimeThreshold] = useState(0.75)
  const [portfolioVersion, setPortfolioVersion] = useState('a')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchRegimeBreadth({
        minQuoteVolume,
        maxSymbols,
        dailyLimit,
        minHistoryDays,
        zWindow,
        k,
        regimeThreshold,
      })
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [
    minQuoteVolume,
    maxSymbols,
    dailyLimit,
    minHistoryDays,
    zWindow,
    k,
    regimeThreshold,
  ])

  const history = useMemo(
    () => (Array.isArray(data?.history) ? data.history : []),
    [data],
  )

  const refR = useRef(null)
  const refB = useRef(null)
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
    if (!history.length) return

    const enriched = assignUniqueTimes(
      [...history].sort((a, b) => a.openTime - b.openTime),
    )
    const layout = chartLayout(dark)
    const charts = []

    const cleanup = () => {
      for (const c of charts) c.remove()
    }

    if (refR.current) {
      const ch = createChart(refR.current, { ...layout, autoSize: true })
      charts.push(ch)
      const line = ch.addSeries(LineSeries, {
        color: '#2962ff',
        lineWidth: 2,
        title: 'RegimeScore',
      })
      line.setData(
        enriched
          .map((r) => ({
            time: r.chartTime,
            value: r.regimeScore,
          }))
          .filter((x) => Number.isFinite(x.value)),
      )
      ch.timeScale().fitContent()
    }

    if (refB.current) {
      const ch = createChart(refB.current, { ...layout, autoSize: true })
      charts.push(ch)
      const b2 = ch.addSeries(LineSeries, {
        color: '#0ecb81',
        lineWidth: 1.5,
        title: 'B2 % green',
      })
      const b3 = ch.addSeries(LineSeries, {
        color: '#f0b90b',
        lineWidth: 1.5,
        title: 'B3 % > MA20',
      })
      b2.setData(
        enriched
          .map((r) => ({
            time: r.chartTime,
            value: r.B2 != null ? r.B2 * 100 : NaN,
          }))
          .filter((x) => Number.isFinite(x.value)),
      )
      b3.setData(
        enriched
          .map((r) => ({
            time: r.chartTime,
            value: r.B3 != null ? r.B3 * 100 : NaN,
          }))
          .filter((x) => Number.isFinite(x.value)),
      )
      ch.timeScale().fitContent()
    }

    return cleanup
  }, [history, dark])

  const latest = data?.latest

  return (
    <section className="regime-breadth" aria-label="Daily regime framework">
      <h2 className="breadth-detail-title">Daily regime &amp; cross-sectional framework</h2>
      <p className="regime-breadth-intro">
        Rule-based breadth: <strong>B1</strong> median 1d % return,{' '}
        <strong>B2</strong> fraction green, <strong>B3</strong> fraction above
        MA20, <strong>B4</strong> fraction down &gt;3%.{' '}
        <strong>R</strong> = 0.4·Z(B1) + 0.3·Z(B2) + 0.3·Z(B3) with a{' '}
        {zWindow}-day z-score window. Bull if R &gt; threshold and MA3(R) −
        MA10(R) &gt; 0; bear if R &lt; −threshold and slope &lt; 0. Momentum
        uses 20d return; weights ∝ 1/vol20, capped per name. Signals align with
        the starter system in your spec (neutral = flat in version A).
      </p>

      <div className="breadth-controls regime-breadth-controls">
        <label className="field">
          <span className="field-label">Min 24h vol (USDT)</span>
          <input
            type="number"
            className="field-input"
            value={minQuoteVolume}
            min={0}
            step={100000}
            onChange={(e) => setMinQuoteVolume(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">Max symbols</span>
          <input
            type="number"
            className="field-input"
            value={maxSymbols}
            min={20}
            max={400}
            onChange={(e) => setMaxSymbols(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">Daily bars</span>
          <input
            type="number"
            className="field-input"
            value={dailyLimit}
            min={120}
            max={1500}
            onChange={(e) => setDailyLimit(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">Min history (days)</span>
          <input
            type="number"
            className="field-input"
            value={minHistoryDays}
            min={30}
            onChange={(e) => setMinHistoryDays(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">Z window</span>
          <input
            type="number"
            className="field-input"
            value={zWindow}
            min={10}
            max={60}
            onChange={(e) => setZWindow(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">K (top/bottom)</span>
          <input
            type="number"
            className="field-input"
            value={k}
            min={1}
            max={20}
            onChange={(e) => setK(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">Regime |R| &gt;</span>
          <input
            type="number"
            className="field-input"
            value={regimeThreshold}
            min={0.3}
            max={2}
            step={0.05}
            onChange={(e) => setRegimeThreshold(Number(e.target.value))}
            disabled={loading}
          />
        </label>
        <label className="field">
          <span className="field-label">Portfolio view</span>
          <select
            className="field-input"
            value={portfolioVersion}
            onChange={(e) => setPortfolioVersion(e.target.value)}
          >
            <option value="a">A — directional (bull longs / bear shorts)</option>
            <option value="b">B — hedged (optional 25% contra sleeve)</option>
          </select>
        </label>
        <button
          type="button"
          className="btn-refresh breadth-run"
          onClick={run}
          disabled={loading}
        >
          {loading ? 'Computing…' : 'Run regime breadth'}
        </button>
      </div>

      {loading && (
        <p className="breadth-loading" role="status">
          Fetching daily klines for the liquid universe — can take up to a minute.
        </p>
      )}

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Regime breadth failed</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {latest && (
        <>
          <p className="positions-meta breadth-charts-meta">
            Updated {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : '—'}{' '}
            · Universe <strong>{data.universe?.used}</strong> symbols (min{' '}
            {fmtNum(data.params?.minQuoteVolume)} USDT 24h)
          </p>

          <div className="regime-breadth-cards">
            <div className="insight-card insight-card--hero">
              <span className="insight-label">Regime (latest daily close)</span>
              <span
                className={`insight-value regime-tag regime-tag--${latest.regime ?? 'neutral'}`}
              >
                {(latest.regime ?? '—').toUpperCase()}
              </span>
              <span className="insight-sub">
                R={fmtFixed(latest.regimeScore)} · slope={fmtFixed(latest.slope)}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">B1 median % · B2 green · B3 &gt;MA20 · B4 &lt;−3%</span>
              <span className="insight-mono insight-lg">
                {fmtFixed(latest.B1)} · {fmtPctRatio(latest.B2)} ·{' '}
                {fmtPctRatio(latest.B3)} · {fmtPctRatio(latest.B4)}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Washout · Rebound</span>
              <span className="insight-mono">
                <span className={latest.washout ? 'pnl-neg' : ''}>
                  {latest.washout ? 'Washout conditions' : 'No'}
                </span>
                {' · '}
                <span className={latest.rebound ? 'pnl-pos' : ''}>
                  {latest.rebound ? 'Rebound trigger' : 'No'}
                </span>
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Divergence (heuristic)</span>
              <span className="insight-mono">
                Bull: {latest.bullishDivergence ? 'yes' : 'no'} · Bear:{' '}
                {latest.bearishDivergence ? 'yes' : 'no'}
              </span>
            </div>
            {latest.rules?.exits && (
              <div className="insight-card insight-card--wide">
                <span className="insight-label">Exit rules (starter system)</span>
                <span className="insight-sub">{latest.rules.exits}</span>
              </div>
            )}
          </div>

          <div className="breadth-lwc-pane regime-lwc-row">
            <figure className="breadth-chart-figure">
              <figcaption className="breadth-chart-title">Regime score (R)</figcaption>
              <div ref={refR} className="breadth-lwc-chart regime-lwc-chart" />
            </figure>
            <figure className="breadth-chart-figure">
              <figcaption className="breadth-chart-title">
                Participation B2 &amp; B3 (%)
              </figcaption>
              <div ref={refB} className="breadth-lwc-chart regime-lwc-chart" />
            </figure>
          </div>

          <div className="regime-picks-grid">
            <div>
              <h3 className="breadth-movers-title">
                Long sleeve (bull regime, top {k} by MOM20)
              </h3>
              {latest.regime === 'bull' && latest.longPicks?.length > 0 ? (
                <ul className="breadth-movers-list">
                  {latest.longPicks.map((p) => (
                    <li key={p.symbol}>
                      <span className="cell-mono">{p.symbol}</span>{' '}
                      <span className="pnl-pos">
                        w={((p.weight ?? 0) * 100).toFixed(1)}%
                      </span>{' '}
                      <span className="insight-sub">
                        MOM20 {(p.mom20 * 100).toFixed(2)}%
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="insight-sub">
                  {latest.regime === 'bull'
                    ? 'No picks (data).'
                    : 'Only in bull regime (version A: longs only).'}
                </p>
              )}
            </div>
            <div>
              <h3 className="breadth-movers-title">
                Short sleeve (bear regime, bottom {k} by MOM20)
              </h3>
              {latest.regime === 'bear' && latest.shortPicks?.length > 0 ? (
                <ul className="breadth-movers-list">
                  {latest.shortPicks.map((p) => (
                    <li key={p.symbol}>
                      <span className="cell-mono">{p.symbol}</span>{' '}
                      <span className="pnl-neg">
                        w={((p.weight ?? 0) * 100).toFixed(1)}%
                      </span>{' '}
                      <span className="insight-sub">
                        MOM20 {(p.mom20 * 100).toFixed(2)}%
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="insight-sub">
                  {latest.regime === 'bear'
                    ? 'No picks (data).'
                    : 'Only in bear regime (version A: shorts only).'}
                </p>
              )}
            </div>
          </div>

          {portfolioVersion === 'b' && (
            <div className="regime-hedge-note">
              <h3 className="breadth-movers-title">Version B — optional hedge sleeve (~25%)</h3>
              <p className="breadth-insights-hint">
                In bull: consider shorting weakest 3 as hedge; in bear: longing
                strongest 3. Sizes below are the same vol-inverse normalization as
                main sleeves — scale down to ~25% of book if you use them.
              </p>
              <div className="regime-picks-grid">
                <ul className="breadth-movers-list">
                  {(latest.versionB?.hedgeLongPct25 ?? []).map((p) => (
                    <li key={p.symbol}>
                      <span className="cell-mono">{p.symbol}</span> hedge short{' '}
                      w≈{((p.weight ?? 0) * 100).toFixed(1)}%
                    </li>
                  ))}
                </ul>
                <ul className="breadth-movers-list">
                  {(latest.versionB?.hedgeShortPct25 ?? []).map((p) => (
                    <li key={p.symbol}>
                      <span className="cell-mono">{p.symbol}</span> hedge long{' '}
                      w≈{((p.weight ?? 0) * 100).toFixed(1)}%
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <details className="breadth-details regime-details">
            <summary className="breadth-details-summary">
              Washout / rebound / staged adds / bounded averaging
            </summary>
            <div className="breadth-insights">
              <p className="breadth-insights-hint">
                <strong>Washout</strong> (all required): R &lt; −2, B2 &lt; 0.25,
                B4 &gt; 0.20, BTC below 10d MA.{' '}
                <strong>Rebound</strong>: R up ≥0.75 from 20d low, B2 &gt; 0.50,
                BTC above 5d MA, top 10 by 5d momentum all positive. Trade
                rebound as smaller, time-boxed longs (e.g. top 3–5, half size,
                3–7 sessions).
              </p>
              <p className="breadth-insights-hint">
                <strong>Staged entry</strong> (example): 40% on first rebound
                trigger, 30% if breadth stays positive next day, 30% on BTC
                follow-through — not martingale; max three adds, each ≤ prior,
                only in recovery context.
              </p>
              <p className="breadth-insights-hint">
                <strong>Bounded averaging</strong>: add only in washout recovery,
                not in confirmed bear trend; ≤3 entries; sizes 1 → 0.75 → 0.5
                units; never unlimited averaging or averaging in deteriorating
                breadth.
              </p>
              <p className="breadth-insights-hint">
                <strong>Divergence</strong> here is a coarse 30d heuristic (BTC
                vs R and participation). Use for context; confirm on your
                charts.
              </p>
            </div>
          </details>

          {data.simulation?.equityCurve?.length > 0 && (
            <div className="regime-sim">
              <h3 className="breadth-movers-title">Simplified daily sim (after warmup)</h3>
              <p className="breadth-insights-hint">{data.simulation.note}</p>
              <p className="insight-mono">
                Final equity (normalized 1.0 start):{' '}
                <strong>{data.simulation.finalEquity?.toFixed(4) ?? '—'}</strong>
              </p>
            </div>
          )}

          {data.rankUniverse?.length > 0 && (
            <div className="table-wrap">
              <h3 className="breadth-movers-title">MOM20 ranking (snapshot)</h3>
              <table className="positions-table zebra">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>MOM20 %</th>
                    <th>Vol20 (daily %)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rankUniverse.map((row) => (
                    <tr key={row.symbol}>
                      <td className="cell-mono">{row.symbol}</td>
                      <td className="cell-mono">
                        {(row.mom20 * 100).toFixed(2)}
                      </td>
                      <td className="cell-mono">
                        {row.vol20 != null ? row.vol20.toFixed(3) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function fmtFixed(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  return x.toFixed(3)
}

function fmtPctRatio(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  return `${(x * 100).toFixed(1)}%`
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString()
}
