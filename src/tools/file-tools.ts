import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import type { ToolDef } from '../adapters/types.js'

export class ReadFileTool implements Tool {
  def: ToolDef = {
    name: 'read_file',
    description: '读取文件内容。支持指定行范围。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'number', description: '起始行号（从0开始）' },
        limit: { type: 'number', description: '读取行数' },
      },
      required: ['path'],
    },
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = resolve(args.path as string)
    try {
      const content = await readFile(path, 'utf-8')
      const lines = content.split('\n')
      const offset = (args.offset as number) ?? 0
      const limit = (args.limit as number) ?? lines.length
      const sliced = lines.slice(offset, offset + limit)
      const numbered = sliced.map((l, i) => `${offset + i + 1}\t${l}`).join('\n')
      return { output: numbered }
    } catch (err: any) {
      return { output: `无法读取文件 ${path}: ${err.message}`, isError: true }
    }
  }
}

export class WriteFileTool implements Tool {
  def: ToolDef = {
    name: 'write_file',
    description: '写入文件内容。如果文件不存在会自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的内容' },
      },
      required: ['path', 'content'],
    },
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = resolve(args.path as string)
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, args.content as string, 'utf-8')
      return { output: `文件已写入: ${path}` }
    } catch (err: any) {
      return { output: `无法写入文件 ${path}: ${err.message}`, isError: true }
    }
  }
}

export class EditFileTool implements Tool {
  def: ToolDef = {
    name: 'edit_file',
    description: '使用 SEARCH/REPLACE 模式编辑文件。查找 old_string 并替换为 new_string。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要查找的文本' },
        new_string: { type: 'string', description: '替换后的文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = resolve(args.path as string)
    const oldStr = args.old_string as string
    const newStr = args.new_string as string

    try {
      const content = await readFile(path, 'utf-8')
      if (!content.includes(oldStr)) {
        return { output: `未找到匹配文本: "${oldStr.slice(0, 50)}..."`, isError: true }
      }
      const updated = content.replace(oldStr, newStr)
      await writeFile(path, updated, 'utf-8')
      return { output: `文件已编辑: ${path}` }
    } catch (err: any) {
      return { output: `无法编辑文件 ${path}: ${err.message}`, isError: true }
    }
  }
}

export function createFileTools(): Tool[] {
  return [new ReadFileTool(), new WriteFileTool(), new EditFileTool()]
}
