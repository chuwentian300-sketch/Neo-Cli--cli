import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'

export interface SessionMeta {
  id: string
  createdAt: number
  updatedAt: number
  turnCount: number
  totalCost: number
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as T)
  } catch {
    return []
  }
}

export async function appendJsonl<T>(path: string, entry: T): Promise<void> {
  await ensureDir(join(path, '..'))
  await writeFile(path, JSON.stringify(entry) + '\n', { flag: 'a' })
}

export async function listSessions(sessionsDir: string): Promise<SessionMeta[]> {
  const files = await readdir(sessionsDir).catch(() => [])
  const metas: SessionMeta[] = []
  const seenIds = new Set<string>()

  // Read .meta.json files first
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue
    try {
      const raw = await readFile(join(sessionsDir, file), 'utf-8')
      const meta = JSON.parse(raw) as SessionMeta
      metas.push(meta)
      seenIds.add(meta.id)
    } catch { /* skip */ }
  }

  // Fallback: derive info from .jsonl files that have no meta
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const id = file.replace('.jsonl', '')
    if (seenIds.has(id)) continue
    try {
      const raw = await readFile(join(sessionsDir, file), 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const entries = lines.map(l => JSON.parse(l))
      const userTurns = entries.filter((e: any) => e.message?.role === 'user').length
      const st = await stat(join(sessionsDir, file))
      metas.push({
        id,
        createdAt: st.birthtimeMs || st.mtimeMs,
        updatedAt: st.mtimeMs,
        turnCount: userTurns,
        totalCost: 0,
      })
    } catch { /* skip */ }
  }

  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveSessionMeta(sessionsDir: string, meta: SessionMeta): Promise<void> {
  await ensureDir(sessionsDir)
  await writeFile(join(sessionsDir, `${meta.id}.meta.json`), JSON.stringify(meta, null, 2))
}
