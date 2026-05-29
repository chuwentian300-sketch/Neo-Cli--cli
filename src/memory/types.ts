export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryEntry {
  name: string
  type: MemoryType
  description: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface MemoryStore {
  get(name: string): MemoryEntry | undefined
  getAll(type?: MemoryType): MemoryEntry[]
  set(entry: Omit<MemoryEntry, 'createdAt' | 'updatedAt'>): void
  delete(name: string): boolean
  search(query: string): MemoryEntry[]
}
