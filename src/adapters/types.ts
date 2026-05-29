export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ToolCallPart[] | ToolResultPart[]
  reasoning_content?: string
  tool_calls?: ToolCallPart[]
  name?: string
  tool_call_id?: string
}

export interface ToolCallPart {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolResultPart {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CallOptions {
  model: string
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface UsageStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  cacheHitRatio: number
  costUsd: number
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'reasoning' | 'usage' | 'done'
  content?: string
  tool_calls?: ToolCallPart[]
  usage?: UsageStats
}

export interface ChatResponse {
  content: string
  reasoning_content?: string
  tool_calls: ToolCallPart[]
  usage: UsageStats
  model: string
  finish_reason: string
}

export type Provider = 'claude' | 'openai' | 'deepseek'

export interface ModelConfig {
  id: string
  tier: 'high' | 'low'
  provider: Provider
}

export interface ApiAdapter {
  provider: Provider
  chat(messages: ChatMessage[], opts: CallOptions): Promise<ChatResponse>
  stream(messages: ChatMessage[], opts: CallOptions): AsyncGenerator<StreamChunk>
  formatTools(tools: ToolDef[]): unknown[]
  getUsage(rawResponse: unknown): UsageStats
}

export function computeCacheHitRatio(hit: number, miss: number): number {
  const total = hit + miss
  return total === 0 ? 0 : hit / total
}

export function estimateCost(
  provider: Provider,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens: number,
): number {
  const cacheMissTokens = promptTokens - cacheHitTokens
  const prices: Record<string, { input: number; output: number; cacheHit: number }> = {
    'claude-opus-4-5': { input: 15, output: 75, cacheHit: 1.5 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheHit: 0.3 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheHit: 0.08 },
    'gpt-4o': { input: 2.5, output: 10, cacheHit: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.6, cacheHit: 0.075 },
    'deepseek-v4-pro': { input: 2, output: 8, cacheHit: 0.2 },
    'deepseek-v4-flash': { input: 0.27, output: 1.1, cacheHit: 0.027 },
  }
  const p = prices[model] ?? prices['gpt-4o']
  return (cacheMissTokens * p.input + cacheHitTokens * p.cacheHit + completionTokens * p.output) / 1_000_000
}
