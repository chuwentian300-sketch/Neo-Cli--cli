// API retry with exponential backoff and error classification

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

const DEFAULT: Required<RetryOptions> = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
}

function classifyError(err: Error): 'transient' | 'rate_limit' | 'overloaded' | 'fatal' {
  const msg = err.message || ''
  // 529 Overloaded
  if (msg.includes('529') || msg.toLowerCase().includes('overloaded')) return 'overloaded'
  // 429 Rate limit
  if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) return 'rate_limit'
  // Connection errors
  if (msg.includes('ECONNRESET') || msg.includes('EPIPE') || msg.includes('ETIMEDOUT') ||
      msg.includes('fetch failed') || msg.includes('socket hang up') || msg.includes('timeout')) return 'transient'
  // prompt_too_long — caller should handle via reactive compact
  if (msg.includes('prompt_too_long') || msg.includes('context_length_exceeded')) throw err
  return 'fatal'
}

function delay(attempt: number, base: number, max: number): number {
  const ms = Math.min(base * Math.pow(2, attempt) + Math.random() * 500, max)
  return ms
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT, ...opts }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      if (attempt === maxRetries) throw err

      const kind = classifyError(err)
      if (kind === 'fatal') throw err

      // Overloaded: max 3 retries
      if (kind === 'overloaded' && attempt >= 3) throw err

      const wait = delay(attempt, baseDelayMs, maxDelayMs)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error('unreachable')
}
