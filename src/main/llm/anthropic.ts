import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  Tool as AnthropicToolSpec,
} from '@anthropic-ai/sdk/resources/messages'
import type { ChatOptions, Delta, LLMProvider, Message, Tool } from './provider'

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function splitAnthropicMessages(messages: Message[]): {
  system?: string
  messages: MessageParam[]
} {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const system = systemParts.length ? systemParts.join('\n\n') : undefined

  const out: MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({ role: 'user', content: `[tool]\n${m.content}` })
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  return { system, messages: out }
}

function toAnthropicTools(tools: Tool[]): AnthropicToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as AnthropicToolSpec['input_schema'],
  }))
}

async function* mapAnthropicStream(
  stream: AsyncIterable<RawMessageStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<Delta> {
  const toolJsonByIndex = new Map<number, string>()
  const toolNameByIndex = new Map<number, string>()

  for await (const evt of stream) {
    if (signal?.aborted) break

    if (evt.type === 'content_block_start') {
      const block = evt.content_block
      if (block.type === 'tool_use') {
        toolNameByIndex.set(evt.index, block.name)
        toolJsonByIndex.set(evt.index, '')
      }
    }

    if (evt.type === 'content_block_delta') {
      const d = evt.delta
      if (d.type === 'text_delta') {
        yield { text: d.text }
      }
      if (d.type === 'input_json_delta') {
        const cur = toolJsonByIndex.get(evt.index) ?? ''
        toolJsonByIndex.set(evt.index, cur + d.partial_json)
      }
    }

    if (evt.type === 'content_block_stop') {
      const name = toolNameByIndex.get(evt.index)
      if (name === undefined) continue
      const jsonStr = toolJsonByIndex.get(evt.index) ?? ''
      let args: unknown = {}
      if (jsonStr.trim()) {
        try {
          args = JSON.parse(jsonStr) as unknown
        } catch {
          args = jsonStr
        }
      }
      yield { toolCall: { name, args } }
      toolNameByIndex.delete(evt.index)
      toolJsonByIndex.delete(evt.index)
    }
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic
  private readonly apiBase: string

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    baseURL?: string,
  ) {
    this.apiBase = trimSlash(baseURL ?? 'https://api.anthropic.com')
    this.client = new Anthropic({
      apiKey,
      baseURL: this.apiBase,
    })
  }

  async chat(messages: Message[], tools?: Tool[], options?: ChatOptions): Promise<AsyncIterable<Delta>> {
    const { system, messages: mapped } = splitAnthropicMessages(messages)
    const params: MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: 4096,
      messages: mapped,
      stream: true,
    }
    if (system) params.system = system
    if (tools?.length) {
      params.tools = toAnthropicTools(tools)
    }

    const stream = await this.client.messages.create(params, { signal: options?.signal })
    return mapAnthropicStream(stream, options?.signal)
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey.trim()) return false
    try {
      const res = await fetch(`${this.apiBase}/v1/models`, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(4000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
