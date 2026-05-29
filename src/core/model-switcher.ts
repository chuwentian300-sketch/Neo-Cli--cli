import type { ModelConfig } from '../adapters/types.js'

const PLAN_KEYWORDS_ZH = ['规划', '设计', '架构', '方案', '分析', '评估', '方案', '策略', '拆解', '分解']
const PLAN_KEYWORDS_EN = ['plan', 'design', 'architect', 'analyze', 'evaluate', 'strategy', 'breakdown', 'approach']

export interface ConversationContext {
  turnCount: number
  hasActivePlan: boolean
  lastToolCalls: string[]
}

export class ModelSwitcher {
  private highTier: ModelConfig
  private lowTier: ModelConfig
  private planDuration: number
  private turnsSincePlan: number

  constructor(highTier: ModelConfig, lowTier: ModelConfig, planDuration = 3) {
    this.highTier = highTier
    this.lowTier = lowTier
    this.planDuration = planDuration
    this.turnsSincePlan = 0
  }

  selectModel(userMessage: string, context: ConversationContext): ModelConfig {
    if (context.turnCount === 0) {
      this.turnsSincePlan = 0
      return this.highTier
    }

    const lower = userMessage.toLowerCase()
    const isPlanRequest =
      PLAN_KEYWORDS_ZH.some(kw => userMessage.includes(kw)) ||
      PLAN_KEYWORDS_EN.some(kw => lower.includes(kw))

    if (isPlanRequest) {
      this.turnsSincePlan = 0
      return this.highTier
    }

    if (this.turnsSincePlan < this.planDuration && context.hasActivePlan) {
      this.turnsSincePlan++
      return this.highTier
    }

    if (userMessage.length > 500) {
      return this.highTier
    }

    if (context.lastToolCalls.length > 0) {
      return this.lowTier
    }

    return this.lowTier
  }

  reset(): void {
    this.turnsSincePlan = 0
  }
}
