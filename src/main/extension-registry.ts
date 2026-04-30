import { app, ipcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  ExtensionRegistryCommand,
  InstalledRegistryExtension,
} from '../shared/extensionRuntime'
import type { ExtensionManifest } from '../shared/extensions'
import { listInstalledExtensions as listLegacyInstalled, searchStoreExtensions } from './extensions/service'

export const extensionRegistryEvents = new EventEmitter()

const execFileAsync = promisify(execFile)

const RAYCAST_EXTENSIONS_REPO = 'https://github.com/raycast/extensions.git'
const RAYCAST_STORE_API = 'https://www.raycast.com/api/v1/extensions'

type RegistryDb = {
  installed: InstalledRegistryExtension[]
}

type PackageCommand = {
  name?: string
  title?: string
  subtitle?: string
  description?: string
  mode?: string
  arguments?: Array<{
    name?: string
    required?: boolean
    type?: string
    placeholder?: string
    title?: string
    data?: Array<{ title?: string; value?: string }>
  }>
}

type ExtensionPackageJson = {
  name?: string
  title?: string
  description?: string
  author?: string
  owner?: string
  version?: string
  icon?: string
  commands?: PackageCommand[]
}

const DEFAULT_DB: RegistryDb = { installed: [] }

function registryRootDir(): string {
  const dir = join(app.getPath('userData'), 'extension-registry')
  mkdirSync(dir, { recursive: true })
  return dir
}

function installedPackagesDir(): string {
  const dir = join(registryRootDir(), 'packages')
  mkdirSync(dir, { recursive: true })
  return dir
}

function dbPath(): string {
  return join(registryRootDir(), 'installed.json')
}

function readRegistryDb(): RegistryDb {
  const path = dbPath()
  if (!existsSync(path)) return DEFAULT_DB

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryDb>
    if (!Array.isArray(parsed.installed)) return DEFAULT_DB
    return {
      installed: parsed.installed.filter((entry): entry is InstalledRegistryExtension => {
        return (
          typeof entry?.id === 'string' &&
          typeof entry?.slug === 'string' &&
          typeof entry?.name === 'string' &&
          typeof entry?.version === 'string' &&
          typeof entry?.description === 'string' &&
          typeof entry?.packageJsonPath === 'string' &&
          typeof entry?.extensionPath === 'string' &&
          Array.isArray(entry?.commands) &&
          typeof entry?.installedAt === 'number'
        )
      }),
    }
  } catch {
    return DEFAULT_DB
  }
}

function writeRegistryDb(next: RegistryDb): void {
  writeFileSync(dbPath(), JSON.stringify(next, null, 2), 'utf8')
}

function normalizeExtensionId(input: string): string {
  const trimmed = String(input || '').trim()
  if (!trimmed) return ''
  return trimmed.startsWith('raycast.') ? trimmed : `raycast.${trimmed}`
}

function extensionSlug(extensionId: string): string {
  return normalizeExtensionId(extensionId).replace(/^raycast\./, '')
}

function extensionNameFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function extensionInstallPath(extensionId: string): string {
  return join(installedPackagesDir(), normalizeExtensionId(extensionId))
}

function packageJsonPath(extensionId: string): string {
  return join(extensionInstallPath(extensionId), 'package.json')
}

function resolveExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (existsSync(candidate)) return candidate
  }
  return null
}

function gitExecutable(): string | null {
  return resolveExecutable([
    String(process.env.GIT || '').trim(),
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
  ])
}

function npmExecutable(): string | null {
  return resolveExecutable([
    String(process.env.NPM || '').trim(),
    String(process.env.npm_execpath || '').trim(),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    '/usr/bin/npm',
  ])
}

function commandPathEnv(primaryBinDir?: string): string {
  const parts = [
    primaryBinDir || '',
    String(process.env.PATH || ''),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean)
  return Array.from(new Set(parts)).join(':')
}

async function runGit(args: string[], cwd: string): Promise<void> {
  const git = gitExecutable()
  if (!git) {
    throw new Error('git is required to install Raycast extensions but was not found')
  }

  await execFileAsync(git, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: commandPathEnv(dirname(git)),
    },
  })
}

async function runNpmInstall(extensionPath: string): Promise<void> {
  const npm = npmExecutable()
  if (!npm) {
    throw new Error('npm is required to install extension dependencies but was not found')
  }

  const executableName = basename(npm).toLowerCase()
  const normalizedPath = npm.toLowerCase()
  const isPnpm = executableName.includes('pnpm') || normalizedPath.includes('/pnpm/')
  const isYarn = executableName.includes('yarn') || normalizedPath.includes('/yarn/')
  const installArgs = isPnpm
    ? ['install', '--config.strict-peer-dependencies=false']
    : isYarn
      ? ['install']
      : ['install', '--legacy-peer-deps', '--no-audit', '--no-fund']

  await execFileAsync(
    npm,
    installArgs,
    {
      cwd: extensionPath,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: commandPathEnv(dirname(npm)),
      },
    },
  )
}

function parsePackageJson(extensionId: string): ExtensionPackageJson {
  const path = packageJsonPath(extensionId)
  if (!existsSync(path)) {
    throw new Error(`Missing package.json for ${extensionId}`)
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExtensionPackageJson
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error(`Invalid package.json for ${extensionId}`)
  }
}

function commandFromManifest(command: PackageCommand): ExtensionRegistryCommand | null {
  const name = String(command?.name || '').trim()
  if (!name) return null

  const title = String(command?.title || name).trim()
  const subtitle = String(command?.subtitle || command?.description || '').trim()
  const mode = typeof command?.mode === 'string' ? command.mode : undefined
  const description = typeof command?.description === 'string' ? command.description : undefined

  const argumentDefinitions = Array.isArray(command?.arguments)
    ? command.arguments
        .filter((arg) => arg && typeof arg.name === 'string' && arg.name.trim().length > 0)
        .map((arg) => ({
          name: String(arg.name),
          required: Boolean(arg.required),
          type: typeof arg.type === 'string' ? arg.type : undefined,
          placeholder: typeof arg.placeholder === 'string' ? arg.placeholder : undefined,
          title: typeof arg.title === 'string' ? arg.title : undefined,
          data: Array.isArray(arg.data) ? arg.data : undefined,
        }))
    : undefined

  return {
    name,
    title,
    subtitle,
    description,
    mode,
    argumentDefinitions,
  }
}

function extensionFromManifest(extensionId: string, installedAt: number): InstalledRegistryExtension {
  const pkg = parsePackageJson(extensionId)
  const slug = extensionSlug(extensionId)
  const extensionPath = extensionInstallPath(extensionId)

  const iconPath = typeof pkg.icon === 'string' && pkg.icon.trim().length > 0
    ? join(extensionPath, pkg.icon)
    : undefined

  const commands = Array.isArray(pkg.commands)
    ? pkg.commands
        .map(commandFromManifest)
        .filter((cmd): cmd is ExtensionRegistryCommand => cmd !== null)
    : []

  return {
    id: normalizeExtensionId(extensionId),
    slug,
    name: String(pkg.title || extensionNameFromSlug(slug)).trim() || extensionNameFromSlug(slug),
    version: pkg.version || '1.0.0',
    description: String(pkg.description || `Raycast extension: ${extensionNameFromSlug(slug)}`),
    author: pkg.author,
    owner: pkg.owner,
    iconPath,
    packageJsonPath: packageJsonPath(extensionId),
    extensionPath,
    commands,
    installedAt,
  }
}

async function cloneExtensionSource(slug: string, destination: string): Promise<void> {
  const stagingRoot = mkdtempSync(join(tmpdir(), `raymes-ext-reg-${slug}-`))
  try {
    await runGit(['clone', '--depth', '1', '--filter=blob:none', '--sparse', RAYCAST_EXTENSIONS_REPO, stagingRoot], tmpdir())
    await runGit(['sparse-checkout', 'set', `extensions/${slug}`], stagingRoot)

    const sourcePath = join(stagingRoot, 'extensions', slug)
    if (!existsSync(sourcePath)) {
      throw new Error(`Extension ${slug} was not found in the Raycast repository`)
    }

    rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(sourcePath, destination, { recursive: true })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function hasThirdPartyDependencies(extensionId: string): boolean {
  const pkg = parsePackageJson(extensionId)
  const deps = {
    ...(pkg as { dependencies?: Record<string, string> }).dependencies,
    ...(pkg as { optionalDependencies?: Record<string, string> }).optionalDependencies,
  }
  return Object.keys(deps || {}).some((name) => !name.startsWith('@raycast/'))
}

function coerceStoreEntry(raw: unknown): ExtensionManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const slugLike =
    typeof r.slug === 'string'
      ? r.slug
      : typeof r.name === 'string'
        ? r.name
        : typeof r.extensionName === 'string'
          ? r.extensionName
          : ''
  const slug = String(slugLike || '').replace(/^raycast\./, '').trim()
  if (!slug) return null

  const title =
    typeof r.title === 'string'
      ? r.title
      : typeof r.displayName === 'string'
        ? r.displayName
        : extensionNameFromSlug(slug)

  const description =
    typeof r.description === 'string'
      ? r.description
      : typeof r.subtitle === 'string'
        ? r.subtitle
        : `Raycast extension: ${title}`

  const author =
    typeof r.author === 'string'
      ? r.author
      : typeof (r.owner as Record<string, unknown>)?.name === 'string'
        ? (r.owner as Record<string, unknown>).name
        : 'Raycast Community'

  const downloadCount =
    typeof r.download_count === 'number'
      ? r.download_count
      : typeof r.downloadCount === 'number'
        ? r.downloadCount
        : undefined

  const owner =
    typeof (r.owner as Record<string, unknown>)?.handle === 'string'
      ? (r.owner as Record<string, unknown>).handle
      : undefined

  return {
    id: `raycast.${slug}`,
    name: String(title),
    description: String(description),
    author: String(author),
    version: 'latest',
    repository: `https://github.com/raycast/extensions/tree/main/extensions/${slug}`,
    downloadCount: downloadCount as number | undefined,
    owner: owner as string | undefined,
  }
}

export async function searchExtensionCatalog(query: string): Promise<ExtensionManifest[]> {
  return searchStoreExtensions(query)
}

export function listInstalledRegistryExtensions(): InstalledRegistryExtension[] {
  const db = readRegistryDb()
  const fromDb = [...db.installed]

  const legacy = listLegacyInstalled()
  const known = new Set(fromDb.map((item) => item.id))

  const bridgedLegacy: InstalledRegistryExtension[] = legacy
    .map((entry) => {
      const id = normalizeExtensionId(entry.id)
      if (known.has(id)) return null
      const extensionPath = join(app.getPath('userData'), 'extensions', 'packages', id)
      const manifestPath = join(extensionPath, 'package.json')
      if (!existsSync(manifestPath)) return null

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionPackageJson
        const commands = Array.isArray(manifest.commands)
          ? manifest.commands
              .map(commandFromManifest)
              .filter((command): command is ExtensionRegistryCommand => command !== null)
          : []

        return {
          id,
          slug: extensionSlug(id),
          name: entry.name,
          version: manifest.version || '1.0.0',
          description: entry.description,
          iconPath: typeof manifest.icon === 'string' ? join(extensionPath, manifest.icon) : undefined,
          packageJsonPath: manifestPath,
          extensionPath,
          commands,
          installedAt: entry.installedAt,
        } satisfies InstalledRegistryExtension
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null) as InstalledRegistryExtension[]

  return [...fromDb, ...bridgedLegacy].sort((a, b) => a.name.localeCompare(b.name))
}

export function resolveInstalledPackageJsonPath(extensionId: string): string | null {
  const normalized = normalizeExtensionId(extensionId)
  const installed = listInstalledRegistryExtensions().find((item) => item.id === normalized)
  if (installed && existsSync(installed.packageJsonPath)) return installed.packageJsonPath

  const fallback = join(app.getPath('userData'), 'extensions', 'packages', normalized, 'package.json')
  if (existsSync(fallback)) return fallback
  return null
}

export function getExtensionPreferences(extensionId: string, commandName?: string): Record<string, unknown> {
  const pkgPath = resolveInstalledPackageJsonPath(extensionId)
  if (!pkgPath) return {}

  const extensionPath = dirname(pkgPath)
  const preferencesPath = join(extensionPath, 'preferences.json')
  if (!existsSync(preferencesPath)) return {}

  try {
    const parsed = JSON.parse(readFileSync(preferencesPath, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}

    if (commandName && parsed.commands && typeof parsed.commands === 'object') {
      const byCommand = (parsed.commands as Record<string, unknown>)[commandName]
      if (byCommand && typeof byCommand === 'object') {
        return byCommand as Record<string, unknown>
      }
    }

    return parsed
  } catch {
    return {}
  }
}

export async function installRegistryExtension(extensionIdOrSlug: string): Promise<InstalledRegistryExtension> {
  const id = normalizeExtensionId(extensionIdOrSlug)
  if (!id) {
    throw new Error('A valid extension id is required')
  }

  const db = readRegistryDb()
  const existing = db.installed.find((entry) => entry.id === id)
  if (existing && existsSync(existing.packageJsonPath)) {
    return existing
  }

  const slug = extensionSlug(id)
  const installPath = extensionInstallPath(id)
  const backupPath = `${installPath}.backup-${Date.now()}`
  const hadExisting = existsSync(installPath)

  try {
    if (hadExisting) {
      rmSync(backupPath, { recursive: true, force: true })
      cpSync(installPath, backupPath, { recursive: true })
    }

    extensionRegistryEvents.emit('progress', { id, progress: 20 })
    await cloneExtensionSource(slug, installPath)
    extensionRegistryEvents.emit('progress', { id, progress: 60 })

    if (hasThirdPartyDependencies(id)) {
      await runNpmInstall(installPath)
    }
    extensionRegistryEvents.emit('progress', { id, progress: 90 })

    const next = extensionFromManifest(id, Date.now())
    const rest = db.installed.filter((entry) => entry.id !== id)
    const nextDb: RegistryDb = {
      installed: [...rest, next],
    }
    writeRegistryDb(nextDb)
    extensionRegistryEvents.emit('progress', { id, progress: 100 })
    return next
  } catch (error) {
    if (hadExisting && existsSync(backupPath)) {
      rmSync(installPath, { recursive: true, force: true })
      cpSync(backupPath, installPath, { recursive: true })
    }
    throw error
  } finally {
    rmSync(backupPath, { recursive: true, force: true })
  }
}

export function uninstallRegistryExtension(extensionIdOrSlug: string): boolean {
  const id = normalizeExtensionId(extensionIdOrSlug)
  if (!id) return false

  const db = readRegistryDb()
  const nextInstalled = db.installed.filter((entry) => entry.id !== id)
  if (nextInstalled.length === db.installed.length) {
    const fallbackPath = extensionInstallPath(id)
    if (existsSync(fallbackPath)) {
      rmSync(fallbackPath, { recursive: true, force: true })
      return true
    }
    return false
  }

  writeRegistryDb({ installed: nextInstalled })
  rmSync(extensionInstallPath(id), { recursive: true, force: true })
  return true
}

export function listInstalledExtensionSlugsFromDisk(): string[] {
  const dir = installedPackagesDir()
  try {
    return readdirSync(dir)
      .map((entry) => String(entry || '').replace(/^raycast\./, ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}
