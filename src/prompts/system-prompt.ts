import { MIMO_PROTOCOL } from './mimo-protocol.js'
import {
  CODING_GUIDELINES,
  TOOL_CALL_OPTIMIZATION,
  LONG_CONTEXT_MANAGEMENT,
  NEGATIVE_CLAIM_RULE,
  PLAN_MODE_INSTRUCTIONS,
  EXECUTE_MODE_INSTRUCTIONS,
} from './fragments.js'
import { MBTI_PROMPTS, type MbtiType } from './mbti.js'

export interface SystemPromptOptions {
  mode: 'chat' | 'code' | 'plan'
  language?: string
  modelTier?: 'high' | 'low'
  mbti?: string
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const parts: string[] = []

  parts.push(BASE_AGENT_INSTRUCTIONS)
  parts.push(MIMO_PROTOCOL)

  if (opts.mbti && MBTI_PROMPTS[opts.mbti as MbtiType]) {
    parts.push(MBTI_PROMPTS[opts.mbti as MbtiType])
  }

  if (opts.mode === 'code' || opts.mode === 'plan') {
    parts.push(CODING_GUIDELINES)
    parts.push(TOOL_CALL_OPTIMIZATION)
    parts.push(LONG_CONTEXT_MANAGEMENT)
    parts.push(NEGATIVE_CLAIM_RULE)
  }

  if (opts.mode === 'plan') {
    parts.push(PLAN_MODE_INSTRUCTIONS)
  } else if (opts.mode === 'code') {
    parts.push(EXECUTE_MODE_INSTRUCTIONS)
  }

  return parts.join('\n\n')
}

const BASE_AGENT_INSTRUCTIONS = `你是一个强大的AI编程助手，由 Neo-CLI 驱动。你可以读写文件、执行命令、搜索代码，帮助用户完成各种编程任务。

核心能力：
- 读取和编辑文件（read_file, edit_file, write_file）
- 执行 shell 命令（run_command）
- 搜索文件内容和文件名（grep, glob）
- 项目记忆和上下文管理

工作原则：
- 先理解需求，再动手执行
- 优先使用最简单的方案
- 每次修改后验证结果
- 遇到不确定时，主动询问用户
- 保持代码风格与现有代码一致`
