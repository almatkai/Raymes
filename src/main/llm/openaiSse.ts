import type { Delta } from './provider'

type ToolPart = { id?: string; name?: string; args: string }

export async function* parseOpenAISSE(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<Delta, void, unknown> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('OpenAI-compatible: empty response body')
  const decoder = new TextDecoder()
  let buffer = ''
  const toolParts = new Map<number, ToolPart>()

  const processPayload = function* (json: unknown): Generator<Delta, void, unknown> {
    const root = json as {
      choices?: Array<{
        delta?: {
          content?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            type?: string
            function?: { name?: string; arguments?: string | null }
          }>
        }
        finish_reason?: string | null
      }>
    }
    const choice = root.choices?.[0]
    if (!choice) return
    const delta = choice.delta
    if (delta?.content) {
      yield { text: delta.content }
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        const cur: ToolPart = toolParts.get(idx) ?? { args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        toolParts.set(idx, cur)
      }
    }
    if (choice.finish_reason === 'tool_calls') {
      const ordered = Array.from(toolParts.entries()).sort((a, b) => a[0] - b[0])
      for (const [, tc] of ordered) {
        if (!tc.name) continue
        let args: unknown = {}
        if (tc.args.trim()) {
          try {
            args = JSON.parse(tc.args) as unknown
          } catch {
            args = tc.args
          }
        }
        yield { toolCall: { name: tc.name, args } }
      }
      toolParts.clear()
    }
  }

  while (true) {
    if (signal?.aborted) break
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const line = rawLine.trimEnd()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trimStart()
      if (data === '[DONE]') continue
      let json: unknown
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      yield* processPayload(json)
    }
  }

  if (toolParts.size > 0) {
    for (const [, tc] of Array.from(toolParts.entries()).sort((a, b) => a[0] - b[0])) {
      if (!tc.name) continue
      let args: unknown = {}
      if (tc.args.trim()) {
        try {
          args = JSON.parse(tc.args) as unknown
        } catch {
          args = tc.args
        }
      }
      yield { toolCall: { name: tc.name, args } }
    }
    toolParts.clear()
  }
}
