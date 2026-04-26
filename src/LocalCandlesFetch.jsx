import { useCallback, useEffect, useState } from 'react'

function fmtBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 ** 3) return `${(v / (1024 * 1024)).toFixed(1)} MB`
  return `${(v / 1024 ** 3).toFixed(2)} GB`
}

export function LocalCandlesFetch() {
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState(null)
  const [log, setLog] = useState([])
  const [running, setRunning] = useState(false)
  /** @type {'5m' | '15m' | null} */
  const [runningPhase, setRunningPhase] = useState(null)
  const [runError, setRunError] = useState(null)
  const [concurrency, setConcurrency] = useState('2')

  const fetchStatusJson = useCallback(async () => {
    const r = await fetch('/api/local-candles/status')
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    return j
  }, [])

  const refreshStatus = useCallback(async () => {
    setStatusError(null)
    try {
      const j = await fetchStatusJson()
      setStatus(j)
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'Status failed')
    }
  }, [fetchStatusJson])

  useEffect(() => {
    let cancelled = false
    fetchStatusJson()
      .then((j) => {
        if (!cancelled) {
          setStatus(j)
          setStatusError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setStatusError(e instanceof Error ? e.message : 'Status failed')
      })
    return () => {
      cancelled = true
    }
  }, [fetchStatusJson])

  const startSync = useCallback(
    (phase) => {
      if (running) return
      setRunning(true)
      setRunningPhase(phase)
      setRunError(null)
      setLog([])
      const q = new URLSearchParams()
      q.set('concurrency', String(concurrency).trim() || '2')
      q.set('interval', phase)
      const es = new EventSource(`/api/local-candles/sync/stream?${q}`)
      es.onmessage = (ev) => {
        try {
          const j = JSON.parse(ev.data)
          setLog((prev) => {
            const next = [...prev, j]
            return next.length > 800 ? next.slice(-800) : next
          })
          if (j.event === 'done') {
            es.close()
            setRunning(false)
            setRunningPhase(null)
            refreshStatus().catch(() => {})
          }
          if (j.event === 'error') {
            setRunError(j.message || 'Sync error')
            es.close()
            setRunning(false)
            setRunningPhase(null)
            refreshStatus().catch(() => {})
          }
        } catch {
          /* ignore */
        }
      }
      es.onerror = () => {
        es.close()
        setRunning(false)
        setRunningPhase(null)
        refreshStatus().catch(() => {})
      }
    },
    [running, concurrency, refreshStatus],
  )

  return (
    <div className="vol-screener spike-tpsl-bt">
      <h1 className="vol-screener-title">Local candle cache</h1>
      <p className="vol-screener-lead">
        Downloads up to <strong>10,000</strong> most recent USDT-M perpetual candles per symbol (all tradable pairs).
        Run <strong>5m</strong> first, then <strong>15m</strong>, to split load across two phases. Symbols with shorter
        history store whatever Binance returns. New files:{' '}
        <code>binance_usdm/5m/&lt;SYMBOL&gt;.json</code> and <code>binance_usdm/15m/&lt;SYMBOL&gt;.json</code> (one folder
        per timeframe). Older <code>binance_usdm/&lt;SYMBOL&gt;/5m.json</code> layout is still read by backtests; re-fetch
        5m if you want everything under <code>5m/</code>. Full OHLCV: <code>volume</code>, <code>quoteVolume</code>, trades,
        taker volumes.
      </p>
      <p className="hourly-spikes-hint">
        For quick / long-short backtests to read this cache instead of Binance, set{' '}
        <code>SPIKE_TPSL_USE_LOCAL_CANDLES=true</code> in <code>.env</code> (still uses live 24h universe unless you
        change that). Optional: <code>LOCAL_CANDLE_DIR</code> to override the folder (default{' '}
        <code>data/local-candles</code>).
      </p>

      <div className="backtest1-form" style={{ maxWidth: 520, marginBottom: '1.25rem' }}>
        <label className="backtest1-field">
          <span className="backtest1-label">Parallel symbols (1–8)</span>
          <input
            className="backtest1-input"
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            disabled={running}
            inputMode="numeric"
          />
        </label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            className="backtest1-btn"
            onClick={() => startSync('5m')}
            disabled={running}
          >
            {running && runningPhase === '5m' ? 'Syncing 5m…' : 'Fetch 5m — all symbols'}
          </button>
          <button
            type="button"
            className="backtest1-btn"
            onClick={() => startSync('15m')}
            disabled={running}
          >
            {running && runningPhase === '15m' ? 'Syncing 15m…' : 'Fetch 15m — all symbols'}
          </button>
          <button type="button" className="backtest1-btn" style={{ opacity: 0.9 }} onClick={() => refreshStatus()}>
            Refresh status
          </button>
        </div>
      </div>

      {statusError ? (
        <p className="hourly-spikes-hint" style={{ color: 'var(--danger, #f6465d)' }} role="alert">
          {statusError}
        </p>
      ) : null}
      {runError ? (
        <p className="hourly-spikes-hint" style={{ color: 'var(--danger, #f6465d)' }} role="alert">
          {runError}
        </p>
      ) : null}

      {status ? (
        <section className="hourly-spikes-section">
          <h2 className="hourly-spikes-h2">Disk status</h2>
          <div className="backtest1-summary-grid" style={{ marginBottom: '0.75rem' }}>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Root</span>
              <span className="backtest1-stat-value" style={{ fontSize: 12 }}>
                {status.root}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">5m/ *.json (new layout)</span>
              <span className="backtest1-stat-value">{(status.files5m ?? 0).toLocaleString()}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">15m/ *.json (new layout)</span>
              <span className="backtest1-stat-value">{(status.files15m ?? 0).toLocaleString()}</span>
            </div>
            {(status.legacySymbolDirs ?? 0) > 0 ? (
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Legacy per-symbol dirs</span>
                <span className="backtest1-stat-value">
                  {(status.legacySymbolDirs ?? 0).toLocaleString()} · 5m{' '}
                  {(status.legacyFiles5m ?? 0).toLocaleString()} · 15m{' '}
                  {(status.legacyFiles15m ?? 0).toLocaleString()}
                </span>
              </div>
            ) : null}
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Approx. JSON size</span>
              <span className="backtest1-stat-value">{fmtBytes(status.totalBytes)}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Backtest uses local cache</span>
              <span className="backtest1-stat-value">{status.useLocalInBacktest ? 'yes' : 'no'}</span>
            </div>
          </div>
        </section>
      ) : null}

      <section className="hourly-spikes-section">
        <h2 className="hourly-spikes-h2">Progress log</h2>
        <pre
          className="hourly-spikes-hint"
          style={{
            maxHeight: 360,
            overflow: 'auto',
            fontSize: 11,
            lineHeight: 1.45,
            margin: 0,
            padding: '10px 12px',
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 8,
            whiteSpace: 'pre-wrap',
          }}
        >
          {log.length === 0
            ? running
              ? `Starting ${runningPhase ?? ''}…`.trim()
              : '—'
            : log.map((row) => JSON.stringify(row)).join('\n')}
        </pre>
      </section>
    </div>
  )
}
