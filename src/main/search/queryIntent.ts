export type SearchIntentType = 'command' | 'app' | 'file' | 'extension-command' | 'ai' | 'general'

export type SearchIntent = {
  type: SearchIntentType
  normalizedQuery: string
  confidence: number
}

const AI_HINT_RE = /^(ask|explain|summarize|write|draft|generate)\b/i

export function parseSearchIntent(query: string): SearchIntent {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return { type: 'general', normalizedQuery: '', confidence: 0 }
  }

  if (normalizedQuery.startsWith('/')) {
    return { type: 'extension-command', normalizedQuery, confidence: 0.95 }
  }

  if (/\b(file|folder|path|open\s+~|open\s+\/)/.test(normalizedQuery)) {
    return { type: 'file', normalizedQuery, confidence: 0.78 }
  }

  if (/\b(app|application|launch|open\s+[a-z])/i.test(normalizedQuery)) {
    return { type: 'app', normalizedQuery, confidence: 0.72 }
  }

  if (/\b(turn|enable|disable|toggle|run|kill|stop|start|mute|unmute)\b/.test(normalizedQuery)) {
    return { type: 'command', normalizedQuery, confidence: 0.8 }
  }

  if (AI_HINT_RE.test(normalizedQuery) || normalizedQuery.endsWith('?')) {
    return { type: 'ai', normalizedQuery, confidence: 0.65 }
  }

  return { type: 'general', normalizedQuery, confidence: 0.45 }
}
