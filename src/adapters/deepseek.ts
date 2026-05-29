import type {
  ApiAdapter,
  ChatMessage,
  CallOptions,
  ChatResponse,
  StreamChunk,
  ToolDef,
  UsageStats,
} from './types.js'
import { computeCacheHitRatio, estimateCost } from './types.js'

interface DeepSeekMessage {
  role: string
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
  reasoning_content?: string
}

interface DeepSeekUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}

export class DeepSeekAdapter implements ApiAdapter {
  provider = 'deepseek' as const
  private baseUrl: string
  private apiKey: string

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  }

  formatTools(tools: ToolDef[]): unknown[] {
    return tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  getUsage(raw: unknown): UsageStats {
    const u = raw as DeepSeekUsage
    const hit = u.prompt_cache_hit_tokens ?? 0
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - hit)
    return {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheHitRatio: computeCacheHitRatio(hit, miss),
      costUsd: estimateCost('deepseek', '', u.prompt_tokens, u.completion_tokens, hit),
    }
  }

  private formatMessages(messages: ChatMessage[]): DeepSeekMessage[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.tool_call_id }
      }
      if (m.role === 'assistant') {
        const msg: DeepSeekMessage = {
          role: 'assistant',
          content: typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : null),
        }
        if (m.tool_calls?.length) msg.tool_calls = m.tool_calls
        if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
        return msg
      }
      return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
    })
  }

  async chat(messages: ChatMessage[], opts: CallOptions): Promise<ChatResponse> {
    const body = {
      model: opts.model,
      messages: this.formatMessages(messages),
      tools: opts.tools ? this.formatTools(opts.tools) : undefined,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 393216,
      stream: false,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(660_000),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DeepSeek API ${res.status}: ${err}`)
    }

    const data = await res.json() as any
    const msg = data.choices[0].message
    const usage = this.getUsage(data.usage)

    return {
      content: msg.content ?? '',
      reasoning_content: msg.reasoning_content,
      tool_calls: msg.tool_calls ?? [],
      usage,
      model: data.model,
      finish_reason: data.choices[0].finish_reason,
    }
  }

  async *stream(messages: ChatMessage[], opts: CallOptions): AsyncGenerator<StreamChunk> {
    const body = {
      model: opts.model,
      messages: this.formatMessages(messages),
      tools: opts.tools ? this.formatTools(opts.tools) : undefined,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 393216,
      stream: true,
      stream_options: { include_usage: true },
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(660_000),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DeepSeek API ${res.status}: ${err}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCalls: Map<number, { id: string; function: { name: string; arguments: string } }> = new Map()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            if (!delta) {
              if (parsed.usage) {
                yield { type: 'usage', usage: this.getUsage(parsed.usage) }
              }
              continue
            }

            if (delta.reasoning_content) {
              yield { type: 'reasoning', content: delta.reasoning_content }
            }
            if (delta.content) {
              yield { type: 'text', content: delta.content }
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                const existing = toolCalls.get(idx)
                if (existing) {
                  existing.id += tc.id ?? ''
                  existing.function.name += tc.function?.name ?? ''
                  existing.function.arguments += tc.function?.arguments ?? ''
                } else {
                  toolCalls.set(idx, {
                    id: tc.id ?? '',
                    function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                  })
                }
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (toolCalls.size > 0) {
      yield { type: 'tool_call', tool_calls: Array.from(toolCalls.values()).map(tc => ({ ...tc, type: 'function' as const })) }
    }
    yield { type: 'done' }
  }
}
