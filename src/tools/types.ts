import type { ToolDef } from '../adapters/types.js'

export interface ToolResult {
  output: string
  isError?: boolean
}

export interface Tool {
  def: ToolDef
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

export function toolResultToString(result: ToolResult): string {
  return result.isError ? `[Error] ${result.output}` : result.output
}
