export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type Message = { role: MessageRole; content: string }

export type JSONSchema = Record<string, unknown>

export type Tool = { name: string; description: string; parameters: JSONSchema }

export type Delta = { text?: string; toolCall?: { name: string; args: unknown } }

export type ChatOptions = { signal?: AbortSignal }

export interface LLMProvider {
  readonly name: string
  chat(messages: Message[], tools?: Tool[], options?: ChatOptions): Promise<AsyncIterable<Delta>>
  isAvailable(): Promise<boolean>
}
