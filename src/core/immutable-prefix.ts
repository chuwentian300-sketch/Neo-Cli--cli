import { createHash } from 'node:crypto'
import type { ChatMessage, ToolDef } from '../adapters/types.js'
import { buildSystemPrompt, type SystemPromptOptions } from '../prompts/system-prompt.js'

export interface PrefixOptions {
  mode: 'chat' | 'code' | 'plan'
  language?: string
  tools?: ToolDef[]
  mbti?: string
}

export class ImmutablePrefix {
  private opts: PrefixOptions
  private systemText: string
  private toolDefs: ToolDef[]
  private _messages: ChatMessage[] | null = null
  private _fingerprint: string | null = null

  constructor(opts: PrefixOptions) {
    this.opts = opts
    this.systemText = buildSystemPrompt({ mode: opts.mode, language: opts.language, mbti: opts.mbti })
    this.toolDefs = opts.tools ?? []
  }

  get text(): string {
    return this.systemText
  }

  get tools(): ToolDef[] {
    return this.toolDefs
  }

  get fingerprint(): string {
    if (!this._fingerprint) {
      this._fingerprint = this.computeFingerprint()
    }
    return this._fingerprint
  }

  private computeFingerprint(): string {
    const blob = JSON.stringify({
      system: this.systemText,
      tools: this.toolDefs,
    })
    return createHash('sha256').update(blob).digest('hex').slice(0, 16)
  }

  setMbti(mbti: string | undefined) {
    this.opts.mbti = mbti
    this.systemText = buildSystemPrompt({ mode: this.opts.mode, language: this.opts.language, mbti })
    this._messages = null
    this._fingerprint = null
  }

  toMessages(): ChatMessage[] {
    if (!this._messages) {
      this._messages = [{ role: 'system', content: this.systemText }]
    }
    return this._messages
  }

  equals(other: ImmutablePrefix): boolean {
    return this.fingerprint === other.fingerprint
  }
}
