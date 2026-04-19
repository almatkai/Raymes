/** Extension service.
 *
 *  Scope today:
 *  - Full install pipeline for Raycast extensions: fetch `package.json`,
 *    stage the bundle in a temp dir, hash every script, swap atomically,
 *    roll back on failure, and persist a `meta.json` for integrity checks.
 *  - A pragmatic `@raycast/api` + `@raycast/utils` shim (see `raycastShim.ts`)
 *    that covers the bits no-view commands actually use — LocalStorage,
 *    Clipboard, preferences, toasts/HUD, open/showInFinder, environment —
 *    plus no-op proxies for rendering primitives (List, Form, Detail, …)
 *    so even view/menu-bar files can be imported without throwing.
 *  - Typed integrity reports surfaced through IPC so the UI can flag
 *    tampered or partially-downloaded installs and offer a one-click
 *    reinstall.
 *
 *  Deliberately not here yet (would each be a separate project):
 *  - Full React render host that can run `view` / `menu-bar` mode
 *    extensions against their Raycast component tree. The runtime still
 *    rejects those modes with a clear error; the shim keeps imports safe
 *    but nothing drives the UI.
 *  - OAuth flow, preferences editor UI, background task scheduling,
 *    extension pane navigation. */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import type {
  ExtensionIntegrityReport,
  ExtensionManifest,
  InstalledExtension,
} from '../../shared/extensions'
import {
  createRaycastApi,
  createRaycastUtils,
  formatRuntimeFeedback,
  type RuntimeFeedback,
} from './raycastShim'

const RAYCAST_EXTENSIONS_REPO = 'https://github.com/raycast/extensions'
const RAYCAST_EXTENSIONS_REF = 'c0e624ee0420679ed3aa296c25c1a6f29938c56a'
const RAYCAST_EXTENSIONS_PATH = 'extensions'
const CATALOG_CACHE_TTL_MS = 10 * 60_000
const RUNTIME_UNSUPPORTED_MODE = 'RUNTIME_UNSUPPORTED_MODE'

type ExtensionsDb = {
  installed: InstalledExtension[]
}

type CatalogCache = {
  fetchedAt: number
  catalog: ExtensionManifest[]
}

type ExtensionCommand = {
  name: string
  title: string
  subtitle: string
  mode?: string
  argumentName?: string
  argumentPlaceholder?: string
  commandArgumentDefinitions: Array<{
    name: string
    required?: boolean
    type?: string
    placeholder?: string
    title?: string
    data?: Array<{ title?: string; value?: string }>
  }>
}

type RaycastPackageArgument = {
  name?: string
  placeholder?: string
  type?: string
  required?: boolean
  title?: string
  data?: Array<{ title?: string; value?: string }>
}

type RaycastPackageCommand = {
  name?: string
  title?: string
  subtitle?: string
  description?: string
  mode?: string
  arguments?: RaycastPackageArgument[]
}

type RaycastPackageJson = {
  name?: string
  title?: string
  commands?: RaycastPackageCommand[]
}

type GithubTreeEntry = {
  path: string
  mode: string
  type: 'tree' | 'blob' | string
  sha: string
}

type GithubTreeResponse = {
  sha: string
  truncated?: boolean
  tree: GithubTreeEntry[]
}

export type ExtensionRuntimeExecuteResult = {
  ok: boolean
  message: string
}

const DEFAULT_DB: ExtensionsDb = {
  installed: [],
}

let catalogCache: CatalogCache | null = null
const commandCache = new Map<string, ExtensionCommand[]>()

function getDbPath(): string {
  const dir = join(app.getPath('userData'), 'extensions')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'installed.json')
}

function extensionsRootDir(): string {
  const dir = join(app.getPath('userData'), 'extensions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function installedPackageRoot(extensionId: string): string {
  return join(extensionsRootDir(), 'packages', extensionId)
}

function packageJsonPathForInstalledExtension(extensionId: string): string {
  return join(installedPackageRoot(extensionId), 'package.json')
}

function scriptPathForInstalledExtensionCommand(extensionId: string, commandName: string): string {
  return join(installedPackageRoot(extensionId), '.sc-build', `${commandName}.js`)
}

function metaPathForInstalledExtension(extensionId: string): string {
  return join(installedPackageRoot(extensionId), 'meta.json')
}

function backupPackageRoot(extensionId: string): string {
  return join(extensionsRootDir(), 'packages', `${extensionId}.backup`)
}

/** Everything we need to know to decide whether an installed extension is
 *  current, intact, and safe to execute. Written atomically at the end of
 *  a successful install. */
type InstallMeta = {
  extensionId: string
  commitRef: string
  installedAt: number
  commandNames: string[]
  /** Commands the upstream build didn't ship a pre-built script for (usually
   *  view/menu-bar commands). Tracked so the executor can fail fast with a
   *  clear reason rather than guessing. */
  missingScripts: string[]
  /** sha256 of each shipped script — protects against partial writes when a
   *  `fetch` is interrupted mid-install. */
  scriptHashes: Record<string, string>
  lastError?: string
}

function readInstallMeta(extensionId: string): InstallMeta | null {
  const p = metaPathForInstalledExtension(extensionId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as InstallMeta
  } catch {
    return null
  }
}

function writeInstallMeta(meta: InstallMeta): void {
  const p = metaPathForInstalledExtension(meta.extensionId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8')
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function inspectIntegrity(extensionId: string): ExtensionIntegrityReport {
  const meta = readInstallMeta(extensionId)
  if (!meta) {
    return {
      extensionId,
      installed: false,
      missingScripts: [],
      tamperedScripts: [],
      healthy: false,
    }
  }

  const missing: string[] = [...meta.missingScripts]
  const tampered: string[] = []

  for (const name of meta.commandNames) {
    if (meta.missingScripts.includes(name)) continue
    const scriptPath = scriptPathForInstalledExtensionCommand(extensionId, name)
    if (!existsSync(scriptPath)) {
      missing.push(name)
      continue
    }
    const expected = meta.scriptHashes[name]
    if (!expected) continue
    try {
      const actual = hashText(readFileSync(scriptPath, 'utf8'))
      if (actual !== expected) tampered.push(name)
    } catch {
      missing.push(name)
    }
  }

  return {
    extensionId,
    installed: true,
    commitRef: meta.commitRef,
    missingScripts: Array.from(new Set(missing)),
    tamperedScripts: tampered,
    healthy: missing.length === 0 && tampered.length === 0,
    lastError: meta.lastError,
  }
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function readInstalledPackageJson(extensionId: string): RaycastPackageJson | null {
  const p = packageJsonPathForInstalledExtension(extensionId)
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, 'utf8')
    return parseJsonSafe<RaycastPackageJson>(raw)
  } catch {
    return null
  }
}

function extensionSlugFromId(extensionId: string): string {
  return extensionId.startsWith('raycast.') ? extensionId.slice('raycast.'.length) : extensionId
}

function normalizeExtensionCommandsFromPackage(pkg: RaycastPackageJson): ExtensionCommand[] {
  return (pkg.commands ?? [])
    .map((cmd) => {
      const args = Array.isArray(cmd.arguments)
        ? cmd.arguments
            .filter((arg) => arg && typeof arg.name === 'string' && arg.name.trim().length > 0)
            .map((arg) => ({
              name: String(arg.name),
              required: Boolean(arg.required),
              type: typeof arg.type === 'string' ? arg.type : undefined,
              placeholder: typeof arg.placeholder === 'string' ? arg.placeholder : undefined,
              title: typeof arg.title === 'string' ? arg.title : undefined,
              data: Array.isArray(arg.data) ? arg.data : undefined,
            }))
        : []

      const firstArg = args[0]
      return {
        name: cmd.name ?? '',
        title: cmd.title ?? cmd.name ?? '',
        subtitle: cmd.subtitle ?? cmd.description ?? '',
        mode: typeof cmd.mode === 'string' ? cmd.mode : undefined,
        argumentName: firstArg?.name,
        argumentPlaceholder: firstArg?.placeholder,
        commandArgumentDefinitions: args,
      }
    })
    .filter((cmd) => cmd.name && cmd.title)
}

function readDb(): ExtensionsDb {
  const p = getDbPath()
  try {
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ExtensionsDb>
    return {
      installed: Array.isArray(parsed.installed) ? parsed.installed : [],
    }
  } catch {
    return DEFAULT_DB
  }
}

function writeDb(db: ExtensionsDb): void {
  const p = getDbPath()
  writeFileSync(p, JSON.stringify(db, null, 2), 'utf8')
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name)
}

function normalizeNameFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'raymes-extension-indexer',
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${url}`)
  }

  return (await response.json()) as T
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'raymes-extension-indexer',
    },
  })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`)
  }
  return await response.text()
}

async function fetchRaycastPackage(slug: string): Promise<RaycastPackageJson> {
  const url = `https://raw.githubusercontent.com/raycast/extensions/${RAYCAST_EXTENSIONS_REF}/${RAYCAST_EXTENSIONS_PATH}/${slug}/package.json`
  const raw = await fetchText(url)
  const parsed = parseJsonSafe<RaycastPackageJson>(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid package.json for extension: ${slug}`)
  }
  return parsed
}

async function fetchRaycastCatalogFromGithub(): Promise<ExtensionManifest[]> {
  const commit = await fetchGithubJson<{ tree: { sha: string } }>(
    `https://api.github.com/repos/raycast/extensions/git/commits/${RAYCAST_EXTENSIONS_REF}`,
  )

  const rootTree = await fetchGithubJson<GithubTreeResponse>(
    `https://api.github.com/repos/raycast/extensions/git/trees/${commit.tree.sha}`,
  )

  const extensionsDir = rootTree.tree.find(
    (entry) => entry.type === 'tree' && entry.path === RAYCAST_EXTENSIONS_PATH,
  )
  if (!extensionsDir) {
    throw new Error('Could not find /extensions directory in Raycast repository tree')
  }

  const extensionsTree = await fetchGithubJson<GithubTreeResponse>(
    `https://api.github.com/repos/raycast/extensions/git/trees/${extensionsDir.sha}`,
  )

  if (extensionsTree.truncated === true) {
    throw new Error('Raycast extensions tree response is truncated; cannot build full catalog safely')
  }

  return extensionsTree.tree
    .filter((entry) => entry.type === 'tree')
    .map((entry) => {
      const slug = entry.path
      const name = normalizeNameFromSlug(slug)
      return {
        id: `raycast.${slug}`,
        name,
        description: `Raycast extension: ${name}`,
        author: 'Raycast Community',
        version: RAYCAST_EXTENSIONS_REF.slice(0, 7),
        repository: `${RAYCAST_EXTENSIONS_REPO}/tree/${RAYCAST_EXTENSIONS_REF}/${RAYCAST_EXTENSIONS_PATH}/${slug}`,
      } satisfies ExtensionManifest
    })
    .sort(byName)
}

/** Download the extension to a temp directory, then atomically move it to
 *  the real install root. If anything fails mid-download we abandon the
 *  staging dir (or restore a backup) — we never leave the user with a
 *  half-written package. */
async function stageAndInstallExtension(
  extensionId: string,
  slug: string,
): Promise<RaycastPackageJson> {
  const pkg = await fetchRaycastPackage(slug)

  const staging = mkdtempSync(join(tmpdir(), `raymes-ext-${extensionId}-`))
  const stagingBuild = join(staging, '.sc-build')
  mkdirSync(stagingBuild, { recursive: true })
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

  const commandEntries = (pkg.commands ?? [])
    .map((cmd) => ({
      name: typeof cmd.name === 'string' ? cmd.name.trim() : '',
      mode: typeof cmd.mode === 'string' ? cmd.mode.trim() : '',
    }))
    .filter((entry) => entry.name.length > 0)

  const missingScripts: string[] = []
  const scriptHashes: Record<string, string> = {}

  await Promise.all(
    commandEntries.map(async (entry) => {
      const url = `https://raw.githubusercontent.com/raycast/extensions/${RAYCAST_EXTENSIONS_REF}/${RAYCAST_EXTENSIONS_PATH}/${slug}/.sc-build/${entry.name}.js`
      try {
        const js = await fetchText(url)
        writeFileSync(join(stagingBuild, `${entry.name}.js`), js, 'utf8')
        scriptHashes[entry.name] = hashText(js)
      } catch {
        // view / menu-bar commands frequently omit a prebuilt script.
        // We record this so executeExtensionCommandRuntime can fail fast
        // with a meaningful reason instead of "ENOENT".
        missingScripts.push(entry.name)
      }
    }),
  )

  // Swap staging -> real root, keeping a backup of the previous install for
  // rollback if the rename itself fails (unlikely but easy to be correct).
  const root = installedPackageRoot(extensionId)
  const backup = backupPackageRoot(extensionId)
  if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })

  try {
    if (existsSync(root)) renameSync(root, backup)
    mkdirSync(dirname(root), { recursive: true })
    renameSync(staging, root)
  } catch (error) {
    if (existsSync(backup) && !existsSync(root)) {
      try {
        renameSync(backup, root)
      } catch {
        // Best-effort rollback. The caller will see the original error.
      }
    }
    rmSync(staging, { recursive: true, force: true })
    throw error
  } finally {
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
  }

  writeInstallMeta({
    extensionId,
    commitRef: RAYCAST_EXTENSIONS_REF,
    installedAt: Date.now(),
    commandNames: commandEntries.map((entry) => entry.name),
    missingScripts,
    scriptHashes,
  })

  return pkg
}

async function ensureRaycastExtensionBundle(extensionId: string): Promise<RaycastPackageJson> {
  const meta = readInstallMeta(extensionId)
  const existing = readInstalledPackageJson(extensionId)

  if (meta && existing && meta.commitRef === RAYCAST_EXTENSIONS_REF) {
    const report = inspectIntegrity(extensionId)
    if (report.healthy) return existing
    // Fall through to re-install — tampered/missing scripts need a refetch.
  }

  const slug = extensionSlugFromId(extensionId)
  return await stageAndInstallExtension(extensionId, slug)
}

/** Map of extensionId -> last install error, surfaced to the UI. Never
 *  persisted; losing it on restart is intentional since the user's next
 *  install attempt recreates it if the problem is still present. */
const installErrors = new Map<string, string>()

async function ensureExtensionBundle(extensionId: string): Promise<RaycastPackageJson | null> {
  if (!extensionId.startsWith('raycast.')) return null
  try {
    const pkg = await ensureRaycastExtensionBundle(extensionId)
    installErrors.delete(extensionId)
    return pkg
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    installErrors.set(extensionId, message)
    const existingMeta = readInstallMeta(extensionId)
    if (existingMeta) {
      writeInstallMeta({ ...existingMeta, lastError: message })
    }
    console.warn('[extensions] failed to ensure extension bundle:', extensionId, error)
    return readInstalledPackageJson(extensionId)
  }
}

/** Public — used by the compatibility harness and the UI. */
export function inspectExtensionIntegrity(extensionId: string): ExtensionIntegrityReport {
  return inspectIntegrity(extensionId)
}

export function getExtensionInstallError(extensionId: string): string | null {
  return installErrors.get(extensionId) ?? null
}

export async function reinstallExtension(extensionId: string): Promise<ExtensionIntegrityReport> {
  const slug = extensionSlugFromId(extensionId)
  try {
    await stageAndInstallExtension(extensionId, slug)
    installErrors.delete(extensionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    installErrors.set(extensionId, message)
    throw error
  }
  commandCache.delete(extensionId)
  return inspectIntegrity(extensionId)
}

async function executeNoViewScript(
  extensionId: string,
  commandName: string,
  scriptPath: string,
  argumentValues: Record<string, string>,
): Promise<ExtensionRuntimeExecuteResult> {
  const fileRequire = createRequire(scriptPath)
  const feedback: RuntimeFeedback[] = []
  const packageRoot = installedPackageRoot(extensionId)
  const shimCtx = { extensionId, commandName, packageRoot, feedback }
  const raycastApiShim = createRaycastApi(shimCtx)
  const raycastUtilsShim = createRaycastUtils(shimCtx)
  const builtinSet = new Set<string>(builtinModules)

  const customRequire = (specifier: string): unknown => {
    if (specifier === '@raycast/api') return raycastApiShim
    if (specifier === '@raycast/utils') return raycastUtilsShim

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      return fileRequire(specifier)
    }

    if (specifier.startsWith('node:') || builtinSet.has(specifier)) {
      return fileRequire(specifier)
    }

    throw new Error(`Unsupported runtime dependency: ${specifier}`)
  }

  const mod: { exports: unknown } = { exports: {} }
  const wrapper = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    readFileSync(scriptPath, 'utf8'),
  )
  wrapper(mod.exports, customRequire, mod, scriptPath, dirname(scriptPath))

  const exported = mod.exports as { default?: unknown }
  const command =
    typeof exported.default === 'function'
      ? (exported.default as (props: { arguments: Record<string, string> }) => unknown)
      : typeof mod.exports === 'function'
        ? (mod.exports as (props: { arguments: Record<string, string> }) => unknown)
        : null

  if (!command) {
    throw new Error('Extension command entry is not executable')
  }

  await Promise.resolve(command({ arguments: argumentValues }))

  const last = feedback.at(-1)
  if (!last) {
    return { ok: true, message: 'Extension command completed.' }
  }

  const style = (last.style ?? '').toLowerCase()
  const ok = style !== 'failure'
  return {
    ok,
    message: formatRuntimeFeedback(last),
  }
}

function unsupportedModeError(): Error {
  const err = new Error('Only no-view extension commands are executable in this runtime.') as Error & {
    code?: string
  }
  err.code = RUNTIME_UNSUPPORTED_MODE
  return err
}

export function isUnsupportedRuntimeModeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { code?: string }).code === RUNTIME_UNSUPPORTED_MODE
}

export async function executeExtensionCommandRuntime(
  extensionId: string,
  commandName: string,
  argumentValues: Record<string, string>,
): Promise<ExtensionRuntimeExecuteResult> {
  const pkg = await ensureExtensionBundle(extensionId)
  if (!pkg) {
    throw new Error(`Runtime bundle not available for extension: ${extensionId}`)
  }

  const commandMeta = (pkg.commands ?? []).find((command) => command.name === commandName)
  if (!commandMeta) {
    throw new Error(`Command not found: ${commandName}`)
  }

  const mode = (commandMeta.mode ?? '').toLowerCase()
  if (mode && mode !== 'no-view') {
    throw unsupportedModeError()
  }

  // Fail fast when the install pipeline already knew the script wasn't
  // available upstream — much clearer than the opaque "ENOENT" we'd get
  // from readFileSync below.
  const meta = readInstallMeta(extensionId)
  if (meta?.missingScripts.includes(commandName)) {
    throw new Error(
      `No prebuilt script for ${commandName}. This extension doesn't ship an executable .sc-build file for this command.`,
    )
  }

  const scriptPath = scriptPathForInstalledExtensionCommand(extensionId, commandName)
  if (!existsSync(scriptPath)) {
    throw new Error(`Missing command script: ${commandName}.js`)
  }

  return await executeNoViewScript(extensionId, commandName, scriptPath, argumentValues)
}

export async function getStoreCatalog(): Promise<ExtensionManifest[]> {
  const now = Date.now()
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.catalog
  }

  try {
    const catalog = await fetchRaycastCatalogFromGithub()
    catalogCache = { fetchedAt: now, catalog }
    return catalog
  } catch (error) {
    console.warn('[extensions] failed to refresh Raycast catalog:', error)
    return catalogCache?.catalog ?? []
  }
}

function scoreMatch(item: ExtensionManifest, q: string): number {
  const fields = [item.id, item.name, item.description, item.author].map((v) => v.toLowerCase())
  const [id, name, description, author] = fields
  const slug = id.startsWith('raycast.') ? id.slice('raycast.'.length) : id

  if (slug === q || name === q) return 500
  if (slug.startsWith(q)) return 300
  if (name.startsWith(q)) return 250
  if (slug.split(/[-_\s.]/g).some((token) => token === q)) return 220
  if (name.split(/[-_\s.]/g).some((token) => token === q)) return 200
  if (slug.includes(q)) return 120
  if (name.includes(q)) return 100
  if (description.includes(q)) return 40
  if (author.includes(q)) return 20
  return -1
}

export function listInstalledExtensions(): InstalledExtension[] {
  const db = readDb()
  return [...db.installed].sort(byName)
}

export async function searchStoreExtensions(query: string): Promise<ExtensionManifest[]> {
  const q = query.trim().toLowerCase()
  const catalog = await getStoreCatalog()
  if (!q) return catalog

  return catalog
    .map((item) => ({ item, score: scoreMatch(item, q) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || byName(a.item, b.item))
    .map((entry) => entry.item)
}

export async function installExtension(extensionId: string): Promise<InstalledExtension> {
  const catalog = await getStoreCatalog()
  const manifest = catalog.find((item) => item.id === extensionId)
  if (!manifest) {
    throw new Error(`Extension not found in store: ${extensionId}`)
  }

  const db = readDb()
  const existing = db.installed.find((item) => item.id === extensionId)
  if (existing) {
    void ensureExtensionBundle(extensionId)
    return existing
  }

  const next: InstalledExtension = {
    ...manifest,
    installedAt: Date.now(),
  }

  db.installed.push(next)
  writeDb(db)
  void ensureExtensionBundle(extensionId)
  return next
}

export async function getExtensionCommands(extensionId: string): Promise<ExtensionCommand[]> {
  const cached = commandCache.get(extensionId)
  if (cached) return cached

  const localPkg = await ensureExtensionBundle(extensionId)
  if (localPkg) {
    const commands = normalizeExtensionCommandsFromPackage(localPkg)
    commandCache.set(extensionId, commands)
    return commands
  }

  const slug = extensionSlugFromId(extensionId)
  const url = `https://raw.githubusercontent.com/raycast/extensions/${RAYCAST_EXTENSIONS_REF}/${RAYCAST_EXTENSIONS_PATH}/${slug}/package.json`

  try {
    const pkg = await fetchGithubJson<RaycastPackageJson>(url)
    const commands = normalizeExtensionCommandsFromPackage(pkg)
    commandCache.set(extensionId, commands)
    return commands
  } catch {
    commandCache.set(extensionId, [])
    return []
  }
}

export function uninstallExtension(extensionId: string): boolean {
  const db = readDb()
  const before = db.installed.length
  db.installed = db.installed.filter((item) => item.id !== extensionId)
  if (db.installed.length === before) return false
  writeDb(db)
  commandCache.delete(extensionId)
  installErrors.delete(extensionId)
  // Clear the install root and any leftover backup from an interrupted
  // previous install.
  rmSync(installedPackageRoot(extensionId), { recursive: true, force: true })
  rmSync(backupPackageRoot(extensionId), { recursive: true, force: true })
  return true
}
