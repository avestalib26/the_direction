import crypto from 'node:crypto'
import cors from 'cors'
import express from 'express'
import {
  ALLOWED_INTERVALS,
  computeMarketBreadth,
} from './breadth.js'
import { computeClosedPositionPnl } from './closedPositions.js'

const USE_TESTNET = process.env.BINANCE_USE_TESTNET === 'true'
const FUTURES_BASE =
  process.env.BINANCE_FUTURES_BASE ||
  (USE_TESTNET
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com')

function signQuery(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

/** Binance expects query params sorted by name for the signed payload. */
function signedFuturesUrl(path, apiSecret, params) {
  const merged = {
    recvWindow: 5000,
    timestamp: Date.now(),
    ...params,
  }
  const qs = Object.keys(merged)
    .sort()
    .map((k) => `${k}=${merged[k]}`)
    .join('&')
  const signature = signQuery(apiSecret, qs)
  return `${FUTURES_BASE}${path}?${qs}&signature=${signature}`
}

async function signedFuturesJson(apiKey, apiSecret, path, params) {
  const url = signedFuturesUrl(path, apiSecret, params)
  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': apiKey },
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Binance error (${res.status}): ${text.slice(0, 240)}`)
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    throw new Error(`Binance ${res.status}: ${msg}`)
  }
  return data
}

async function fetchPositionRisk(apiKey, apiSecret) {
  return signedFuturesJson(apiKey, apiSecret, '/fapi/v2/positionRisk', {})
}

/**
 * USDT-M futures wallet (USDT) — Binance sometimes omits or zeros
 * totalWalletBalance; fall back to assets[] then /fapi/v2/balance.
 */
async function getFuturesUsdtWalletTotal(apiKey, apiSecret) {
  const acc = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/account', {})
  const top = parseFloat(acc.totalWalletBalance ?? '')
  if (Number.isFinite(top) && top !== 0) {
    return top
  }
  const assets = acc.assets
  if (Array.isArray(assets)) {
    const usdt = assets.find((a) => a.asset === 'USDT')
    if (usdt) {
      const w = parseFloat(
        usdt.walletBalance ?? usdt.crossWalletBalance ?? usdt.marginBalance ?? '',
      )
      if (Number.isFinite(w)) return w
    }
  }
  const bal = await signedFuturesJson(apiKey, apiSecret, '/fapi/v2/balance', {})
  if (Array.isArray(bal)) {
    const row = bal.find((b) => b.asset === 'USDT')
    if (row) {
      const w = parseFloat(
        row.crossWalletBalance ?? row.walletBalance ?? row.balance ?? '',
      )
      if (Number.isFinite(w)) return w
    }
  }
  return Number.isFinite(top) ? top : 0
}

export const app = express()
app.use(cors({ origin: true }))

app.get('/api/binance/futures-wallet', async (_req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  try {
    const totalWalletBalance = await getFuturesUsdtWalletTotal(
      apiKey,
      apiSecret,
    )
    res.json({
      totalWalletBalance,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Wallet request failed',
    })
  }
})

app.get('/api/binance/open-positions', async (_req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  try {
    const all = await fetchPositionRisk(apiKey, apiSecret)
    const positions = Array.isArray(all)
      ? all.filter((p) => Math.abs(parseFloat(p.positionAmt || 0)) > 0)
      : []
    res.json({ positions, fetchedAt: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Binance request failed',
    })
  }
})

app.get('/api/binance/market-breadth', async (req, res) => {
  const interval = String(req.query.interval ?? '5m')
  const limit = Number.parseInt(String(req.query.limit ?? '30'), 10)
  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: `Invalid interval. Use one of: ${[...ALLOWED_INTERVALS].join(', ')}`,
    })
  }
  if (!Number.isFinite(limit) || limit < 2 || limit > 1500) {
    return res.status(400).json({
      error: 'limit must be between 2 and 1500',
    })
  }
  try {
    const result = await computeMarketBreadth(FUTURES_BASE, interval, limit)
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Market breadth failed',
    })
  }
})

app.get('/api/binance/closed-positions', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET
  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error:
        'Set BINANCE_API_KEY and BINANCE_API_SECRET in a .env file in the project root.',
    })
  }
  let limit = Number.parseInt(String(req.query.limit ?? '1000'), 10)
  if (!Number.isFinite(limit) || limit < 1) limit = 1000
  limit = Math.min(limit, 1000)
  try {
    const signed = (path, params) =>
      signedFuturesJson(apiKey, apiSecret, path, params)
    const result = await computeClosedPositionPnl(signed, { limit })
    res.json({
      ...result,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Closed positions failed',
    })
  }
})
