import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { AppConfigSchema, type AppConfig } from './types.js'

const GLOBAL_DIR = join(homedir(), '.neo-cli')
const GLOBAL_FILE = join(GLOBAL_DIR, 'config.json')

function projectDir(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.neo-cli')
}
function projectFile(cwd?: string): string {
  return join(projectDir(cwd), 'config.json')
}
function localFile(cwd?: string): string {
  return join(projectDir(cwd), 'config.local.json')
}

// Deep merge: project overrides global, local overrides project
function deepMerge(base: any, override: any): any {
  if (!override) return base
  if (!base) return override
  const result = { ...base }
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], override[key])
    } else if (override[key] !== undefined && override[key] !== null) {
      result[key] = override[key]
    }
  }
  return result
}

async function readJson(path: string): Promise<any | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function loadConfig(cwd?: string): Promise<AppConfig> {
  const global = await readJson(GLOBAL_FILE)
  if (!global) throw new Error(`Config not found at ${GLOBAL_FILE}. Run "neo init" first.`)

  const project = await readJson(projectFile(cwd))
  const local = await readJson(localFile(cwd))

  // Merge order: global → project → local
  let merged = global
  if (project) merged = deepMerge(merged, project)
  if (local) merged = deepMerge(merged, local)

  return AppConfigSchema.parse(merged)
}

// Always save to global config
export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(GLOBAL_DIR, { recursive: true })
  await writeFile(GLOBAL_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

// Save to project-level config
export async function saveProjectConfig(config: Partial<AppConfig>, cwd?: string): Promise<void> {
  const dir = projectDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(projectFile(cwd), JSON.stringify(config, null, 2), 'utf-8')
}

export async function initConfig(): Promise<void> {
  await mkdir(GLOBAL_DIR, { recursive: true })
  const template: AppConfig = {
    providers: {
      deepseek: { apiKey: 'sk-your-key-here' },
    },
    models: {
      high: { provider: 'deepseek', id: 'deepseek-v4-pro' },
      low: { provider: 'deepseek', id: 'deepseek-v4-flash' },
    },
    budget: { dailyLimitUsd: 10, perTaskLimitUsd: 2 },
    context: {
      foldThreshold: 0.75,
      aggressiveThreshold: 0.78,
      forceExitThreshold: 0.8,
      maxHistoryTokens: 100_000,
    },
    defaultMode: 'code',
    language: 'zh',
    maxTokens: 128000,
    thinkingAnimation: 'bounce',
  }
  await writeFile(GLOBAL_FILE, JSON.stringify(template, null, 2), 'utf-8')
  console.log(`Config created at ${GLOBAL_FILE}`)
}

export function getApiKey(config: AppConfig, provider: string): string | undefined {
  return (
    config.providers[provider as keyof typeof config.providers]?.apiKey ??
    process.env[`${provider.toUpperCase()}_API_KEY`] ??
    undefined
  )
}
