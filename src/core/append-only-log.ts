import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage } from '../adapters/types.js'

export interface LogEntry {
  message: ChatMessage
  timestamp: number
  model?: string
  type?: 'message' | 'compact_boundary'
}

export class AppendOnlyLog {
  private entries: LogEntry[] = []
  private filePath: string | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? null
  }

  get length(): number {
    return this.entries.length
  }

  get all(): LogEntry[] {
    return [...this.entries]
  }

  get messages(): ChatMessage[] {
    return this.entries.filter(e => e.type !== 'compact_boundary').map(e => e.message)
  }

  get last(): LogEntry | undefined {
    return this.entries[this.entries.length - 1]
  }

  append(message: ChatMessage, model?: string): LogEntry {
    const stored: ChatMessage = { ...message }
    delete stored.reasoning_content
    const entry: LogEntry = { message: stored, timestamp: Date.now(), model, type: 'message' }
    this.entries.push(entry)
    return entry
  }

  // Insert a compact boundary marker (signals where summarization happened)
  appendCompactBoundary(summary: string): LogEntry {
    const entry: LogEntry = {
      message: { role: 'user', content: `[compact_boundary]\n${summary}` },
      timestamp: Date.now(),
      type: 'compact_boundary',
    }
    this.entries.push(entry)
    return entry
  }

  async persist(): Promise<void> {
    if (!this.filePath) return
    await mkdir(dirname(this.filePath), { recursive: true })
    const lines = this.entries.map(e => JSON.stringify(e))
    await writeFile(this.filePath, lines.join('\n') + '\n', 'utf-8')
  }

  async load(): Promise<void> {
    if (!this.filePath) return
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      this.entries = lines.map(l => JSON.parse(l) as LogEntry)
    } catch {
      this.entries = []
    }
  }

  replaceRange(start: number, end: number, replacement: ChatMessage[]): void {
    const replacementEntries: LogEntry[] = replacement.map(m => ({
      message: m,
      timestamp: Date.now(),
      type: 'message' as const,
    }))
    this.entries.splice(start, end - start, ...replacementEntries)
  }

  slice(start: number, end?: number): LogEntry[] {
    return this.entries.slice(start, end)
  }

  clear(): void {
    this.entries = []
  }
}
