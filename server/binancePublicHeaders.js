/**
 * Optional X-MBX-APIKEY on Binance Futures public REST calls (klines, 24h ticker, exchangeInfo).
 * These endpoints do not require a signature; the key is optional but can help on some networks.
 * Use the same BINANCE_API_KEY as signed routes. Never send the secret to the browser.
 */
export function binanceFuturesPublicHeaders() {
  const k = process.env.BINANCE_API_KEY?.trim()
  if (!k) return {}
  return { 'X-MBX-APIKEY': k }
}
