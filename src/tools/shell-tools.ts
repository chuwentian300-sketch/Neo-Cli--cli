import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool, ToolResult } from './types.js'
import type { ToolDef } from '../adapters/types.js'

const execAsync = promisify(exec)

export class RunCommandTool implements Tool {
  def: ToolDef = {
    name: 'run_command',
    description: '执行 shell 命令并返回输出。注意：某些危险命令可能被阻止。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
      },
      required: ['command'],
    },
  }

  private blockedCommands = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:']

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string
    const cwd = (args.cwd as string) ?? process.cwd()
    const timeout = (args.timeout as number) ?? 30_000

    for (const blocked of this.blockedCommands) {
      if (command.includes(blocked)) {
        return { output: `命令被阻止: 包含危险模式 "${blocked}"`, isError: true }
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 10 })
      let output = ''
      if (stdout) output += stdout
      if (stderr) output += `\n[stderr]\n${stderr}`
      return { output: output.trim() || '(无输出)' }
    } catch (err: any) {
      return { output: `命令执行失败: ${err.message}`, isError: true }
    }
  }
}

export function createShellTools(): Tool[] {
  return [new RunCommandTool()]
}
