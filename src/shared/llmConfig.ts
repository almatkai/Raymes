export type ProviderId = 'openai' | 'openai-compatible' | 'anthropic' | 'ollama' | 'copilot' | 'gemini' | 'opencode' | 'deepseek'

export type LlmTask = 'chat' | 'search' | 'action' | 'voice'

export type LlmConfigRecord = {
  provider?: ProviderId
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
  voiceSttModelId?: 'moonshine-base-en' | 'whisper-base' | 'whisper-small'
  /** Milliseconds to remember palette UI (e.g. Providers) after hide. Default 60000. Use 0 to always reset. */
  uiStateRetentionMs?: number
}
