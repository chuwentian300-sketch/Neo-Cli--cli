import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import type { ToolDef } from '../adapters/types.js'

export class GrepTool implements Tool {
  def: ToolDef = {
    name: 'grep',
    description: '在文件中搜索文本内容，支持正则表达式。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（支持正则）' },
        path: { type: 'string', description: '搜索目录，默认当前目录' },
        glob: { type: 'string', description: '文件过滤，如 "*.ts"' },
        maxResults: { type: 'number', description: '最大结果数，默认 50' },
      },
      required: ['pattern'],
    },
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = new RegExp(args.pattern as string, 'gi')
    const searchPath = resolve((args.path as string) ?? '.')
    const maxResults = (args.maxResults as number) ?? 50

    try {
      // 超时机制：30秒
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('搜索超时 (30s)')), 30_000)
      )
      const results = await Promise.race([
        this.searchDir(searchPath, pattern, maxResults, args.glob as string | undefined),
        timeout,
      ])
      if (results.length === 0) {
        return { output: '未找到匹配结果' }
      }
      return { output: results.join('\n') }
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true }
    }
  }

  private async searchDir(
    dir: string,
    pattern: RegExp,
    max: number,
    glob?: string,
    depth = 0,
  ): Promise<string[]> {
    if (depth > 5 || max <= 0) return []

    const results: string[] = []
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (results.length >= max) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        const sub = await this.searchDir(fullPath, pattern, max - results.length, glob, depth + 1)
        results.push(...sub)
      } else if (entry.isFile()) {
        if (glob && !this.matchGlob(entry.name, glob)) continue

        const content = await readFile(fullPath, 'utf-8').catch(() => '')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= max) break
          if (pattern.test(lines[i])) {
            results.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`)
          }
          pattern.lastIndex = 0
        }
      }
    }

    return results
  }

  private matchGlob(filename: string, glob: string): boolean {
    const regex = new RegExp('^' + glob.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return regex.test(filename)
  }
}

export class GlobTool implements Tool {
  def: ToolDef = {
    name: 'glob',
    description: '按文件名模式查找文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名模式，如 "**/*.ts"' },
        path: { type: 'string', description: '搜索目录，默认当前目录' },
      },
      required: ['pattern'],
    },
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args.pattern as string
    const searchPath = resolve((args.path as string) ?? '.')

    try {
      // 超时机制：30秒
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('搜索超时 (30s)')), 30_000)
      )
      const files = await Promise.race([
        this.findFiles(searchPath, pattern),
        timeout,
      ])
      if (files.length === 0) {
        return { output: '未找到匹配文件' }
      }
      return { output: files.join('\n') }
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true }
    }
  }

  private async findFiles(dir: string, pattern: string, depth = 0): Promise<string[]> {
    if (depth > 10) return []

    const results: string[] = []
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        const sub = await this.findFiles(fullPath, pattern, depth + 1)
        results.push(...sub)
      } else if (entry.isFile()) {
        if (this.matchGlob(entry.name, pattern)) {
          results.push(fullPath)
        }
      }
    }

    return results
  }

  private matchGlob(filename: string, glob: string): boolean {
    const regex = new RegExp('^' + glob.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return regex.test(filename)
  }
}

export function createSearchTools(): Tool[] {
  return [new GrepTool(), new GlobTool()]
}
