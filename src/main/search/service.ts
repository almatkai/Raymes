import { app, BrowserWindow, clipboard, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  ExtensionCommandArgument,
  OpenPortProcess,
  SearchAction,
  SearchBenchmarkReport,
  SearchExecuteContext,
  SearchExecuteResult,
  SearchResult,
} from '../../shared/search'
import type { NativeCommandId } from '../../shared/nativeCommands'
import type { SafetyActionId } from '../../shared/safety'
import {
  executeExtensionCommandRuntime,
  getExtensionCommands,
  isUnsupportedRuntimeModeError,
  installExtension,
  listInstalledExtensions,
} from '../extensions/service'
import { executeNativeCommand } from '../nativeCommands/executor'
import { getNativeCommand } from '../nativeCommands/registry'
import { getSafetyDryRun } from '../llm/configStore'
import { confirmSafetyAction } from '../safety/confirm'
import { recordSafetyEntry } from '../safety/log'
import { getSafetyDescriptor } from '../safety/registry'
import { commandBus } from './commandBus'
import { readBenchmarkHistory, runOfflineBenchmarks } from './evaluation'
import { SearchIndexDatabase } from './indexDb'
import { appsProvider } from './providers/appsProvider'
import { captureClipboardSnapshot, clipboardProvider } from './providers/clipboardProvider'
import { commandsProvider } from './providers/commandsProvider'
import { extensionsProvider } from './providers/extensionsProvider'
import {
  collectInitialFileDocuments,
  spotlightFallback,
  startFileWatcher,
} from './providers/filesProvider'
import { addQuickNote, notesProvider } from './providers/notesProvider'
import { quickLinksProvider } from './providers/quickLinksProvider'
import { snippetsProvider } from './providers/snippetsProvider'
import type { IndexedDocument, SearchProvider } from './providers/types'
import { parseSearchIntent } from './queryIntent'
import { computeWeightedScore, shouldPreferRecent } from './ranker'

const execFileAsync = promisify(execFile)
const MAX_RESULTS = 80
const PROVIDER_REFRESH_MS = 90_000

const indexDb = new SearchIndexDatabase()
const baseProviders: SearchProvider[] = [
  appsProvider,
  clipboardProvider,
  notesProvider,
  snippetsProvider,
  quickLinksProvider,
  commandsProvider,
  extensionsProvider,
]

let bootstrapPromise: Promise<void> | null = null
let stopFileWatcher: (() => void) | null = null
let providerRefreshTimer: NodeJS.Timeout | null = null
let lastExtensionRefreshAt = 0

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

function uniqById(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

function actionIdFromResult(action: SearchAction, resultId?: string): string {
  if (resultId) return resultId

  switch (action.type) {
    case 'open-app':
      return `open-app:${action.appName}`
    case 'open-file':
      return `open-file:${action.path}`
    case 'copy-text':
      return `copy-text:${action.text.slice(0, 64)}`
    case 'add-note':
      return `add-note:${action.text.slice(0, 64)}`
    case 'open-url':
      return `open-url:${action.url}`
    case 'install-extension':
      return `install-extension:${action.extensionId}`
    case 'run-extension-command':
      return `extcmd:${action.extensionId}:${action.commandName}`
    case 'run-shell':
      return `run-shell:${action.command}`
    case 'invoke-command':
      return `command:${action.commandId}`
    case 'run-native-command':
      return `native:${action.commandId}`
    default:
      return 'unknown-action'
  }
}

/** Run a destructive action through the safety layer: confirmation dialog +
 *  structured log entry. Returns early (without executing) if the user
 *  rejects. `run` is only invoked once confirmation passes.
 *
 *  When `safetyDryRun` is set in user config, we still go through the
 *  confirmation dance (so the user can read what *would* happen) but we
 *  never invoke `run` — the result is synthesized and logged with
 *  `dryRun: true`. This makes it safe to rehearse risky commands. */
async function runWithSafety<T extends SearchExecuteResult>(
  safetyId: SafetyActionId,
  context: Record<string, unknown>,
  run: () => Promise<T>,
  options?: { detailsOverride?: string; titleOverride?: string },
): Promise<SearchExecuteResult> {
  const descriptor = getSafetyDescriptor(safetyId)
  if (!descriptor) {
    return { ok: false, message: `Safety descriptor missing: ${safetyId}` }
  }

  const dryRun = getSafetyDryRun()
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const effectiveDescriptor = options
    ? {
        ...descriptor,
        title: options.titleOverride ?? descriptor.title,
        details: options.detailsOverride ?? descriptor.details,
      }
    : descriptor
  const { accepted } = await confirmSafetyAction(window, effectiveDescriptor, context, { dryRun })
  if (!accepted) {
    recordSafetyEntry({
      action: safetyId,
      title: effectiveDescriptor.title,
      risk: effectiveDescriptor.risk,
      ok: false,
      message: 'Cancelled by user',
      context: { ...context, dryRun },
    })
    return { ok: false, message: 'Cancelled' }
  }

  if (dryRun) {
    const message = `Dry run: would have ${effectiveDescriptor.title.toLowerCase()}.`
    recordSafetyEntry({
      action: safetyId,
      title: effectiveDescriptor.title,
      risk: effectiveDescriptor.risk,
      ok: true,
      message,
      context: { ...context, dryRun: true },
    })
    return { ok: true, message }
  }

  const result = await run()
  recordSafetyEntry({
    action: safetyId,
    title: effectiveDescriptor.title,
    risk: effectiveDescriptor.risk,
    ok: result.ok,
    message: result.message,
    context,
  })
  return result
}

async function upsertProvider(provider: SearchProvider): Promise<void> {
  const docs = await provider.buildDocuments()
  if (docs.length > 0) {
    indexDb.upsertDocuments(docs)
  }
}

async function refreshAllProviders(): Promise<void> {
  await Promise.all(baseProviders.map((provider) => upsertProvider(provider)))
}

async function refreshVolatileProviders(): Promise<void> {
  captureClipboardSnapshot()
  await Promise.all([
    upsertProvider(clipboardProvider),
    upsertProvider(notesProvider),
    upsertProvider(snippetsProvider),
    upsertProvider(quickLinksProvider),
  ])

  const now = Date.now()
  if (now - lastExtensionRefreshAt > 30_000) {
    lastExtensionRefreshAt = now
    await upsertProvider(extensionsProvider)
  }
}

async function bootstrapSearchIndex(): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    // Migration: clipboard entries used to live inside the global index,
    // so queries like "https" or "pnpm" would surface copied text in the
    // results. We moved clipboard history to a dedicated surface, which
    // means any previously-persisted clipboard docs need to be evicted
    // explicitly — a no-op upsert wouldn't touch them.
    indexDb.removeDocumentsByCategory('clipboard')

    captureClipboardSnapshot()
    await refreshAllProviders()

    const fileDocs = await collectInitialFileDocuments()
    if (fileDocs.length > 0) {
      indexDb.upsertDocuments(fileDocs)
    }

    stopFileWatcher = startFileWatcher((payload) => {
      if (payload.upsert) {
        indexDb.upsertDocuments([payload.upsert])
      } else if (payload.removeId) {
        indexDb.removeDocumentById(payload.removeId)
      }
    })

    if (!providerRefreshTimer) {
      providerRefreshTimer = setInterval(() => {
        void refreshAllProviders()
      }, PROVIDER_REFRESH_MS)
      providerRefreshTimer.unref()
    }

    app.once('before-quit', () => {
      stopFileWatcher?.()
      stopFileWatcher = null
      if (providerRefreshTimer) {
        clearInterval(providerRefreshTimer)
        providerRefreshTimer = null
      }
    })
  })()

  return bootstrapPromise
}

/** Rebuild FTS rows for quick notes after CRUD (append/update/delete). */
export async function reindexQuickNotes(): Promise<void> {
  await bootstrapSearchIndex()
  indexDb.removeDocumentsByCategory('quick-notes')
  const docs = await notesProvider.buildDocuments()
  if (docs.length > 0) {
    indexDb.upsertDocuments(docs)
  }
}

/** Rebuild FTS rows for snippets after user CRUD. */
export async function reindexSnippets(): Promise<void> {
  await bootstrapSearchIndex()
  indexDb.removeDocumentsByCategory('snippets')
  const docs = await snippetsProvider.buildDocuments()
  if (docs.length > 0) {
    indexDb.upsertDocuments(docs)
  }
}

type RankedResult = SearchResult & { updatedAt: number }

type RecommendationSeed = {
  id: string
  category: SearchResult['category']
  title: string
  subtitle: string
  action: SearchAction
  updatedAt: number
  frequency: number
  successRate: number
  lastUsedAt: number
}

function intentBoost(category: SearchResult['category'], intentType: ReturnType<typeof parseSearchIntent>['type']): number {
  if (intentType === 'app' && category === 'applications') return 100
  if (intentType === 'file' && category === 'files') return 90
  if (
    intentType === 'command' &&
    (category === 'commands' || category === 'mac-cli' || category === 'native-command')
  )
    return 110
  if (intentType === 'extension-command' && category === 'extensions') return 120
  if (intentType === 'ai' && category === 'quick-notes') return -30
  return 0
}

/** First-class surfaces we own (internal commands, extensions, apps)
 *  should beat generic file matches when the user's query is a prefix or
 *  exact hit on their title. Without this, typing "clipboard" ranks
 *  `ClipboardView.tsx` above the actual "Clipboard History" command — which
 *  is painfully wrong.
 *
 *  The boost is large enough to overcome BM25 differences but scoped to
 *  internal command-shaped results so it never displaces highly-specific
 *  file matches on unrelated queries. */
function internalSurfaceBoost(
  category: SearchResult['category'],
  title: string,
  query: string,
): number {
  const hit =
    category === 'native-command' ||
    category === 'commands' ||
    category === 'extensions' ||
    category === 'applications' ||
    category === 'quick-notes'
  if (!hit) return 0

  const normalizedTitle = title.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0

  // Numbers are tuned against the 0–1000 range emitted by
  // computeWeightedScore so an exact title hit on a native command
  // dominates even a very strong BM25 match on a file.
  if (normalizedTitle === normalizedQuery) return 600
  if (normalizedTitle.startsWith(normalizedQuery)) return 420
  const titleWords = normalizedTitle.split(/\s+/)
  if (titleWords.some((word) => word.startsWith(normalizedQuery))) return 300
  if (normalizedTitle.includes(normalizedQuery)) return 150
  return 0
}

/** Fresh notes should surface right after a save so the user can choose
 *  whether to open them, without forcing navigation to the Notes page. */
function recentQuickNoteBoost(category: SearchResult['category'], updatedAt: number, now: number): number {
  if (category !== 'quick-notes') return 0
  const ageMs = now - updatedAt
  if (ageMs <= 0) return 260
  if (ageMs < 2 * 60 * 1000) return 260
  if (ageMs > 10 * 60 * 1000) return 0
  const decayWindowMs = 8 * 60 * 1000
  const t = (ageMs - 2 * 60 * 1000) / decayWindowMs
  return Math.round((1 - Math.max(0, Math.min(1, t))) * 260)
}

/** A just-saved note should win for the same query text. This closes the
 *  gap where broad OR-token matches can keep command surfaces above the
 *  note immediately after save. */
function exactRecentQuickNoteBoost(
  category: SearchResult['category'],
  title: string,
  query: string,
  updatedAt: number,
  now: number,
): number {
  if (category !== 'quick-notes') return 0
  const ageMs = now - updatedAt
  if (ageMs > 5 * 60 * 1000) return 0

  const normalizedTitle = title.trim().toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery || !normalizedTitle) return 0

  if (normalizedTitle === normalizedQuery) return 1800
  if (normalizedTitle.startsWith(normalizedQuery)) return 1400
  if (normalizedTitle.includes(normalizedQuery)) return 900
  return 0
}

function rankRows(query: string, docs: Array<{ doc: IndexedDocument; lexical: number; fuzzyDistance?: number }>): RankedResult[] {
  const now = Date.now()
  const stats = indexDb.getActionStats(docs.map((entry) => entry.doc.id))
  const intent = parseSearchIntent(query)

  const ranked = docs.map((entry) => {
    const actionStat = stats.get(entry.doc.id)
    const frequency = actionStat?.frequency ?? 0
    const totalCount = actionStat?.totalCount ?? 0
    const successCount = actionStat?.successCount ?? 0
    const successRate = totalCount > 0 ? successCount / totalCount : 0
    const activityAt = actionStat?.lastUsedAt && actionStat.lastUsedAt > 0 ? actionStat.lastUsedAt : entry.doc.updatedAt

    const score =
      computeWeightedScore({
        lexical: entry.lexical,
        recencyMs: now - activityAt,
        frequency,
        successRate,
        category: entry.doc.category,
        fuzzyDistance: entry.fuzzyDistance,
      }) +
      intentBoost(entry.doc.category, intent.type) +
      recentQuickNoteBoost(entry.doc.category, entry.doc.updatedAt, now) +
      exactRecentQuickNoteBoost(entry.doc.category, entry.doc.title, query, entry.doc.updatedAt, now) +
      internalSurfaceBoost(entry.doc.category, entry.doc.title, query)

    return {
      id: entry.doc.id,
      title: entry.doc.title,
      subtitle: entry.doc.subtitle,
      category: entry.doc.category,
      score,
      action: entry.doc.action,
      updatedAt: activityAt,
    } satisfies RankedResult
  })

  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      const preferRecent = shouldPreferRecent(
        left.score,
        now - left.updatedAt,
        right.score,
        now - right.updatedAt,
      )
      if (preferRecent) return -1
      const reversePreferRecent = shouldPreferRecent(
        right.score,
        now - right.updatedAt,
        left.score,
        now - left.updatedAt,
      )
      if (reversePreferRecent) return 1
      return right.score - left.score
    }
    return right.updatedAt - left.updatedAt
  })

  return ranked
}

function recommendationBoost(id: string): number {
  if (id === 'native:open-clipboard-history') return 900
  if (id === 'native:open-snippets') return 880
  if (id === 'native:list-listening-ports') return 680
  if (id === 'extcmd:raycast.port-manager:kill-listening-process') return 840
  if (id === 'extcmd:raycast.port-manager:open-ports') return 720
  if (id === 'extcmd:raycast.port-manager:open-ports-menu-bar') return 700
  return 0
}

function buildRecommendations(): SearchResult[] {
  const now = Date.now()
  const seeds: RecommendationSeed[] = indexDb.listRecommendedDocuments(MAX_RESULTS).map((row) => {
    const totalCount = row.totalCount > 0 ? row.totalCount : 0
    const successRate = totalCount > 0 ? row.successCount / totalCount : 0
    return {
      id: row.id,
      category: row.category,
      title: row.title,
      subtitle: row.subtitle,
      action: indexDb.parseAction(row.actionJson),
      updatedAt: row.updatedAt,
      frequency: row.frequency,
      successRate,
      lastUsedAt: row.lastUsedAt,
    }
  })

  const pinnedOrder = [
    'native:open-clipboard-history',
    'native:open-snippets',
    'extcmd:raycast.port-manager:kill-listening-process',
    'native:list-listening-ports',
    'extcmd:raycast.port-manager:open-ports',
    'extcmd:raycast.port-manager:open-ports-menu-bar',
  ]
  const pinnedRows = indexDb.getDocumentsByIds(pinnedOrder)
  const existingIds = new Set(seeds.map((seed) => seed.id))
  for (const row of pinnedRows) {
    if (existingIds.has(row.id)) continue
    seeds.push({
      id: row.id,
      category: row.category,
      title: row.title,
      subtitle: row.subtitle,
      action: indexDb.parseAction(row.actionJson),
      updatedAt: row.updatedAt,
      frequency: 0,
      successRate: 0,
      lastUsedAt: 0,
    })
  }

  return seeds
    .map((seed) => {
      const activityAt = seed.lastUsedAt > 0 ? seed.lastUsedAt : seed.updatedAt
      const score =
        computeWeightedScore({
          lexical: 0.92,
          recencyMs: now - activityAt,
          frequency: seed.frequency,
          successRate: seed.successRate,
          category: seed.category,
        }) + recommendationBoost(seed.id)

      return {
        id: seed.id,
        title: seed.title,
        subtitle: seed.subtitle,
        category: seed.category,
        score,
        action: seed.action,
      } satisfies SearchResult
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
}

function parseOpenPortProcesses(stdout: string): OpenPortProcess[] {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length <= 1) return []

  const grouped = new Map<
    string,
    {
      process: string
      user: string
      pid: string
      ports: Set<number>
    }
  >()

  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue

    const nameField = parts.at(-1) ?? ''
    const match = nameField.match(/:(\d+)\s*\(LISTEN\)$/)
    if (!match) continue

    const port = Number(match[1])
    if (!Number.isFinite(port)) continue

    const process = parts[0] ?? 'unknown'
    const pid = parts[1] ?? '?'
    const user = parts[2] ?? 'unknown'
    const key = `${process}:${pid}:${user}`

    const existing = grouped.get(key)
    if (existing) {
      existing.ports.add(port)
      continue
    }

    grouped.set(key, {
      process,
      user,
      pid,
      ports: new Set<number>([port]),
    })
  }

  return Array.from(grouped.values())
    .map((entry) => ({
      process: entry.process,
      user: entry.user,
      pid: entry.pid,
      ports: Array.from(entry.ports).sort((a, b) => a - b),
    }))
    .sort((a, b) => a.process.localeCompare(b.process) || a.pid.localeCompare(b.pid))
}

export async function listOpenPorts(): Promise<OpenPortProcess[]> {
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', 'lsof -nP -iTCP -sTCP:LISTEN'])
    return parseOpenPortProcesses(stdout)
  } catch {
    return []
  }
}

const PORT_MANAGER_KILL_PORT_DEF: ExtensionCommandArgument[] = [
  { name: 'port', title: 'Port', placeholder: 'e.g. 3000', required: true, type: 'text' },
]

/** Raymes-native catalog for the Port Manager extension — always injected
 *  when the query looks port-related so "Open Ports" beats random files
 *  and the launcher never dumps raw `lsof` into the answer pane. */
function portManagerCatalogQueryScore(q: string): number {
  const n = q.trim().toLowerCase()
  if (!n) return 0
  if (n.includes('port manager')) return 520
  if (/\b(listening|listen)\b/.test(n) && /\bport/.test(n)) return 510
  if (n.includes('list listening') || n.includes('lsof')) return 500
  if (/\bports?\b/.test(n)) return 430
  if (/\b(kill|stop)\b/.test(n) && /\bport/.test(n)) return 410
  return 0
}

function buildPortManagerCatalogSearchResults(trimmed: string): SearchResult[] {
  const base = portManagerCatalogQueryScore(trimmed)
  if (base <= 0) return []

  const subtitle = 'Port Manager'

  return [
    {
      id: 'port-catalog:named-ports',
      title: 'Named Ports',
      subtitle,
      category: 'extensions',
      score: base + 12,
      action: {
        type: 'run-extension-command',
        extensionId: 'raycast.port-manager',
        commandName: 'named-ports',
        title: 'Named Ports',
      },
    },
    {
      id: 'port-catalog:open-ports',
      title: 'Open Ports',
      subtitle,
      category: 'extensions',
      score: base + 10,
      action: {
        type: 'run-extension-command',
        extensionId: 'raycast.port-manager',
        commandName: 'open-ports',
        title: 'Open Ports',
      },
    },
    {
      id: 'port-catalog:open-ports-menu-bar',
      title: 'Open Ports in Menu Bar',
      subtitle,
      category: 'extensions',
      score: base + 8,
      action: {
        type: 'run-extension-command',
        extensionId: 'raycast.port-manager',
        commandName: 'open-ports-menu-bar',
        title: 'Open Ports in Menu Bar',
      },
    },
    {
      id: 'port-catalog:kill-listening',
      title: 'Kill Process Listening On',
      subtitle,
      category: 'extensions',
      score: base + 6,
      action: {
        type: 'run-extension-command',
        extensionId: 'raycast.port-manager',
        commandName: 'kill-listening-process',
        title: 'Kill Process Listening On',
        commandArgumentDefinitions: PORT_MANAGER_KILL_PORT_DEF,
      },
    },
  ]
}

async function searchPortManagerOpenPorts(query: string): Promise<SearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const mentionsPort = /(port|ports|open|listen|listening)/.test(normalizedQuery)
  const mentionsKill = /(kill|stop|terminate|process)/.test(normalizedQuery)

  if (!/(port|ports|open|listen|kill|\d{2,5})/.test(normalizedQuery)) {
    return []
  }

  const processes = await listOpenPorts()
  if (processes.length === 0) return []

  return processes
    .flatMap<SearchResult | null>((entry) =>
      entry.ports.map((port) => {
        let score = -1
        const processName = entry.process.toLowerCase()
        const userName = entry.user.toLowerCase()

        if (normalizedQuery.includes(String(port))) {
          score = 430
        } else if (mentionsPort || mentionsKill) {
          score = 280
        } else if (processName.includes(normalizedQuery) || userName.includes(normalizedQuery)) {
          score = 220
        }

        if (score < 0) return null
        return {
          id: `port-listener:${entry.pid}:${port}`,
          title: `Open Port ${port}`,
          subtitle: `${entry.process} (PID ${entry.pid}) · ${entry.user} · Enter to kill listener`,
          category: 'extensions' as const,
          score,
          action: {
            type: 'run-extension-command',
            extensionId: 'raycast.port-manager',
            commandName: 'kill-listening-process',
            title: 'Kill Process Listening On',
            argumentValues: { port: String(port) },
          },
        } satisfies SearchResult
      }),
    )
    .filter(isPresent)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
}

export async function searchEverything(query: string): Promise<SearchResult[]> {
  await bootstrapSearchIndex()
  await refreshVolatileProviders()

  const trimmed = query.trim()
  if (!trimmed) {
    return buildRecommendations()
  }

  const rows = indexDb.search(trimmed, MAX_RESULTS)
  const docs: Array<{ doc: IndexedDocument; lexical: number; fuzzyDistance?: number }> = rows.map((row) => ({
    doc: {
      id: row.id,
      category: row.category,
      title: row.title,
      subtitle: row.subtitle,
      tokens: `${row.title} ${row.subtitle}`,
      action: indexDb.parseAction(row.actionJson),
      updatedAt: row.updatedAt,
    },
    lexical: row.lexical,
    fuzzyDistance: row.fuzzyDistance,
  }))

  const ranked = rankRows(trimmed, docs)
  const asResults = ranked.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    category: item.category,
    score: item.score,
    action: item.action,
  }))

  const resultsWithoutFiles = asResults.filter((result) => result.category !== 'files')
  const fileResults = asResults.filter((result) => result.category === 'files')

  let fallbackFiles: SearchResult[] = []
  if (trimmed.length > 0 && fileResults.length < 2) {
    fallbackFiles = await spotlightFallback(trimmed)
  }

  const portCatalogResults = buildPortManagerCatalogSearchResults(trimmed)
  const openPortResults = await searchPortManagerOpenPorts(trimmed)

  /** Synthetic "Add quick note" must stay competitive with strong file hits
   *  (e.g. `*_notes.txt` under Downloads); a flat 120 always sank it. */
  function quickNoteAddScore(query: string): number {
    const q = query.trim().toLowerCase()
    if (!q) return 120
    if (/\bnotes?\b/.test(q) || q.includes('quick note')) return 780
    return 120
  }

  const noteAdd = trimmed
    ? [
        {
          id: `note-add:${trimmed}`,
          title: `Add quick note: ${trimmed.slice(0, 64)}`,
          subtitle: 'Quick notes',
          category: 'quick-notes' as const,
          score: quickNoteAddScore(trimmed),
          action: { type: 'add-note', text: trimmed },
        } satisfies SearchResult,
      ]
    : []

  return uniqById([
    ...resultsWithoutFiles,
    ...fileResults,
    ...fallbackFiles,
    ...portCatalogResults,
    ...openPortResults,
    ...noteAdd,
  ])
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
}

function resolveActionArgumentValues(
  actionArg: Extract<SearchAction, { type: 'run-extension-command' }>,
): Record<string, string> {
  const fromMap =
    actionArg.argumentValues && typeof actionArg.argumentValues === 'object' ? actionArg.argumentValues : null
  const out: Record<string, string> = {}
  if (fromMap) {
    for (const [key, value] of Object.entries(fromMap)) {
      const normalizedKey = String(key ?? '').trim()
      if (!normalizedKey) continue
      out[normalizedKey] = String(value ?? '').trim()
    }
  }
  if (actionArg.argumentName && out[actionArg.argumentName] === undefined) {
    out[actionArg.argumentName] = String(actionArg.argumentValue ?? '').trim()
  }
  return out
}

function findPortArgumentDefinition(defs: ExtensionCommandArgument[]): ExtensionCommandArgument | null {
  const byName = defs.find((def) => def.name.toLowerCase() === 'port')
  if (byName) return byName
  return (
    defs.find(
      (def) => /port/i.test(def.name) || /port/i.test(def.title ?? '') || /port/i.test(def.placeholder ?? ''),
    ) ?? null
  )
}

async function executeActionInner(action: SearchAction): Promise<SearchExecuteResult> {
  switch (action.type) {
    case 'open-app': {
      await execFileAsync('open', ['-a', action.appName])
      return { ok: true, message: `Opened ${action.appName}` }
    }
    case 'open-file': {
      await shell.openPath(action.path)
      return { ok: true, message: 'Opened file' }
    }
    case 'copy-text': {
      clipboard.writeText(action.text)
      captureClipboardSnapshot()
      return { ok: true, message: 'Copied to clipboard' }
    }
    case 'add-note': {
      addQuickNote(action.text)
      void reindexQuickNotes()
      return { ok: true, message: 'Quick note saved' }
    }
    case 'install-extension': {
      const ext = await installExtension(action.extensionId)
      return { ok: true, message: `Installed ${ext.name}` }
    }
    case 'open-url': {
      await shell.openExternal(action.url)
      return { ok: true, message: 'Opened URL' }
    }
    case 'invoke-command': {
      return commandBus.execute({ commandId: action.commandId, payload: action.payload })
    }
    case 'run-extension-command': {
      const commandArgs = resolveActionArgumentValues(action)
      const defs = Array.isArray(action.commandArgumentDefinitions) ? action.commandArgumentDefinitions : []
      const isPortManager = action.extensionId.toLowerCase() === 'raycast.port-manager'
      const isPortKill = isPortManager && action.commandName === 'kill-listening-process'

      const missingRequired = defs
        .filter((def) => Boolean(def.required))
        .filter((def) => {
          const value = commandArgs[def.name]
          return typeof value !== 'string' || value.trim().length === 0
        })

      if (missingRequired.length > 0) {
        return {
          ok: false,
          message: `Missing required argument: ${missingRequired[0].title || missingRequired[0].name}`,
        }
      }

      try {
        return await executeExtensionCommandRuntime(action.extensionId, action.commandName, commandArgs)
      } catch (error) {
        if (isPortKill) {
          const portDef = findPortArgumentDefinition(defs)
          const rawPort = (portDef ? commandArgs[portDef.name] : commandArgs.port) ?? action.argumentValue ?? ''
          const normalizedPort = String(rawPort).trim()

          if (!/^\d{1,5}$/.test(normalizedPort)) {
            return { ok: false, message: 'Enter a valid port number (e.g. 3000)' }
          }

          const numericPort = Number(normalizedPort)
          if (numericPort < 1 || numericPort > 65535) {
            return { ok: false, message: 'Port must be between 1 and 65535.' }
          }

          return runWithSafety(
            'port.kill',
            { port: numericPort },
            async () => {
              const shellScript = [
                `pids="$(lsof -nP -iTCP:${numericPort} -sTCP:LISTEN -t 2>/dev/null | sort -u)"`,
                'if [ -z "$pids" ]; then',
                '  echo 0',
                'else',
                "  count=\"$(printf '%s\\n' \"$pids\" | sed '/^$/d' | wc -l | tr -d ' ')\"",
                "  printf '%s\\n' \"$pids\" | xargs kill -9",
                '  echo "$count"',
                'fi',
              ].join('\n')

              const { stdout } = await execFileAsync('bash', ['-lc', shellScript])
              const killed = Number(stdout.trim().split(/\s+/).at(-1) || '0')

              if (!Number.isFinite(killed) || killed <= 0) {
                return { ok: true, message: `Port ${numericPort} has no listening process.` }
              }
              return {
                ok: true,
                message: `Port ${numericPort} stopped (${killed} process${killed === 1 ? '' : 'es'} terminated).`,
              }
            },
            { detailsOverride: `Will terminate the process listening on port ${numericPort}.` },
          )
        }

        if (isUnsupportedRuntimeModeError(error)) {
          const isOpenPortsView =
            isPortManager && (action.commandName === 'open-ports' || action.commandName === 'open-ports-menu-bar')

          if (isOpenPortsView) {
            return {
              ok: true,
              message:
                'Open Ports is a view/menu command. Type "open ports" to list live listening ports in Raymes, then press Enter to kill a selected port listener.',
            }
          }

          if (action.extensionId === 'raycast.kill-process') {
            return {
              ok: false,
              message:
                'Kill Process is a Raycast view command and is not directly runnable here yet. Install Port Manager and use "Kill Process Listening On" or type "open ports".',
            }
          }

          return {
            ok: false,
            message:
              'This extension command uses Raycast view/menu-bar mode, which is not directly runnable in Raymes yet.',
          }
        }

        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message: `Extension runtime failed: ${message}` }
      }
    }
    case 'run-shell': {
      return runWithSafety(
        'shell.run',
        { command: action.command },
        async () => {
          await execFileAsync('osascript', [
            '-e',
            `tell application "Terminal" to do script ${JSON.stringify(action.command)}`,
            '-e',
            'activate application "Terminal"',
          ])
          return { ok: true, message: 'Executed in Terminal' }
        },
        { detailsOverride: `Command: ${action.command}` },
      )
    }
    case 'run-native-command': {
      const descriptor = getNativeCommand(action.commandId as NativeCommandId)
      if (!descriptor) {
        return { ok: false, message: `Unknown native command: ${action.commandId}` }
      }
      const executor = (): Promise<SearchExecuteResult> =>
        executeNativeCommand(descriptor.id).then((result) => ({
          ok: result.ok,
          message: result.message,
        }))

      if (descriptor.destructive) {
        return runWithSafety(
          descriptor.id === 'empty-trash' ? 'trash.empty' : 'native.command',
          { command: descriptor.title },
          executor,
          { titleOverride: descriptor.title, detailsOverride: descriptor.subtitle },
        )
      }
      return executor()
    }
    default:
      return { ok: false, message: 'Unsupported action' }
  }
}

export async function executeSearchAction(
  action: SearchAction,
  context?: SearchExecuteContext,
): Promise<SearchExecuteResult> {
  let result: SearchExecuteResult

  try {
    result = await executeActionInner(action)
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const actionId = actionIdFromResult(action, context?.resultId)
  indexDb.recordAction(actionId, result.ok)

  if (context?.query && typeof context.rank === 'number' && Number.isFinite(context.rank)) {
    indexDb.recordClick(context.query, actionId, context.rank, result.ok)
  }

  return result
}

export async function runSearchBenchmarks(): Promise<SearchBenchmarkReport> {
  await bootstrapSearchIndex()
  return runOfflineBenchmarks(searchEverything, indexDb)
}

export function getSearchBenchmarkHistory(): SearchBenchmarkReport[] {
  return readBenchmarkHistory(indexDb)
}

export async function listExtensionCommandIndexIds(): Promise<string[]> {
  const installed = listInstalledExtensions()
  if (installed.length === 0) return []

  const ids: string[] = []
  for (const ext of installed.slice(0, 25)) {
    const commands = await getExtensionCommands(ext.id)
    for (const cmd of commands) {
      ids.push(`extcmd:${ext.id}:${cmd.name}`)
    }
  }
  return ids
}
