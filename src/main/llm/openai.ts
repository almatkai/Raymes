import type { ChatOptions, Delta, LLMProvider, Message, Tool } from './provider'
import { parseOpenAISSE } from './openaiSse'

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function toOpenAIMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

function toOpenAITools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'

  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(messages: Message[], tools?: Tool[], options?: ChatOptions): Promise<AsyncIterable<Delta>> {
    const url = `${trimSlash(this.baseURL)}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(messages),
      stream: true,
    }
    if (tools?.length) {
      body.tools = toOpenAITools(tools)
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`OpenAI error ${res.status}: ${errBody.slice(0, 500)}`)
    }
    return parseOpenAISSE(res, options?.signal)
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey.trim()) return false
    try {
      const url = `${trimSlash(this.baseURL)}/models`
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(4000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
