import type { ToolDef } from '../adapters/types.js'
import type { Tool } from './types.js'
import { ToolRegistry, type ToolExecutor } from '../core/tool-dispatch.js'
import { createFileTools } from './file-tools.js'
import { createShellTools } from './shell-tools.js'
import { createSearchTools } from './search-tools.js'

export function createDefaultToolRegistry(): { registry: ToolRegistry; defs: ToolDef[] } {
  const registry = new ToolRegistry()
  const defs: ToolDef[] = []

  const allTools: Tool[] = [
    ...createFileTools(),
    ...createShellTools(),
    ...createSearchTools(),
  ]

  for (const tool of allTools) {
    registry.register({
      name: tool.def.name,
      execute: async (args) => {
        const result = await tool.execute(args)
        return result.output
      },
    })
    defs.push(tool.def)
  }

  return { registry, defs }
}
