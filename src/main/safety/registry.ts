import type { SafetyActionId, SafetyDescriptor } from '../../shared/safety'

/** Central allowlist. Every destructive capability has exactly one
 *  descriptor here. Adding a new action requires appending an entry —
 *  the runtime will refuse to confirm/execute actions that aren't
 *  registered. */
const DESCRIPTORS: Record<SafetyActionId, SafetyDescriptor> = {
  'shell.run': {
    id: 'shell.run',
    title: 'Run shell command',
    summary: 'Execute a shell command in your user environment.',
    risk: 'high',
    requiresConfirmation: true,
  },
  'process.kill': {
    id: 'process.kill',
    title: 'Kill process',
    summary: 'Forcibly terminate a running process.',
    risk: 'high',
    requiresConfirmation: true,
  },
  'port.kill': {
    id: 'port.kill',
    title: 'Kill listener on port',
    summary: 'Terminate the process listening on this TCP port.',
    risk: 'medium',
    requiresConfirmation: true,
  },
  'system.shutdown': {
    id: 'system.shutdown',
    title: 'Shut down Mac',
    summary: 'Shut the computer down immediately.',
    risk: 'high',
    requiresConfirmation: true,
  },
  'system.restart': {
    id: 'system.restart',
    title: 'Restart Mac',
    summary: 'Restart the computer immediately.',
    risk: 'high',
    requiresConfirmation: true,
  },
  'system.sleep': {
    id: 'system.sleep',
    title: 'Sleep Mac',
    summary: 'Put the computer to sleep.',
    risk: 'low',
    requiresConfirmation: false,
  },
  'system.logout': {
    id: 'system.logout',
    title: 'Log out',
    summary: 'Log out of the current macOS user.',
    risk: 'high',
    requiresConfirmation: true,
  },
  'trash.empty': {
    id: 'trash.empty',
    title: 'Empty Trash',
    summary: 'Permanently delete everything in the Trash.',
    risk: 'high',
    requiresConfirmation: true,
  },
  'app.quit': {
    id: 'app.quit',
    title: 'Quit application',
    summary: 'Quit a running application.',
    risk: 'low',
    requiresConfirmation: false,
  },
  'extension.install': {
    id: 'extension.install',
    title: 'Install extension',
    summary: 'Download and install a Raycast extension.',
    risk: 'medium',
    requiresConfirmation: false,
  },
  'extension.uninstall': {
    id: 'extension.uninstall',
    title: 'Uninstall extension',
    summary: 'Remove an installed extension and its files.',
    risk: 'medium',
    requiresConfirmation: true,
  },
  'native.command': {
    id: 'native.command',
    title: 'Run system command',
    summary: 'Execute a built-in macOS control (toggle, query, helper).',
    risk: 'low',
    requiresConfirmation: false,
  },
}

export function getSafetyDescriptor(id: SafetyActionId): SafetyDescriptor | null {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, id) ? DESCRIPTORS[id] : null
}

export function listSafetyDescriptors(): SafetyDescriptor[] {
  return Object.values(DESCRIPTORS)
}
