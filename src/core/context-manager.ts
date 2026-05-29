import type { ChatMessage, ApiAdapter, CallOptions } from '../adapters/types.js'
import type { AppendOnlyLog, LogEntry } from './append-only-log.js'
import type { ImmutablePrefix } from './immutable-prefix.js'

export interface ContextManagerOptions {
  foldThreshold: number
  aggressiveThreshold: number
  forceExitThreshold: number
  maxHistoryTokens: number
}

// Turn-end auto-compact: tool results exceeding this threshold are truncated
const TURN_END_RESULT_CAP_TOKENS = 3000
const TURN_END_RESULT_CAP_CHARS = TURN_END_RESULT_CAP_TOKENS * 3.5

export class ContextManager {
  private opts: ContextManagerOptions
  private adapter: ApiAdapter
  private summarizeModel: string

  constructor(opts: ContextManagerOptions, adapter: ApiAdapter, summarizeModel: string) {
    this.opts = opts
    this.adapter = adapter
    this.summarizeModel = summarizeModel
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5)
  }

  getUsageRatio(prefix: ImmutablePrefix, log: AppendOnlyLog): number {
    const prefixText = prefix.text
    const logText = log.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
    const total = this.estimateTokens(prefixText + logText)
    return total / this.opts.maxHistoryTokens
  }

  shouldFold(ratio: number): 'none' | 'normal' | 'aggressive' | 'force' {
    if (ratio >= this.opts.forceExitThreshold) return 'force'
    if (ratio >= this.opts.aggressiveThreshold) return 'aggressive'
    if (ratio >= this.opts.foldThreshold) return 'normal'
    return 'none'
  }

  // Turn-end auto-compact: shrink oversized tool results after a turn completes
  compactToolResults(log: AppendOnlyLog): number {
    let compacted = 0
    const entries = log.all
    for (let i = 0; i < entries.length; i++) {
      const msg = entries[i].message
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TURN_END_RESULT_CAP_CHARS) {
        const truncated = msg.content.slice(0, TURN_END_RESULT_CAP_CHARS) + '\n...[已自动缩略，需要时可重新读取]'
        log.replaceRange(i, i + 1, [{ ...msg, content: truncated }])
        compacted++
      }
    }
    return compacted
  }

  // Fold with shared prefix cache: summary call uses the same prefix as main agent
  async fold(
    log: AppendOnlyLog,
    prefix: ImmutablePrefix,
    level: 'normal' | 'aggressive' | 'force',
  ): Promise<void> {
    const entries = log.all
    if (entries.length < 4) return

    let foldCount: number
    if (level === 'force') {
      foldCount = Math.floor(entries.length * 0.7)
    } else if (level === 'aggressive') {
      foldCount = Math.floor(entries.length * 0.5)
    } else {
      foldCount = Math.floor(entries.length * 0.3)
    }

    const toFold = entries.slice(0, foldCount)
    const kept = entries.slice(foldCount)

    if (toFold.length === 0) return

    const foldText = toFold
      .map(e => {
        const msg = e.message
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        return `[${msg.role}]: ${content}`
      })
      .join('\n')

    // Shared prefix cache: prepend the same system prefix to the summary call
    const summaryPrompt: ChatMessage[] = [
      ...prefix.toMessages(),
      { role: 'user', content: `将以下对话历史压缩为简洁的摘要，保留所有关键信息、决策和上下文。用中文输出。\n\n${foldText}` },
    ]

    const opts: CallOptions = { model: this.summarizeModel, maxTokens: 2048 }
    const response = await this.adapter.chat(summaryPrompt, opts)

    const summaryMessage: ChatMessage = {
      role: 'user',
      content: `[对话摘要]\n${response.content}`,
    }

    log.clear()
    log.append(summaryMessage)
    // Insert compact boundary marker for session persistence
    log.appendCompactBoundary(response.content)
    for (const entry of kept) {
      log.append(entry.message, entry.model)
    }
  }
}
