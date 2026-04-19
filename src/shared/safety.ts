/** Safety layer shared types. Every potentially destructive action the
 *  palette can execute flows through this registry so the UI can explain
 *  consequences, require confirmation, and audit what actually happened. */

export type SafetyRisk = 'low' | 'medium' | 'high'

export type SafetyActionId =
  | 'shell.run'
  | 'process.kill'
  | 'port.kill'
  | 'system.shutdown'
  | 'system.restart'
  | 'system.sleep'
  | 'system.logout'
  | 'trash.empty'
  | 'app.quit'
  | 'extension.install'
  | 'extension.uninstall'
  | 'native.command'

export type SafetyDescriptor = {
  id: SafetyActionId
  /** Short verb like "Kill process" or "Empty Trash". */
  title: string
  /** One-line description shown in the confirmation modal. */
  summary: string
  risk: SafetyRisk
  /** If true, a native confirmation dialog must be accepted first. */
  requiresConfirmation: boolean
  /** Free-form context the UI can append to the confirmation prompt. */
  details?: string
}

export type SafetyLogEntry = {
  id: string
  action: SafetyActionId
  title: string
  risk: SafetyRisk
  at: number
  ok: boolean
  message?: string
  /** Serialized context — kept short; large payloads are truncated. */
  context?: Record<string, unknown>
}

export type SafetyConfirmResult = { accepted: boolean }

export type SafetyExecuteRequest = {
  descriptor: SafetyDescriptor
  /** Arbitrary context data available to the UI prompt (port number,
   *  process name, command text, etc). */
  context?: Record<string, unknown>
}
