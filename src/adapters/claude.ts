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

interface ClaudeMessage {
  role: string
  content: string | unknown[]
}

interface ClaudeUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export class ClaudeAdapter implements ApiAdapter {
  provider = 'claude' as const
  private baseUrl: string
  private apiKey: string

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  }

  formatTools(tools: ToolDef[]): unknown[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  getUsage(raw: unknown): UsageStats {
    const u = raw as ClaudeUsage
    const hit = u.cache_read_input_tokens ?? 0
    const miss = u.input_tokens
    return {
      promptTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + hit,
      completionTokens: u.output_tokens,
      totalTokens: u.input_tokens + u.output_tokens + (u.cache_creation_input_tokens ?? 0) + hit,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      cacheHitRatio: computeCacheHitRatio(hit, miss),
      costUsd: estimateCost('claude', '', u.input_tokens + hit, u.output_tokens, hit),
    }
  }

  private formatMessages(messages: ChatMessage[]): ClaudeMessage[] {
    const result: ClaudeMessage[] = []
    for (const m of messages) {
      if (m.role === 'system') continue
      if (m.role === 'tool') {
        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }],
        })
        continue
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const content: unknown[] = []
        if (typeof m.content === 'string' && m.content) {
          content.push({ type: 'text', text: m.content })
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          })
        }
        result.push({ role: 'assistant', content })
        continue
      }
      result.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })
    }
    return result
  }

  private extractSystem(messages: ChatMessage[]): { text: string; cache: boolean }[] {
    const systemMsgs = messages.filter(m => m.role === 'system')
    if (systemMsgs.length === 0) return []
    const text = systemMsgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n')
    return [{ text, cache: true }]
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  async chat(messages: ChatMessage[], opts: CallOptions): Promise<ChatResponse> {
    const system = this.extractSystem(messages)
    const formatted = this.formatMessages(messages)

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1_000_000,
      messages: formatted,
      stream: false,
    }

    if (system.length > 0) {
      body.system = system
    }
    if (opts.tools?.length) {
      body.tools = this.formatTools(opts.tools)
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Claude API ${res.status}: ${err}`)
    }

    const data = await res.json() as any
    const usage = this.getUsage(data.usage)

    let content = ''
    const toolCalls: any[] = []
    for (const block of data.content ?? []) {
      if (block.type === 'text') content += block.text
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        })
      }
    }

    return {
      content,
      tool_calls: toolCalls,
      usage,
      model: data.model,
      finish_reason: data.stop_reason,
    }
  }

  async *stream(messages: ChatMessage[], opts: CallOptions): AsyncGenerator<StreamChunk> {
    const system = this.extractSystem(messages)
    const formatted = this.formatMessages(messages)

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1_000_000,
      messages: formatted,
      stream: true,
    }

    if (system.length > 0) {
      body.system = system
    }
    if (opts.tools?.length) {
      body.tools = this.formatTools(opts.tools)
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Claude API ${res.status}: ${err}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentToolUse: { id: string; name: string; input: string } | null = null

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

          try {
            const parsed = JSON.parse(data)

            if (parsed.type === 'content_block_start') {
              if (parsed.content_block?.type === 'tool_use') {
                currentToolUse = { id: parsed.content_block.id, name: parsed.content_block.name, input: '' }
              }
            } else if (parsed.type === 'content_block_delta') {
              if (parsed.delta?.type === 'text_delta') {
                yield { type: 'text', content: parsed.delta.text }
              } else if (parsed.delta?.type === 'input_json_delta' && currentToolUse) {
                currentToolUse.input += parsed.delta.partial_json
              } else if (parsed.delta?.type === 'thinking_delta') {
                yield { type: 'reasoning', content: parsed.delta.thinking }
              }
            } else if (parsed.type === 'content_block_stop') {
              if (currentToolUse) {
                yield {
                  type: 'tool_call',
                  tool_calls: [{
                    id: currentToolUse.id,
                    type: 'function' as const,
                    function: { name: currentToolUse.name, arguments: currentToolUse.input || '{}' },
                  }],
                }
                currentToolUse = null
              }
            } else if (parsed.type === 'message_delta') {
              if (parsed.usage) {
                yield { type: 'usage', usage: this.getUsage(parsed.usage) }
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done' }
  }
}
