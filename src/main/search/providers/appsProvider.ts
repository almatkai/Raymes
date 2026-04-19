import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IndexedDocument, SearchProvider } from './types'

function listApplications(): Array<{ name: string; path: string }> {
  const roots = ['/Applications', join(homedir(), 'Applications')]
  const out: Array<{ name: string; path: string }> = []

  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) {
        if (!entry.endsWith('.app')) continue
        out.push({
          name: entry.replace(/\.app$/, ''),
          path: join(root, entry),
        })
      }
    } catch {
      // Ignore inaccessible roots.
    }
  }

  return out
}

export const appsProvider: SearchProvider = {
  providerId: 'apps',
  async buildDocuments(): Promise<IndexedDocument[]> {
    const now = Date.now()
    return listApplications().map((app) => ({
      id: `app:${app.path}`,
      category: 'applications',
      title: app.name,
      subtitle: app.path,
      tokens: `${app.name} ${app.path}`,
      action: { type: 'open-app', appName: app.name },
      updatedAt: now,
      sourcePath: app.path,
    }))
  },
}
