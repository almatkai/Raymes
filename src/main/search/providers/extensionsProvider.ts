import {
  getExtensionCommands,
  listInstalledExtensions,
} from '../../extensions/service'
import type { IndexedDocument, SearchProvider } from './types'

export const extensionsProvider: SearchProvider = {
  providerId: 'extensions',
  async buildDocuments(): Promise<IndexedDocument[]> {
    const installed = listInstalledExtensions()
    if (installed.length === 0) return []

    const out: IndexedDocument[] = []
    for (const ext of installed.slice(0, 50)) {
      const commands = await getExtensionCommands(ext.id)
      for (const cmd of commands) {
        out.push({
          id: `extcmd:${ext.id}:${cmd.name}`,
          category: 'extensions',
          title: cmd.title,
          subtitle: `${ext.name} · ${cmd.subtitle || cmd.name}`,
          tokens: `${cmd.title} ${cmd.name} ${ext.name}`,
          action: {
            type: 'run-extension-command',
            extensionId: ext.id,
            commandName: cmd.name,
            title: cmd.title,
            argumentName: cmd.argumentPlaceholder ?? cmd.argumentName,
            commandArgumentDefinitions: cmd.commandArgumentDefinitions,
          },
          updatedAt: Date.now(),
        })
      }
    }

    return out
  },
}
