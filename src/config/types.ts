import { z } from 'zod'

export const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
})

export const ModelConfigSchema = z.object({
  provider: z.enum(['claude', 'openai', 'deepseek']),
  id: z.string().min(1),
})

export const BudgetConfigSchema = z.object({
  dailyLimitUsd: z.number().positive().default(10),
  perTaskLimitUsd: z.number().positive().default(2),
})

export const ContextConfigSchema = z.object({
  foldThreshold: z.number().min(0).max(1).default(0.75),
  aggressiveThreshold: z.number().min(0).max(1).default(0.78),
  forceExitThreshold: z.number().min(0).max(1).default(0.8),
  maxHistoryTokens: z.number().positive().default(100_000),
})

export const AppConfigSchema = z.object({
  providers: z.object({
    claude: ProviderConfigSchema.optional(),
    openai: ProviderConfigSchema.optional(),
    deepseek: ProviderConfigSchema.optional(),
  }),
  models: z.object({
    high: ModelConfigSchema,
    low: ModelConfigSchema,
  }),
  budget: BudgetConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  maxTokens: z.number().positive().default(128000),
  mbti: z.string().optional(),
  thinkingAnimation: z.string().default('bounce'),
  defaultMode: z.enum(['chat', 'code']).default('code'),
  language: z.string().default('zh'),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>
export type ContextConfig = z.infer<typeof ContextConfigSchema>
