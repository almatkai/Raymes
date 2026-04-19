/**
 * How the AI chat surface was opened from the command bar (or global ⌘N).
 * Drives first-frame behaviour: submit a prompt, browse history, or force
 * a fresh session.
 */
export type AiChatBoot =
  | { kind: 'submit'; prompt: string }
  | { kind: 'panel' }
  | { kind: 'newChat' }
  | { kind: 'resume'; sessionId: string }

/** Dispatched from App when ⌘N fires on the command surface (quick note). */
export const RAYMES_QUICK_NOTE_SHORTCUT_EVENT = 'raymes:quick-note-shortcut'

/** Dispatched from App when ⌘N should start a new chat (AI chat surface). */
export const RAYMES_AI_NEW_CHAT_EVENT = 'raymes:ai-new-chat'
