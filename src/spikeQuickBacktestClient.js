/** Shared client for `/api/binance/spike-tpsl-quick-backtest/stream` (SSE). */

export const MAX_QUICK_BACKTEST_CANDLES = 20000

export async function consumeQuickBacktestStream(query, onEvent) {
  const res = await fetch(`/api/binance/spike-tpsl-quick-backtest/stream?${query}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(t || `HTTP ${res.status}`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')
  const dec = new TextDecoder()
  let buf = ''
  let last = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (;;) {
      const sep = buf.indexOf('\n\n')
      if (sep < 0) break
      const block = buf.slice(0, sep).trim()
      buf = buf.slice(sep + 2)
      const dataLine = block
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      const json = dataLine.replace(/^data:\s?/, '')
      const obj = JSON.parse(json)
      last = obj
      onEvent(obj)
    }
  }
  return last
}
