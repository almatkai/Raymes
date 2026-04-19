import type { Intent } from '../shared/intent'

export type { Intent } from '../shared/intent'

const QUESTION_PREFIX_RE = /^(what|why|how|who|when|is|are|can|does)\b/i
const FILE_HINT_RE = /\b(file|folder|path|directory|finder|desktop|documents|downloads)\b/i
const APP_HINT_RE = /\b(open|launch|start)\s+/i

function classifyNaturalLanguageSystem(lower: string): Intent | null {
  if (/\b(disable|turn off|switch off)\b.*\b(wi-?fi|wifi)\b/.test(lower)) {
    return { type: 'system', action: 'wifi-off' }
  }
  if (/\b(turn|switch|set|enable)\b.*\b(wi-?fi|wifi)\b/.test(lower)) {
    return { type: 'system', action: 'wifi-on' }
  }
  if (/\b(enable|turn on|set)\b.*\b(dark mode|dark)\b/.test(lower)) {
    return { type: 'system', action: 'dark-mode-on' }
  }
  if (/\b(disable|turn off)\b.*\b(dark mode|dark)\b/.test(lower)) {
    return { type: 'system', action: 'dark-mode-off' }
  }
  if (/\b(mute|silence)\b/.test(lower)) {
    return { type: 'system', action: 'mute-on' }
  }
  if (/\b(unmute|sound on)\b/.test(lower)) {
    return { type: 'system', action: 'mute-off' }
  }
  return null
}

function parseExtension(input: string): Intent {
  const body = input.slice(1).trim()
  if (!body) {
    return { type: 'extension', name: '', args: '' }
  }
  const space = body.search(/\s/)
  if (space === -1) {
    return { type: 'extension', name: body, args: '' }
  }
  return {
    type: 'extension',
    name: body.slice(0, space),
    args: body.slice(space + 1).trim(),
  }
}

function classifySystem(trimmed: string, lower: string): Intent | null {
  const nl = classifyNaturalLanguageSystem(lower)
  if (nl) return nl

  if (lower === 'quit') {
    return { type: 'system', action: 'quit' }
  }
  if (lower === 'calculator') {
    return { type: 'system', action: 'calculator' }
  }
  if (lower.startsWith('open ')) {
    let target = trimmed.slice(5).trim()
    if (target.endsWith('?')) {
      target = target.slice(0, -1).trim()
    }
    return { type: 'application', target }
  }
  return null
}

function looksLikeAnswer(trimmed: string): boolean {
  if (trimmed.length >= 120) return false
  if (trimmed.endsWith('?')) return true
  return QUESTION_PREFIX_RE.test(trimmed)
}

export async function classifyIntent(raw: string): Promise<Intent> {
  const input = raw.trim()

  if (input.startsWith('/')) {
    return parseExtension(input)
  }

  const lower = input.toLowerCase()
  const system = classifySystem(input, lower)
  if (system) {
    return system
  }

  if (FILE_HINT_RE.test(input)) {
    return { type: 'file', query: input }
  }

  if (APP_HINT_RE.test(input)) {
    const target = input.replace(/^\s*(open|launch|start)\s+/i, '').trim()
    if (target) {
      return { type: 'application', target }
    }
  }

  if (looksLikeAnswer(input)) {
    return { type: 'ai', input }
  }

  if (/\b(explain|summarize|write|draft|generate)\b/i.test(input)) {
    return { type: 'ai', input }
  }

  if (/\b(run|execute|toggle|enable|disable|kill|stop|start|turn)\b/i.test(input)) {
    return { type: 'command', command: input, confidence: 0.62 }
  }

  return { type: 'agent', input }
}
