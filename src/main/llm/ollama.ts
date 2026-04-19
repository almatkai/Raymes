import type { ChatOptions, Delta, LLMProvider, Message, Tool } from './provider'

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function toOllamaMessages(messages: Message[]): Array<{ role: string; content: string }> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'user', content: `[tool]\n${m.content}` }
    }
    return { role: m.role, content: m.content }
  })
}

function toOllamaTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

async function* parseOllamaStream(res: Response, signal?: AbortSignal): AsyncGenerator<Delta> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Ollama: empty response body')
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    if (signal?.aborted) break
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let row: unknown
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const err = (row as { error?: string }).error
      if (typeof err === 'string' && err) {
        throw new Error(err)
      }
      const msg = (row as { message?: { role?: string; content?: string } }).message
      if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 0) {
        yield { text: msg.content }
      }
      const toolCalls = (row as { message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } })
        .message?.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const name = tc.function?.name
          if (!name) continue
          const raw = tc.function?.arguments
          let args: unknown = raw
          if (typeof raw === 'string') {
            try {
              args = JSON.parse(raw) as unknown
            } catch {
              args = raw
            }
          }
          yield { toolCall: { name, args } }
        }
      }
    }
  }
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama'

  constructor(
    private readonly baseURL: string,
    private readonly model: string,
  ) {}

  async chat(messages: Message[], tools?: Tool[], options?: ChatOptions): Promise<AsyncIterable<Delta>> {
    const url = `${trimSlash(this.baseURL)}/api/chat`
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(messages),
      stream: true,
    }
    if (tools?.length) {
      body.tools = toOllamaTools(tools)
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Ollama error ${res.status}: ${t.slice(0, 500)}`)
    }
    return parseOllamaStream(res, options?.signal)
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${trimSlash(this.baseURL)}/api/tags`
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) })
      return res.ok
    } catch {
      return false
    }
  }
}
