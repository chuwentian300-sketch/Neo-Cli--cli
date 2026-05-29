import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { ensureDir, saveSessionMeta, listSessions, type SessionMeta } from './persistence.js'

export class SessionManager {
  private baseDir: string

  constructor(projectDir?: string) {
    this.baseDir = projectDir ?? join(homedir(), '.neo-cli')
  }

  get sessionsDir(): string {
    return join(this.baseDir, 'sessions')
  }

  createSession(): { id: string; logPath: string; metaPath: string } {
    const id = `session_${Date.now()}_${randomBytes(4).toString('hex')}`
    const logPath = join(this.sessionsDir, `${id}.jsonl`)
    return { id, logPath, metaPath: join(this.sessionsDir, `${id}.meta.json`) }
  }

  async saveMeta(meta: SessionMeta): Promise<void> {
    await saveSessionMeta(this.sessionsDir, meta)
  }

  async listRecent(limit = 10): Promise<SessionMeta[]> {
    const all = await listSessions(this.sessionsDir)
    return all.slice(0, limit)
  }

  getLogPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`)
  }

  async init(): Promise<void> {
    await ensureDir(this.sessionsDir)
  }
}
