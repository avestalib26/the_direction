import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { MarketBreadth } from './MarketBreadth'
import { Backtest1 } from './Backtest1'
import { Backtest2 } from './Backtest2'
import { VolumeScreener } from './VolumeScreener'
import { Backtest3 } from './Backtest3'
import { Backtest4 } from './Backtest4'
import { ZoneHedgeBacktest } from './ZoneHedgeBacktest'
import { HourlySpikesBacktest } from './HourlySpikesBacktest'
import { GptBacktest } from './GptBacktest'
import { SpikeFilter } from './SpikeFilter'
import { SpikeTpSlBacktest } from './SpikeTpSlBacktest'
import { SpikeTpSlBacktestV2 } from './SpikeTpSlBacktestV2'
import { SpikeTpSlBacktestV3 } from './SpikeTpSlBacktestV3'
import { FiveMinScreener } from './FiveMinScreener'
import { The100k } from './The100k'
import { TradeHistory } from './TradeHistory'
import { Emotions } from './Emotions'
import { EmotionsErrorBoundary } from './EmotionsErrorBoundary'
import { HFT } from './HFT'
import { MlDatasetPrep } from './MlDatasetPrep'
import './App.css'

async function fetchOpenPositions() {
  const res = await fetch('/api/binance/open-positions')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchFuturesWallet() {
  const res = await fetch('/api/binance/futures-wallet')
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
  const [walletBalance, setWalletBalance] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [maxTradeSizePct, setMaxTradeSizePct] = useState('4')
  const [maxNegPnlPct, setMaxNegPnlPct] = useState('500')
  const [maxOpenPositions, setMaxOpenPositions] = useState('10')
  const [maxTotalPositionSize, setMaxTotalPositionSize] = useState('0')
  const loadPositions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [data, wallet] = await Promise.all([
        fetchOpenPositions(),
        fetchFuturesWallet().catch(() => null),
      ])
      setPositions(data.positions ?? [])
      const wb = parseFloat(wallet?.totalWalletBalance)
      setWalletBalance(Number.isFinite(wb) ? wb : null)
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

  const BACKTEST_VIEWS = [
    'backtest1',
    'backtest2',
    'backtest3',
    'backtest4',
    'zonehedge',
    'hourlyspikes',
    'gptbacktest',
    'spikefilter',
    'spiketpsl',
    'spiketpslv2',
    'spiketpslv3',
  ]
  const isBacktestView = BACKTEST_VIEWS.includes(view)
  const [backtestMenuOpen, setBacktestMenuOpen] = useState(isBacktestView)

  useEffect(() => {
    if (isBacktestView) setBacktestMenuOpen(true)
  }, [view, isBacktestView])

  const totalOpenPnl = useMemo(() => {
    if (!positions?.length) return null
    let s = 0
    for (const p of positions) {
      const n = parseFloat(p.unRealizedProfit)
      if (Number.isFinite(n)) s += n
    }
    return s
  }, [positions])

  const risk = useMemo(() => {
    const tradePct = Number.parseFloat(String(maxTradeSizePct))
    const negPnlPct = Number.parseFloat(String(maxNegPnlPct))
    const openMax = Number.parseInt(String(maxOpenPositions), 10)
    const totalMax = Number.parseFloat(String(maxTotalPositionSize))

    const tradePctSafe = Number.isFinite(tradePct) && tradePct > 0 ? tradePct : 0
    const negPnlPctSafe = Number.isFinite(negPnlPct) && negPnlPct > 0 ? negPnlPct : 0
    const openMaxSafe = Number.isFinite(openMax) && openMax >= 0 ? openMax : 0
    const totalMaxSafe = Number.isFinite(totalMax) && totalMax > 0 ? totalMax : 0

    const maxTradeUsd =
      Number.isFinite(walletBalance) && tradePctSafe > 0
        ? walletBalance * (tradePctSafe / 100)
        : null

    let totalPositionUsd = 0
    let largestPositionUsd = 0
    for (const p of positions ?? []) {
      const sz = absPositionSizeUsd(p)
      if (!Number.isFinite(sz)) continue
      totalPositionUsd += sz
      if (sz > largestPositionUsd) largestPositionUsd = sz
    }

    const posCount = positions?.length ?? 0
    return {
      tradePct: tradePctSafe,
      negPnlPct: negPnlPctSafe,
      openMax: openMaxSafe,
      totalMax: totalMaxSafe,
      maxTradeUsd,
      totalPositionUsd,
      largestPositionUsd,
      posCount,
      openBreach: openMaxSafe > 0 && posCount > openMaxSafe,
      totalSizeBreach: totalMaxSafe > 0 && totalPositionUsd > totalMaxSafe,
      largestTradeBreach:
        Number.isFinite(maxTradeUsd) && largestPositionUsd > maxTradeUsd,
    }
  }, [
    maxTradeSizePct,
    maxNegPnlPct,
    maxOpenPositions,
    maxTotalPositionSize,
    positions,
    walletBalance,
  ])

  /** Highest unrealized PnL first (then symbol for ties). */
  const positionsByUnrealized = useMemo(() => {
    if (!positions?.length) return []
    return [...positions].sort((a, b) => {
      const na = parseFloat(a.unRealizedProfit)
      const nb = parseFloat(b.unRealizedProfit)
      const va = Number.isFinite(na) ? na : 0
      const vb = Number.isFinite(nb) ? nb : 0
      if (vb !== va) return vb - va
      return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
    })
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
              className={`menu-link ${view === 'emotions' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('emotions')
              }}
            >
              Emotions
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'mldataset' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('mldataset')
              }}
            >
              ML dataset
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'volume' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('volume')
              }}
            >
              24h volume
            </a>
          </li>
          <li className="menu-item--submenu">
            <details
              className="menu-details"
              open={backtestMenuOpen}
              onToggle={(e) => setBacktestMenuOpen(e.currentTarget.open)}
            >
              <summary
                className={`menu-details-summary ${isBacktestView ? 'menu-details-summary--active' : ''}`}
              >
                Backtest
              </summary>
              <ul className="menu-sublist">
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'backtest1' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('backtest1')
                    }}
                  >
                    Backtest 1
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'backtest2' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('backtest2')
                    }}
                  >
                    Backtest 2
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'backtest3' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('backtest3')
                    }}
                  >
                    Backtest 3
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'backtest4' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('backtest4')
                    }}
                  >
                    Backtest 4
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'zonehedge' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('zonehedge')
                    }}
                  >
                    Zone hedge BT
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'hourlyspikes' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('hourlyspikes')
                    }}
                  >
                    Hourly spikes
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'gptbacktest' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('gptbacktest')
                    }}
                  >
                    GPT backtest
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'spikefilter' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('spikefilter')
                    }}
                  >
                    Spike filter
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'spiketpsl' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('spiketpsl')
                    }}
                  >
                    Spike 2R backtest
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'spiketpslv2' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('spiketpslv2')
                    }}
                  >
                    2R backtest v2
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'spiketpslv3' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('spiketpslv3')
                    }}
                  >
                    2R backtest v3
                  </a>
                </li>
              </ul>
            </details>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'hft' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('hft')
              }}
            >
              HFT
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === '5minscreener' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('5minscreener')
              }}
            >
              5min screener
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === '5minscreener-bi' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('5minscreener-bi')
              }}
            >
              5m screener (± wicks)
            </a>
          </li>
        </ul>
      </nav>

      <main
        className={`app ${view === 'breadth' || view === 'history' || view === 'emotions' || view === 'mldataset' || view === 'the100k' || view === 'backtest1' || view === 'backtest2' || view === 'backtest3' || view === 'backtest4' || view === 'zonehedge' || view === 'hourlyspikes' || view === 'gptbacktest' || view === 'spikefilter' || view === 'spiketpsl' || view === 'spiketpslv2' || view === 'spiketpslv3' || view === '5minscreener' || view === '5minscreener-bi' || view === 'volume' || view === 'hft' ? 'app--breadth' : ''}`}
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

            <section className="risk-panel" aria-label="Risk controls">
              <div className="risk-form">
                <label className="backtest1-field">
                  <span className="backtest1-label">Max trade size (% of account)</span>
                  <input
                    type="number"
                    className="backtest1-input backtest1-input--narrow"
                    min={0}
                    step={0.1}
                    value={maxTradeSizePct}
                    onChange={(e) => setMaxTradeSizePct(e.target.value)}
                  />
                </label>
                <label className="backtest1-field">
                  <span className="backtest1-label">Max negative PnL % (position)</span>
                  <input
                    type="number"
                    className="backtest1-input backtest1-input--narrow"
                    min={0}
                    step={1}
                    value={maxNegPnlPct}
                    onChange={(e) => setMaxNegPnlPct(e.target.value)}
                  />
                </label>
                <label className="backtest1-field">
                  <span className="backtest1-label">Max open positions</span>
                  <input
                    type="number"
                    className="backtest1-input backtest1-input--narrow"
                    min={0}
                    step={1}
                    value={maxOpenPositions}
                    onChange={(e) => setMaxOpenPositions(e.target.value)}
                  />
                </label>
                <label className="backtest1-field">
                  <span className="backtest1-label">Max total position size (USDT)</span>
                  <input
                    type="number"
                    className="backtest1-input"
                    min={0}
                    step={1}
                    value={maxTotalPositionSize}
                    onChange={(e) => setMaxTotalPositionSize(e.target.value)}
                  />
                </label>
              </div>
              <div className="risk-summary">
                <div className={`risk-chip ${risk.largestTradeBreach ? 'risk-chip--bad' : ''}`}>
                  Max trade allowed:{' '}
                  <strong>
                    {risk.maxTradeUsd != null ? formatUsdt(risk.maxTradeUsd) : '—'}
                  </strong>
                </div>
                <div className={`risk-chip ${risk.openBreach ? 'risk-chip--bad' : ''}`}>
                  Open positions: <strong>{risk.posCount}</strong> / {risk.openMax}
                </div>
                <div className={`risk-chip ${risk.totalSizeBreach ? 'risk-chip--bad' : ''}`}>
                  Total size: <strong>{formatUsdt(risk.totalPositionUsd)}</strong>
                  {risk.totalMax > 0 ? ` / ${formatUsdt(risk.totalMax)}` : ' / no cap'}
                </div>
                {Number.isFinite(walletBalance) && (
                  <div className="risk-chip">
                    Account size (USDT): <strong>{formatUsdt(walletBalance)}</strong>
                  </div>
                )}
              </div>
            </section>

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
                    )} ${isPnlBreach(totalOpenPnl, walletBalance, risk.negPnlPct) ? 'risk-breach' : ''}`}
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
                          <th>Pos size (USDT)</th>
                          <th>Unrealized PnL</th>
                          <th
                            title="(Unrealized PnL ÷ (|size| × entry)) × leverage — approx. return on margin when margin ≈ notional ÷ leverage (isolated-style)"
                          >
                            % PnL
                          </th>
                          <th>Lev.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positionsByUnrealized.map((p) => (
                          <tr
                            key={`${p.symbol}-${p.positionSide || 'default'}`}
                            className={
                              isPositionRiskBreach(p, risk.maxTradeUsd, risk.negPnlPct)
                                ? 'positions-row--risk'
                                : ''
                            }
                          >
                            <td className="cell-mono">{p.symbol}</td>
                            <td>{p.positionSide || '—'}</td>
                            <td className="cell-mono">{p.positionAmt}</td>
                            <td className="cell-mono">
                              {formatUsdt(absPositionSizeUsd(p))}
                            </td>
                            <td
                              className={`cell-mono cell-pnl ${pnlClass(
                                p.unRealizedProfit,
                              )}`}
                            >
                              {formatPnl2(p.unRealizedProfit)}
                            </td>
                            <td
                              className={`cell-mono cell-pnl ${pnlClass(
                                unrealizedPctVsEntry(p),
                              )}`}
                            >
                              {formatUnrealizedPct(p)}
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
        {view === 'emotions' && (
          <EmotionsErrorBoundary>
            <Emotions />
          </EmotionsErrorBoundary>
        )}
        {view === 'mldataset' && <MlDatasetPrep />}
        {view === 'backtest1' && <Backtest1 />}
        {view === 'backtest2' && <Backtest2 />}
        {view === 'volume' && <VolumeScreener />}
        {view === 'backtest3' && <Backtest3 />}
        {view === 'backtest4' && <Backtest4 />}
        {view === 'zonehedge' && <ZoneHedgeBacktest />}
        {view === 'hourlyspikes' && <HourlySpikesBacktest />}
        {view === 'gptbacktest' && <GptBacktest />}
        {view === 'spikefilter' && <SpikeFilter />}
        {view === 'spiketpsl' && <SpikeTpSlBacktest />}
        {view === 'spiketpslv2' && <SpikeTpSlBacktestV2 />}
        {view === 'spiketpslv3' && <SpikeTpSlBacktestV3 />}
        {view === '5minscreener' && <FiveMinScreener spikeDirections="up" />}
        {view === '5minscreener-bi' && <FiveMinScreener spikeDirections="both" />}
        {view === 'hft' && <HFT />}
      </main>
    </div>
  )
}

function pnlClass(value) {
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (Number.isNaN(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}

/**
 * Approx. ROE: (PnL / notional) × 100 × leverage, with notional = |size|×entry.
 * Matches “return on margin” when initial margin ≈ notional/leverage (isolated).
 */
function unrealizedPctVsEntry(p) {
  const pnl = parseFloat(p.unRealizedProfit)
  const qty = parseFloat(p.positionAmt)
  const entry = parseFloat(p.entryPrice)
  const notional = Math.abs(qty) * entry
  if (!Number.isFinite(pnl) || !Number.isFinite(notional) || notional <= 0) {
    return null
  }
  const notionalPct = (pnl / notional) * 100
  const lev = parseFloat(p.leverage)
  const mult = Number.isFinite(lev) && lev > 0 ? lev : 1
  return notionalPct * mult
}

function absPositionSizeUsd(p) {
  const fromNotional = parseFloat(p.notional)
  if (Number.isFinite(fromNotional)) return Math.abs(fromNotional)
  const qty = parseFloat(p.positionAmt)
  const mark = parseFloat(p.markPrice)
  if (Number.isFinite(qty) && Number.isFinite(mark)) {
    return Math.abs(qty * mark)
  }
  const entry = parseFloat(p.entryPrice)
  if (Number.isFinite(qty) && Number.isFinite(entry)) {
    return Math.abs(qty * entry)
  }
  return 0
}

function isPnlBreach(totalOpenPnl, walletBalance, maxNegPnlPct) {
  if (!Number.isFinite(totalOpenPnl) || !Number.isFinite(walletBalance) || walletBalance <= 0) {
    return false
  }
  if (!Number.isFinite(maxNegPnlPct) || maxNegPnlPct <= 0) return false
  const pct = (totalOpenPnl / walletBalance) * 100
  return pct <= -Math.abs(maxNegPnlPct)
}

function isPositionRiskBreach(p, maxTradeUsd, maxNegPnlPct) {
  const sizeUsd = absPositionSizeUsd(p)
  const overTrade =
    Number.isFinite(maxTradeUsd) && maxTradeUsd > 0 && sizeUsd > maxTradeUsd
  const upct = unrealizedPctVsEntry(p)
  const overLoss =
    Number.isFinite(maxNegPnlPct) && maxNegPnlPct > 0 && Number.isFinite(upct) && upct <= -maxNegPnlPct
  return overTrade || overLoss
}

function formatUnrealizedPct(p) {
  const pct = unrealizedPctVsEntry(p)
  if (pct == null || !Number.isFinite(pct)) return '—'
  const sign = pct < 0 ? '' : '+'
  return `${sign}${pct.toFixed(2)}%`
}

function formatUsdt(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatPnl2(raw) {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return formatUsdt(n)
}

export default App
