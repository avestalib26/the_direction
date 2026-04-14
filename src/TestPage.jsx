import { useState } from 'react'

async function placeTestOrder(payload) {
  const res = await fetch('/api/binance/test-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function runFiveMinSpikeScan(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue
    q.set(k, String(v))
  }
  const res = await fetch(`/api/binance/5m-screener?${q}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms.toFixed(0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function TestPage() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [side, setSide] = useState('BUY')
  const [tradeSizeUsd, setTradeSizeUsd] = useState('25')
  const [leverage, setLeverage] = useState('5')
  const [tpPct, setTpPct] = useState('1')
  const [slPct, setSlPct] = useState('1')
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [scanThresholdPct, setScanThresholdPct] = useState('3')
  const [scanMinQuoteVolume, setScanMinQuoteVolume] = useState('0')
  const [scanMaxSymbols, setScanMaxSymbols] = useState('800')
  const [scanSpikeMetric, setScanSpikeMetric] = useState('body')
  const [scanDirection, setScanDirection] = useState('both')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [scanResult, setScanResult] = useState(null)
  const [scanClientElapsedMs, setScanClientElapsedMs] = useState(null)

  const onPlace = async () => {
    setPlacing(true)
    setError('')
    setResult(null)
    try {
      const out = await placeTestOrder({
        symbol: symbol.trim(),
        side,
        tradeSizeUsd: Number.parseFloat(tradeSizeUsd),
        leverage: Number.parseInt(leverage, 10),
        tpPct: Number.parseFloat(tpPct),
        slPct: Number.parseFloat(slPct),
      })
      setResult(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to place order')
    } finally {
      setPlacing(false)
    }
  }

  const onRunSpikeScan = async () => {
    setScanning(true)
    setScanError('')
    setScanResult(null)
    setScanClientElapsedMs(null)
    const t0 = performance.now()
    try {
      const maxSym = Number.parseInt(scanMaxSymbols, 10)
      const scanParams = {
        candleCount: 1,
        interval: '5m',
        minQuoteVolume: Number.parseFloat(scanMinQuoteVolume),
        thresholdPct: Number.parseFloat(scanThresholdPct),
        spikeDirections: scanDirection,
        spikeMetric: scanSpikeMetric,
      }
      if (Number.isFinite(maxSym) && maxSym > 0) {
        scanParams.maxSymbols = maxSym
      }
      const out = await runFiveMinSpikeScan(scanParams)
      setScanResult(out)
      setScanClientElapsedMs(performance.now() - t0)
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Failed to run 5m scan')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="vol-screener">
      <h1 className="vol-screener-title">Test Page</h1>
      <p className="vol-screener-lead">
        Manual order test form. This will place a live Binance Futures market order plus TP/SL
        protection orders from your server API keys. Position notional is calculated as
        <strong> trade size × leverage</strong>.
      </p>
      <div className="backtest1-form">
        <label className="backtest1-field">
          <span className="backtest1-label">Coin name</span>
          <input
            className="backtest1-input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="BTCUSDT"
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Side</span>
          <select
            className="backtest1-input"
            value={side}
            onChange={(e) => setSide(e.target.value)}
          >
            <option value="BUY">BUY (Long)</option>
            <option value="SELL">SELL (Short)</option>
          </select>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Trade size (USDT margin)</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            step={0.1}
            value={tradeSizeUsd}
            onChange={(e) => setTradeSizeUsd(e.target.value)}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Leverage</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            max={125}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">TP %</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.01}
            step={0.01}
            value={tpPct}
            onChange={(e) => setTpPct(e.target.value)}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">SL %</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.01}
            step={0.01}
            value={slPct}
            onChange={(e) => setSlPct(e.target.value)}
          />
        </label>
        <button type="button" className="backtest1-btn" onClick={onPlace} disabled={placing}>
          {placing ? 'Placing order…' : 'Place Order'}
        </button>
      </div>
      {error ? (
        <p className="vol-screener-lead" role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      ) : null}
      {result ? (
        <pre className="code-block" style={{ marginTop: 12 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}

      <h2 className="vol-screener-title" style={{ marginTop: 24 }}>5m Universe Spike Scan</h2>
      <p className="vol-screener-lead">
        Scans the latest <strong>1 × 5m candle</strong> per symbol (high concurrency). Spikes use{' '}
        <strong>candle body</strong> % (<code className="inline-code">(close−open)/open</code>) by default,
        with optional 24h quote volume filter. Use max symbols to balance speed vs coverage.
      </p>
      <div className="backtest1-form">
        <label className="backtest1-field">
          <span className="backtest1-label">Spike threshold %</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.1}
            step={0.1}
            value={scanThresholdPct}
            onChange={(e) => setScanThresholdPct(e.target.value)}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Min 24h quote volume (USDT)</span>
          <input
            type="number"
            className="backtest1-input"
            min={0}
            step={100000}
            value={scanMinQuoteVolume}
            onChange={(e) => setScanMinQuoteVolume(e.target.value)}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max symbols (cap 800)</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            max={800}
            step={50}
            value={scanMaxSymbols}
            onChange={(e) => setScanMaxSymbols(e.target.value)}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Spike measure</span>
          <select
            className="backtest1-input"
            value={scanSpikeMetric}
            onChange={(e) => setScanSpikeMetric(e.target.value)}
          >
            <option value="body">Body % (open→close)</option>
            <option value="wick">Wick % (high/low vs open)</option>
          </select>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Direction</span>
          <select
            className="backtest1-input"
            value={scanDirection}
            onChange={(e) => setScanDirection(e.target.value)}
          >
            <option value="up">Up spikes</option>
            <option value="down">Down spikes</option>
            <option value="both">Both</option>
          </select>
        </label>
        <button type="button" className="backtest1-btn" onClick={onRunSpikeScan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Run 5m Scan'}
        </button>
      </div>

      {scanError ? (
        <p className="vol-screener-lead" role="alert" style={{ color: '#b91c1c' }}>
          {scanError}
        </p>
      ) : null}

      {scanResult ? (
        <>
          <div className="risk-summary" style={{ marginTop: 12 }}>
            <div className="risk-chip">
              Client elapsed: <strong>{fmtMs(scanClientElapsedMs)}</strong>
            </div>
            <div className="risk-chip">
              Server elapsed: <strong>{fmtMs(scanResult.elapsedMs)}</strong>
            </div>
            <div className="risk-chip">
              Symbols processed: <strong>{scanResult.symbolCount ?? 0}</strong> / {scanResult.requestedSymbols ?? 0}
            </div>
            <div className="risk-chip">
              Spikes found: <strong>{scanResult.spikeEventsChronological?.length ?? 0}</strong>
            </div>
            <div className="risk-chip">
              Skipped: <strong>{scanResult.skipped ?? 0}</strong>
            </div>
          </div>

          {(scanResult.spikeEventsChronological?.length ?? 0) > 0 ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Open time (UTC)</th>
                    <th>Symbol</th>
                    <th>Direction</th>
                    <th>Spike %</th>
                  </tr>
                </thead>
                <tbody>
                  {[...scanResult.spikeEventsChronological]
                    .sort((a, b) => Math.abs(b.spikePct) - Math.abs(a.spikePct))
                    .map((ev, idx) => (
                      <tr key={`${ev.openTime}-${ev.symbol}-${ev.direction}-${idx}`}>
                        <td className="cell-mono">{new Date(ev.openTime).toISOString()}</td>
                        <td className="cell-mono">{ev.symbol}</td>
                        <td>{ev.direction}</td>
                        <td className="cell-mono">
                          {Number.isFinite(ev.spikePct) ? `${ev.spikePct.toFixed(3)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="vol-screener-lead" style={{ marginTop: 12 }}>
              No spikes found above threshold for the latest 5m candle.
            </p>
          )}

          <details style={{ marginTop: 12 }}>
            <summary>Raw scan JSON</summary>
            <pre className="code-block" style={{ marginTop: 8 }}>
              {JSON.stringify(scanResult, null, 2)}
            </pre>
          </details>
        </>
      ) : null}
    </div>
  )
}
