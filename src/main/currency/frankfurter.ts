/**
 * Free exchange-rate lookup (no API key) executed in the main process so
 * the renderer is not constrained by CORS / mixed-content rules.
 *
 * Primary: open.er-api.com (ExchangeRate-API open endpoint) — daily rates,
 * 160+ currencies including RUB, KZT, UAH. No key required.
 *
 * Fallback: Frankfurter (ECB-backed) — dependable for G10 pairs but does
 * not publish RUB or KZT, so we only use it when the primary is down.
 *
 * Function name is retained for backwards compatibility with the preload
 * bridge and renderer callers.
 */
let cachedBase: string | null = null
let cachedRates: Record<string, number> | null = null
let cachedDate = ''
let cachedFetchedAt = 0

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const TAG = '[currency/main]'

export type FrankfurterLatestPayload = {
  base: string
  date: string
  rates: Record<string, number>
}

type OpenErApiResponse = {
  result?: string
  base_code?: string
  time_last_update_utc?: string
  rates?: Record<string, number>
}

type FrankfurterResponse = {
  base?: string
  date?: string
  rates?: Record<string, number>
}

async function fetchOpenErApi(base: string): Promise<FrankfurterLatestPayload> {
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`
  console.debug(TAG, 'fetch', url)
  const res = await fetch(url)
  console.debug(TAG, 'response', res.status)
  if (!res.ok) {
    throw new Error(`open.er-api HTTP ${res.status}`)
  }
  const data = (await res.json()) as OpenErApiResponse
  if (data.result && data.result !== 'success') {
    throw new Error(`open.er-api error: ${data.result}`)
  }
  const rates = data.rates
  if (!rates || typeof rates !== 'object') {
    throw new Error('open.er-api: invalid response')
  }
  const date = typeof data.time_last_update_utc === 'string' ? data.time_last_update_utc : ''
  return { base, date, rates }
}

async function fetchFrankfurter(base: string): Promise<FrankfurterLatestPayload> {
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}`
  console.debug(TAG, 'fetch fallback', url)
  const res = await fetch(url)
  console.debug(TAG, 'response (frankfurter)', res.status)
  if (!res.ok) {
    throw new Error(`Frankfurter HTTP ${res.status}`)
  }
  const data = (await res.json()) as FrankfurterResponse
  const rates = data.rates
  if (!rates || typeof rates !== 'object') {
    throw new Error('Frankfurter: invalid response')
  }
  return {
    base,
    date: typeof data.date === 'string' ? data.date : '',
    rates,
  }
}

export async function fetchFrankfurterLatest(from: string): Promise<FrankfurterLatestPayload> {
  const a = from.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(a)) {
    throw new Error(`Invalid currency code: ${from}`)
  }

  const now = Date.now()
  if (cachedBase === a && cachedRates && now - cachedFetchedAt < CACHE_TTL_MS) {
    console.debug(TAG, 'cache hit', { base: a, date: cachedDate })
    return { base: a, date: cachedDate, rates: cachedRates }
  }

  let payload: FrankfurterLatestPayload
  try {
    payload = await fetchOpenErApi(a)
  } catch (primaryErr) {
    console.warn(TAG, 'open.er-api failed — falling back to Frankfurter', primaryErr)
    payload = await fetchFrankfurter(a)
  }

  cachedBase = a
  cachedRates = payload.rates
  cachedDate = payload.date
  cachedFetchedAt = now

  console.debug(TAG, 'ok', {
    base: a,
    date: payload.date,
    sampleRUB: payload.rates.RUB,
    sampleKZT: payload.rates.KZT,
    sampleEUR: payload.rates.EUR,
  })
  return payload
}
