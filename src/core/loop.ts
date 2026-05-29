import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type {
  ChatMessage,
  ApiAdapter,
  ModelConfig,
  ToolDef,
} from '../adapters/types.js'
import { ImmutablePrefix } from './immutable-prefix.js'
import { AppendOnlyLog } from './append-only-log.js'
import { ContextManager, type ContextManagerOptions } from './context-manager.js'
import { ModelSwitcher, type ConversationContext } from './model-switcher.js'
import { ToolRegistry, ToolCallRepair, StormBreaker, dispatchToolCalls } from './tool-dispatch.js'
import { withRetry } from './retry.js'
import type { AppConfig } from '../config/types.js'

export type LoopEvent =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; output: string }
  | { type: 'model_switch'; model: string; reason: string }
  | { type: 'fold'; level: string }
  | { type: 'usage'; prompt: number; completion: number; cacheHit: number; cost: number }
  | { type: 'error'; message: string }
  | { type: 'done'; response: string }

export interface LoopOptions {
  adapters: Map<string, ApiAdapter>
  config: AppConfig
  tools: ToolDef[]
  toolRegistry: ToolRegistry
  sessionPath?: string
  abortSignal?: AbortSignal
}

// Tool result budget: results larger than this are saved to disk
const TOOL_RESULT_BUDGET_CHARS = 4000 * 3.5
const TOOL_RESULT_DIR = join(homedir(), '.neo-cli', 'tool-results')

export class CacheFirstLoop {
  readonly prefix: ImmutablePrefix
  private log: AppendOnlyLog
  private context: ContextManager
  private switcher: ModelSwitcher
  private repair: ToolCallRepair
  private storm: StormBreaker
  private adapters: Map<string, ApiAdapter>
  private config: AppConfig
  private tools: ToolDef[]
  private toolRegistry: ToolRegistry
  private mode: 'execute' | 'ask' = 'execute'
  private turnCount = 0
  private hasActivePlan = false
  private totalCost = 0
  private reactiveCompactAttempts = 0
  private abortSignal?: AbortSignal

  constructor(opts: LoopOptions) {
    this.abortSignal = opts.abortSignal
    this.adapters = opts.adapters
    this.config = opts.config
    this.tools = opts.tools
    this.toolRegistry = opts.toolRegistry

    this.prefix = new ImmutablePrefix({
      mode: opts.config.defaultMode,
      language: opts.config.language,
      tools: opts.tools,
      mbti: opts.config.mbti,
    })

    this.log = new AppendOnlyLog(opts.sessionPath)
    this.repair = new ToolCallRepair()
    this.storm = new StormBreaker()

    const highAdapter = this.getAdapter(opts.config.models.high.provider)
    this.context = new ContextManager(
      opts.config.context as ContextManagerOptions,
      highAdapter,
      opts.config.models.low.id,
    )

    this.switcher = new ModelSwitcher(
      opts.config.models.high as ModelConfig,
      opts.config.models.low as ModelConfig,
    )
  }

  private getAdapter(provider: string): ApiAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`No adapter for provider: ${provider}`)
    return adapter
  }

  setMode(mode: 'execute' | 'ask') {
    this.mode = mode
  }

  private async selectModel(userMessage: string): Promise<{ adapter: ApiAdapter; model: ModelConfig; reason: string }> {
    const ctx: ConversationContext = {
      turnCount: this.turnCount,
      hasActivePlan: this.hasActivePlan,
      lastToolCalls: [],
    }

    const model = this.switcher.selectModel(userMessage, ctx)
    const adapter = this.getAdapter(model.provider)
    const reason = model.tier === 'high' ? 'plan/complex task' : 'execute/simple task'

    if (model.tier === 'high') this.hasActivePlan = true

    return { adapter, model, reason }
  }

  async *step(userMessage: string): AsyncGenerator<LoopEvent> {
    this.log.append({ role: 'user', content: userMessage })
    this.turnCount++
    this.storm.reset()
    this.reactiveCompactAttempts = 0

    const { adapter, model, reason } = await this.selectModel(userMessage)
    yield { type: 'model_switch', model: model.id, reason }

    while (true) {
      // 检查是否被中断
      if (this.abortSignal?.aborted) {
        yield { type: 'error', message: '已中断' }
        return
      }

      const ratio = this.context.getUsageRatio(this.prefix, this.log)
      const foldLevel = this.context.shouldFold(ratio)
      if (foldLevel !== 'none') {
        yield { type: 'fold', level: foldLevel }
        await this.context.fold(this.log, this.prefix, foldLevel)
      }

      const messages = [...this.prefix.toMessages(), ...this.healOnSend()]
      const activeTools = this.mode === 'ask' ? [] : this.tools
      const callOpts = { model: model.id, tools: activeTools, maxTokens: this.config.maxTokens, stream: true }

      let accumulatedText = ''
      let accumulatedReasoning = ''
      const toolCalls: any[] = []
      let gotUsage = false

      try {
        // Retry wrapper for the streaming call
        const stream = adapter.stream(messages, callOpts)
        for await (const chunk of stream) {
          // 检查是否被中断
          if (this.abortSignal?.aborted) {
            yield { type: 'error', message: '已中断' }
            return
          }

          switch (chunk.type) {
            case 'text':
              accumulatedText += chunk.content ?? ''
              yield { type: 'text', content: chunk.content! }
              break
            case 'reasoning':
              accumulatedReasoning += chunk.content ?? ''
              yield { type: 'reasoning', content: chunk.content! }
              break
            case 'tool_call':
              toolCalls.push(...(chunk.tool_calls ?? []))
              break
            case 'usage':
              gotUsage = true
              if (chunk.usage) {
                this.totalCost += chunk.usage.costUsd
                yield {
                  type: 'usage',
                  prompt: chunk.usage.promptTokens,
                  completion: chunk.usage.completionTokens,
                  cacheHit: chunk.usage.cacheHitTokens,
                  cost: chunk.usage.costUsd,
                }
              }
              break
          }
        }
      } catch (err: any) {
        const msg = err.message || ''

        // Reactive compact: prompt_too_long → compress and retry
        if ((msg.includes('prompt_too_long') || msg.includes('context_length_exceeded')) &&
            this.reactiveCompactAttempts < 3) {
          this.reactiveCompactAttempts++
          yield { type: 'fold', level: 'reactive' }
          await this.context.fold(this.log, this.prefix, 'force')
          continue  // retry the loop with compressed context
        }

        // Retry for transient/rate-limit errors
        if (msg.includes('529') || msg.includes('429') || msg.includes('ECONNRESET') ||
            msg.includes('fetch failed') || msg.includes('timeout')) {
          try {
            const result = await withRetry(async () => {
              // Re-build messages after potential context changes
              const msgs = [...this.prefix.toMessages(), ...this.healOnSend()]
              const chunks: any[] = []
              for await (const c of adapter.stream(msgs, callOpts)) {
                chunks.push(c)
              }
              return chunks
            })
            // Process retried chunks
            for (const chunk of result) {
              switch (chunk.type) {
                case 'text':
                  accumulatedText += chunk.content ?? ''
                  yield { type: 'text', content: chunk.content! }
                  break
                case 'reasoning':
                  accumulatedReasoning += chunk.content ?? ''
                  break
                case 'tool_call':
                  toolCalls.push(...(chunk.tool_calls ?? []))
                  break
                case 'usage':
                  if (chunk.usage) {
                    this.totalCost += chunk.usage.costUsd
                    yield {
                      type: 'usage',
                      prompt: chunk.usage.promptTokens,
                      completion: chunk.usage.completionTokens,
                      cacheHit: chunk.usage.cacheHitTokens,
                      cost: chunk.usage.costUsd,
                    }
                  }
                  break
              }
            }
          } catch (retryErr: any) {
            yield { type: 'error', message: `重试失败: ${retryErr.message}` }
            return
          }
        } else {
          yield { type: 'error', message: err.message }
          return
        }
      }

      if (toolCalls.length > 0) {
        // Streaming tool execution: yield starts immediately
        for (const tc of toolCalls) {
          yield { type: 'tool_start', name: tc.function.name }
        }

        const toolMessages = await dispatchToolCalls(
          toolCalls,
          this.toolRegistry,
          this.repair,
          this.storm,
        )

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: accumulatedText || '',
          tool_calls: toolCalls,
        }
        this.log.append(assistantMsg)

        for (const msg of toolMessages) {
          // Tool result budget: save large results to disk
          if (typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_BUDGET_CHARS) {
            const budgeted = await this.applyToolResultBudget(msg)
            this.log.append(budgeted)
          } else {
            this.log.append(msg)
          }
          const toolName = toolCalls.find(tc => tc.id === msg.tool_call_id)?.function?.name ?? 'unknown'
          yield { type: 'tool_end', name: toolName, output: typeof msg.content === 'string' ? msg.content.slice(0, 200) : '' }
        }

        this.storm.tick()
        this.context.compactToolResults(this.log)
        this.reactiveCompactAttempts = 0
        continue
      }

      const finalMsg: ChatMessage = { role: 'assistant', content: accumulatedText }
      this.log.append(finalMsg)
      yield { type: 'done', response: accumulatedText }
      return
    }
  }

  // Tool result budget: save large results to disk, return preview + path
  private async applyToolResultBudget(msg: ChatMessage): Promise<ChatMessage> {
    try {
      await mkdir(TOOL_RESULT_DIR, { recursive: true })
      const id = `result_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const filePath = join(TOOL_RESULT_DIR, `${id}.txt`)
      await writeFile(filePath, typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), 'utf-8')

      const preview = (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)).slice(0, 800)
      return {
        ...msg,
        content: `${preview}\n\n...[结果已保存到 ${filePath}，共 ${(msg.content as string).length} 字符，需要时可用 read_file 读取]`,
      }
    } catch {
      // Fallback: just truncate
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      return { ...msg, content: content.slice(0, TOOL_RESULT_BUDGET_CHARS) + '\n...[已截断]' }
    }
  }

  private healOnSend(): ChatMessage[] {
    const entries = this.log.all
    const healed: ChatMessage[] = []

    for (let i = 0; i < entries.length; i++) {
      const msg = entries[i].message
      const clean: ChatMessage = { ...msg }
      delete clean.reasoning_content
      healed.push(clean)
    }

    return healed
  }

  async loadSession(): Promise<void> {
    await this.log.load()
    this.healOnLoad()
    this.turnCount = this.log.all.filter(e => e.message.role === 'user').length
  }

  private healOnLoad(): void {
    const entries = this.log.all
    const toolCallIds = new Set<string>()
    const orphanIndices: number[] = []

    for (const entry of entries) {
      if (entry.message.role === 'assistant' && entry.message.tool_calls) {
        for (const tc of entry.message.tool_calls) {
          toolCallIds.add(tc.id)
        }
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const msg = entries[i].message

      if (msg.role === 'tool' && !toolCallIds.has(msg.tool_call_id!)) {
        orphanIndices.push(i)
      }

      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_BUDGET_CHARS) {
        const truncated = msg.content.slice(0, TOOL_RESULT_BUDGET_CHARS) + '\n...[恢复时已缩略]'
        this.log.replaceRange(i, i + 1, [{ ...msg, content: truncated }])
      }

      if (msg.reasoning_content) {
        const clean = { ...msg }
        delete clean.reasoning_content
        this.log.replaceRange(i, i + 1, [clean])
      }
    }

    for (let i = orphanIndices.length - 1; i >= 0; i--) {
      const idx = orphanIndices[i]
      const before = this.log.slice(0, idx)
      const after = this.log.slice(idx + 1)
      this.log.clear()
      for (const e of before) this.log.append(e.message, e.model)
      for (const e of after) this.log.append(e.message, e.model)
    }
  }

  async saveSession(): Promise<void> {
    await this.log.persist()
  }

  get stats() {
    return {
      turns: this.turnCount,
      messages: this.log.length,
      totalCost: this.totalCost,
      fingerprint: this.prefix.fingerprint,
    }
  }

  getContextUsage(): number {
    return this.context.getUsageRatio(this.prefix, this.log)
  }

  setMbti(mbti: string | undefined) {
    this.config.mbti = mbti
    this.prefix.setMbti(mbti)
  }

  getRecentEntries(count: number) {
    return this.log.all.slice(-count)
  }
}
