import WebSocket from 'ws'

/** USDT-M perpetual — experimental HFT tape + top of book */
const SYMBOL = 'RAVEUSDT'
const LOWER = SYMBOL.toLowerCase()
const STREAMS = `${LOWER}@bookTicker/${LOWER}@aggTrade`

/**
 * SSE bridge: browser EventSource → this server → Binance futures combined stream.
 * No API key (public market data).
 */
export function mountHftRaveSse(app, { futuresWsBase }) {
  app.get('/api/binance/hft-raveusdt-sse', (req, res) => {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    let ws = null
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true
      try {
        ws?.terminate()
      } catch {
        /* ignore */
      }
      ws = null
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }

    const base = String(futuresWsBase || '').replace(/\/$/, '')
    const url = `${base}/stream?${new URLSearchParams({ streams: STREAMS })}`

    try {
      ws = new WebSocket(url)
    } catch (e) {
      const err = e instanceof Error ? e.message : 'WebSocket create failed'
      res.write(`data: ${JSON.stringify({ type: 'error', error: err })}\n\n`)
      cleanup()
      return
    }

    ws.on('open', () => {
      if (closed) return
      res.write(
        `data: ${JSON.stringify({ type: 'status', status: 'binance_ws_open' })}\n\n`,
      )
    })

    ws.on('message', (raw) => {
      if (closed) return
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      const envelope = {
        type: 'tick',
        serverReceivedAt: Date.now(),
        msg: parsed,
      }
      res.write(`data: ${JSON.stringify(envelope)}\n\n`)
    })

    ws.on('error', (err) => {
      if (closed) return
      const message = err instanceof Error ? err.message : String(err)
      res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`)
    })

    ws.on('close', () => {
      if (closed) return
      res.write(
        `data: ${JSON.stringify({ type: 'status', status: 'binance_ws_closed' })}\n\n`,
      )
      cleanup()
    })

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  })
}
