import type { LlmTask, ProviderId } from '../../shared/llmConfig'
import { AnthropicProvider } from './anthropic'
import { readRawConfig } from './configStore'
import { CopilotProvider } from './copilot'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import type { LLMProvider } from './provider'

export type OpenRayLLMConfig = {
  provider: ProviderId
  apiKey?: string
  baseURL?: string
  model?: string
  openaiCompatibleBaseURL?: string
  geminiApiKey?: string
  copilotGithubToken?: string
  copilotRefreshToken?: string
  copilotExpiresAt?: number
  githubOAuthClientId?: string
  taskProviderOverrides?: Partial<Record<LlmTask, ProviderId>>
  taskModelOverrides?: Partial<Record<LlmTask, string>>
  memoryEnabled?: boolean
  memoryMaxItems?: number
  memoryIncludePrivate?: boolean
  aiActionRequirePermission?: boolean
  aiActionRedactionEnabled?: boolean
  uiStateRetentionMs?: number
}

const DEFAULT_OLLAMA_BASE = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'llama3.2'
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash'
const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

function normalizeFromRaw(raw: Record<string, unknown>): OpenRayLLMConfig {
  const p = raw.provider
  const hasCopilotToken = typeof raw.copilotGithubToken === 'string' && raw.copilotGithubToken.length > 0
  const provider: ProviderId =
    p === 'openai' ||
    p === 'openai-compatible' ||
    p === 'anthropic' ||
    p === 'ollama' ||
    p === 'copilot' ||
    p === 'gemini' ||
    p === 'deepseek'
      ? p
      : hasCopilotToken
        ? 'copilot'
        : 'ollama'
  return {
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : undefined,
    openaiCompatibleBaseURL:
      typeof raw.openaiCompatibleBaseURL === 'string' ? raw.openaiCompatibleBaseURL : undefined,
    geminiApiKey: typeof raw.geminiApiKey === 'string' ? raw.geminiApiKey : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    copilotGithubToken: typeof raw.copilotGithubToken === 'string' ? raw.copilotGithubToken : undefined,
    copilotRefreshToken: typeof raw.copilotRefreshToken === 'string' ? raw.copilotRefreshToken : undefined,
    copilotExpiresAt: typeof raw.copilotExpiresAt === 'number' ? raw.copilotExpiresAt : undefined,
    githubOAuthClientId: typeof raw.githubOAuthClientId === 'string' ? raw.githubOAuthClientId : undefined,
    taskProviderOverrides:
      typeof raw.taskProviderOverrides === 'object' && raw.taskProviderOverrides
        ? (raw.taskProviderOverrides as Partial<Record<LlmTask, ProviderId>>)
        : undefined,
    taskModelOverrides:
      typeof raw.taskModelOverrides === 'object' && raw.taskModelOverrides
        ? (raw.taskModelOverrides as Partial<Record<LlmTask, string>>)
        : undefined,
    memoryEnabled: typeof raw.memoryEnabled === 'boolean' ? raw.memoryEnabled : undefined,
    memoryMaxItems: typeof raw.memoryMaxItems === 'number' ? raw.memoryMaxItems : undefined,
    memoryIncludePrivate: typeof raw.memoryIncludePrivate === 'boolean' ? raw.memoryIncludePrivate : undefined,
    aiActionRequirePermission:
      typeof raw.aiActionRequirePermission === 'boolean' ? raw.aiActionRequirePermission : undefined,
    aiActionRedactionEnabled:
      typeof raw.aiActionRedactionEnabled === 'boolean' ? raw.aiActionRedactionEnabled : undefined,
    uiStateRetentionMs: typeof raw.uiStateRetentionMs === 'number' ? raw.uiStateRetentionMs : undefined,
  }
}

export function readLLMConfig(): OpenRayLLMConfig {
  const raw = readRawConfig()
  if (Object.keys(raw).length === 0) {
    return { provider: 'ollama', baseURL: DEFAULT_OLLAMA_BASE, model: DEFAULT_OLLAMA_MODEL }
  }
  const n = normalizeFromRaw(raw)
  if (n.provider === 'ollama') {
    return {
      ...n,
      baseURL: n.baseURL ?? DEFAULT_OLLAMA_BASE,
      model: n.model ?? DEFAULT_OLLAMA_MODEL,
    }
  }
  if (n.provider === 'gemini') {
    return {
      ...n,
      baseURL: n.baseURL ?? DEFAULT_GEMINI_BASE,
      model: n.model ?? DEFAULT_GEMINI_MODEL,
    }
  }
  if (n.provider === 'deepseek') {
    return {
      ...n,
      baseURL: n.baseURL ?? DEFAULT_DEEPSEEK_BASE,
      model: n.model ?? DEFAULT_DEEPSEEK_MODEL,
    }
  }
  return n
}

export function buildProviderForId(id: ProviderId, cfg: OpenRayLLMConfig): LLMProvider {
  return buildProvider({ ...cfg, provider: id })
}

function buildProvider(cfg: OpenRayLLMConfig): LLMProvider {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIProvider(
        cfg.baseURL ?? 'https://api.openai.com/v1',
        cfg.apiKey ?? '',
        cfg.model ?? 'gpt-4o-mini',
      )
    case 'openai-compatible':
      return new OpenAIProvider(
        cfg.openaiCompatibleBaseURL ?? cfg.baseURL ?? 'https://api.openai.com/v1',
        cfg.apiKey ?? '',
        cfg.model ?? 'gpt-4o-mini',
      )
    case 'anthropic':
      return new AnthropicProvider(
        cfg.apiKey ?? '',
        cfg.model ?? 'claude-3-5-haiku-20241022',
        cfg.baseURL,
      )
    case 'ollama':
      return new OllamaProvider(cfg.baseURL ?? DEFAULT_OLLAMA_BASE, cfg.model ?? DEFAULT_OLLAMA_MODEL)
    case 'copilot':
      return new CopilotProvider(cfg.model ?? 'gpt-4o')
    case 'gemini':
      return new OpenAIProvider(
        cfg.baseURL ?? DEFAULT_GEMINI_BASE,
        cfg.geminiApiKey ?? cfg.apiKey ?? '',
        cfg.model ?? DEFAULT_GEMINI_MODEL,
      )
    case 'deepseek':
      return new OpenAIProvider(
        cfg.baseURL ?? DEFAULT_DEEPSEEK_BASE,
        cfg.apiKey ?? '',
        cfg.model ?? DEFAULT_DEEPSEEK_MODEL,
      )
    default:
      return new OllamaProvider(DEFAULT_OLLAMA_BASE, DEFAULT_OLLAMA_MODEL)
  }
}

let cacheKey = ''
let active: LLMProvider | null = null

export function invalidateProviderCache(): void {
  cacheKey = ''
  active = null
}

export function getProvider(): LLMProvider {
  const cfg = readLLMConfig()
  const key = JSON.stringify(cfg)
  if (active && key === cacheKey) return active
  active = buildProvider(cfg)
  cacheKey = key
  return active
}

export function getProviderForTask(task: LlmTask): LLMProvider {
  const cfg = readLLMConfig()
  const providerOverride = cfg.taskProviderOverrides?.[task]
  const modelOverride = cfg.taskModelOverrides?.[task]
  const targetProvider = providerOverride ?? cfg.provider
  const merged: OpenRayLLMConfig = {
    ...cfg,
    provider: targetProvider,
    model: modelOverride ?? cfg.model,
  }
  return buildProvider(merged)
}
