import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryEntry, MemoryType, MemoryStore } from './types.js'

export class FileMemoryStore implements MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map()
  private dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, 'memories.json'), 'utf-8')
      const arr = JSON.parse(raw) as MemoryEntry[]
      for (const entry of arr) {
        this.entries.set(entry.name, entry)
      }
    } catch { /* no memories yet */ }
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const arr = Array.from(this.entries.values())
    await writeFile(join(this.dir, 'memories.json'), JSON.stringify(arr, null, 2))
  }

  get(name: string): MemoryEntry | undefined {
    return this.entries.get(name)
  }

  getAll(type?: MemoryType): MemoryEntry[] {
    const all = Array.from(this.entries.values())
    if (type) return all.filter(e => e.type === type)
    return all
  }

  set(entry: Omit<MemoryEntry, 'createdAt' | 'updatedAt'>): void {
    const existing = this.entries.get(entry.name)
    const now = Date.now()
    this.entries.set(entry.name, {
      ...entry,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  delete(name: string): boolean {
    return this.entries.delete(name)
  }

  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase()
    return Array.from(this.entries.values()).filter(
      e =>
        e.name.toLowerCase().includes(lower) ||
        e.description.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower),
    )
  }
}
