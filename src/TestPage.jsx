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
    </div>
  )
}
