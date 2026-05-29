import type { ToolCallPart, ChatMessage } from '../adapters/types.js'

export interface ToolExecutor {
  name: string
  execute(args: Record<string, unknown>): Promise<string>
}

export class ToolRegistry {
  private tools: Map<string, ToolExecutor> = new Map()

  register(tool: ToolExecutor): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name)
  }

  get all(): ToolExecutor[] {
    return Array.from(this.tools.values())
  }
}

export class ToolCallRepair {
  repair(rawCalls: unknown[]): ToolCallPart[] {
    const repaired: ToolCallPart[] = []

    for (const raw of rawCalls) {
      const call = raw as any
      if (!call?.function?.name) continue

      let args = call.function.arguments ?? '{}'
      if (typeof args === 'object') {
        args = JSON.stringify(args)
      }

      try {
        JSON.parse(args)
      } catch {
        args = this.tryFixJson(args)
      }

      repaired.push({
        id: call.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: { name: call.function.name, arguments: args },
      })
    }

    return repaired
  }

  private tryFixJson(raw: string): string {
    let fixed = raw.trim()
    if (!fixed.startsWith('{')) fixed = '{' + fixed
    if (!fixed.endsWith('}')) fixed = fixed + '}'
    fixed = fixed.replace(/'/g, '"')
    fixed = fixed.replace(/(\w+)\s*:/g, '"$1":')

    try {
      JSON.parse(fixed)
      return fixed
    } catch {
      return '{}'
    }
  }
}

export class StormBreaker {
  private recentCalls: Map<string, number> = new Map()
  private threshold: number

  constructor(threshold = 3) {
    this.threshold = threshold
  }

  isStorm(toolName: string, args: string): boolean {
    const key = `${toolName}:${args}`
    const count = (this.recentCalls.get(key) ?? 0) + 1
    this.recentCalls.set(key, count)
    return count > this.threshold
  }

  reset(): void {
    this.recentCalls.clear()
  }

  tick(): void {
    for (const [key, count] of this.recentCalls) {
      if (count <= 1) {
        this.recentCalls.delete(key)
      } else {
        this.recentCalls.set(key, count - 1)
      }
    }
  }
}

// Execute a single tool call, returns the result message
async function executeOne(
  call: ToolCallPart,
  registry: ToolRegistry,
  storm: StormBreaker,
): Promise<ChatMessage> {
  if (storm.isStorm(call.function.name, call.function.arguments)) {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: `[System] 工具调用 ${call.function.name} 被风暴检测器阻止，因为检测到重复调用。`,
    }
  }

  const tool = registry.get(call.function.name)
  if (!tool) {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: `[Error] 未知工具: ${call.function.name}`,
    }
  }

  try {
    const args = JSON.parse(call.function.arguments || '{}')
    const output = await tool.execute(args)
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: output,
    }
  } catch (err: any) {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: `[Error] ${err.message}`,
    }
  }
}

// Parallel dispatch: execute all tools concurrently, return results in declared order
export async function dispatchToolCalls(
  calls: ToolCallPart[],
  registry: ToolRegistry,
  repair: ToolCallRepair,
  storm: StormBreaker,
): Promise<ChatMessage[]> {
  const repairedCalls = repair.repair(calls)

  // Parallel execution via Promise.allSettled — results land in declared order
  const settled = await Promise.allSettled(
    repairedCalls.map(call => executeOne(call, registry, storm))
  )

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value
    return {
      role: 'tool' as const,
      tool_call_id: repairedCalls[i].id,
      content: `[Error] ${result.reason?.message ?? 'unknown error'}`,
    }
  })
}
