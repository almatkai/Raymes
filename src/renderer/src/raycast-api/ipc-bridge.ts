import type {
  ExtensionInvokeActionResult,
  ExtensionRunCommandResult,
} from '../../../shared/extensionRuntime'

export async function runExtensionCommand(payload: {
  extensionId: string
  commandName: string
  argumentValues?: Record<string, string>
}): Promise<ExtensionRunCommandResult> {
  return window.raymes.extensionRunCommand(payload)
}

export async function invokeExtensionAction(payload: {
  sessionId: string
  actionId: string
  formValues?: Record<string, string>
}): Promise<ExtensionInvokeActionResult> {
  return window.raymes.extensionInvokeAction(payload)
}

export async function clipboardRead(): Promise<string> {
  return window.raymes.clipboardReadText()
}

export async function clipboardWrite(text: string): Promise<void> {
  await window.raymes.clipboardWriteText(text)
}

export async function openShellTarget(target: string): Promise<void> {
  await window.raymes.shellOpen(target)
}

export async function getPreferences(payload: {
  extensionId: string
  commandName?: string
}): Promise<Record<string, unknown>> {
  return window.raymes.getExtensionPreferences(payload)
}
