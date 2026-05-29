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

interface OpenAIMessage {
  role: string
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export class OpenAIAdapter implements ApiAdapter {
  provider = 'openai' as const
  private baseUrl: string
  private apiKey: string

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  }

  formatTools(tools: ToolDef[]): unknown[] {
    return tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  getUsage(raw: unknown): UsageStats {
    const u = raw as OpenAIUsage
    const hit = u.prompt_tokens_details?.cached_tokens ?? 0
    const miss = Math.max(0, u.prompt_tokens - hit)
    return {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheHitRatio: computeCacheHitRatio(hit, miss),
      costUsd: estimateCost('openai', '', u.prompt_tokens, u.completion_tokens, hit),
    }
  }

  private formatMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.tool_call_id }
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return { role: 'assistant', content: typeof m.content === 'string' ? m.content : null, tool_calls: m.tool_calls }
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
      max_tokens: opts.maxTokens ?? 1_000_000,
      stream: false,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI API ${res.status}: ${err}`)
    }

    const data = await res.json() as any
    const msg = data.choices[0].message
    const usage = this.getUsage(data.usage)

    return {
      content: msg.content ?? '',
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
      max_tokens: opts.maxTokens ?? 1_000_000,
      stream: true,
      stream_options: { include_usage: true },
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI API ${res.status}: ${err}`)
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
