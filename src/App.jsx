import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { MarketBreadth } from './MarketBreadth'
import { Backtest1 } from './Backtest1'
import { The100k } from './The100k'
import { TradeHistory } from './TradeHistory'
import './App.css'

async function fetchOpenPositions() {
  const res = await fetch('/api/binance/open-positions')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function App() {
  const [view, setView] = useState('home')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const [positions, setPositions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadPositions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchOpenPositions()
      setPositions(data.positions ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load positions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (view !== 'home') return
    loadPositions()
  }, [view, loadPositions])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [menuOpen])

  const go = (next) => {
    setView(next)
    setMenuOpen(false)
  }

  const totalOpenPnl = useMemo(() => {
    if (!positions?.length) return null
    let s = 0
    for (const p of positions) {
      const n = parseFloat(p.unRealizedProfit)
      if (Number.isFinite(n)) s += n
    }
    return s
  }, [positions])

  return (
    <div className="layout">
      <header className="top-bar">
        <button
          type="button"
          className="hamburger"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="hamburger-line" aria-hidden />
          <span className="hamburger-line" aria-hidden />
          <span className="hamburger-line" aria-hidden />
        </button>
      </header>

      {menuOpen && (
        <button
          type="button"
          className="menu-backdrop"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <nav
        id={menuId}
        className={`menu-panel ${menuOpen ? 'menu-panel--open' : ''}`}
        aria-hidden={!menuOpen}
        inert={!menuOpen}
      >
        <ul className="menu-list">
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'home' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('home')
              }}
            >
              Home
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'the100k' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('the100k')
              }}
            >
              The 100k
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'breadth' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('breadth')
              }}
            >
              Market breadth
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'history' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('history')
              }}
            >
              Trade history
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'backtest1' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('backtest1')
              }}
            >
              Backtest 1
            </a>
          </li>
        </ul>
      </nav>

      <main
        className={`app ${view === 'breadth' || view === 'history' || view === 'the100k' || view === 'backtest1' ? 'app--breadth' : ''}`}
        id="main"
      >
        {view === 'home' && (
          <>
            <div className="home-toolbar">
              <button
                type="button"
                className="btn-refresh"
                onClick={loadPositions}
                disabled={loading}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            <section className="positions-section" aria-live="polite">
              {loading && positions === null && (
                <p className="positions-status">Loading positions…</p>
              )}
              {error && (
                <div className="positions-error" role="alert">
                  <p className="positions-error-title">
                    Could not load positions
                  </p>
                  <p className="positions-error-msg">{error}</p>
                </div>
              )}
              {!error && !loading && positions && positions.length === 0 && (
                <p className="positions-empty">No open positions.</p>
              )}
              {!error && positions && positions.length > 0 && (
                <>
                  <p
                    className={`positions-total-pnl cell-mono cell-pnl ${pnlClass(
                      totalOpenPnl,
                    )}`}
                  >
                    Total open PnL{' '}
                    <span className="positions-total-pnl-value">
                      {totalOpenPnl != null
                        ? formatUsdt(totalOpenPnl)
                        : '—'}
                    </span>
                  </p>
                  <div className="table-wrap">
                    <table className="positions-table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Side</th>
                          <th>Size</th>
                          <th>Entry</th>
                          <th>Mark</th>
                          <th>Unrealized PnL</th>
                          <th>Lev.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((p) => (
                          <tr
                            key={`${p.symbol}-${p.positionSide || 'default'}`}
                          >
                            <td className="cell-mono">{p.symbol}</td>
                            <td>{p.positionSide || '—'}</td>
                            <td className="cell-mono">{p.positionAmt}</td>
                            <td className="cell-mono">{p.entryPrice}</td>
                            <td className="cell-mono">{p.markPrice}</td>
                            <td
                              className={`cell-mono cell-pnl ${pnlClass(
                                p.unRealizedProfit,
                              )}`}
                            >
                              {p.unRealizedProfit}
                            </td>
                            <td className="cell-mono">{p.leverage}x</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </>
        )}

        {view === 'the100k' && <The100k />}
        {view === 'breadth' && <MarketBreadth />}
        {view === 'history' && <TradeHistory />}
        {view === 'backtest1' && <Backtest1 />}
      </main>
    </div>
  )
}

function pnlClass(value) {
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (Number.isNaN(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}

function formatUsdt(n) {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`
}

export default App
