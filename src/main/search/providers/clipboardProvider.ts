import { app, clipboard, nativeImage, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  ClipboardEntry,
  ClipboardFileEntry,
  ClipboardImageEntry,
  ClipboardImagePayload,
  ClipboardTextEntry,
} from '../../../shared/clipboard'
import type { IndexedDocument, SearchProvider } from './types'

type ClipboardDb = {
  items: ClipboardEntry[]
}

const CLIPBOARD_LIMIT = 200

function storeDir(): string {
  const dir = join(app.getPath('userData'), 'search')
  mkdirSync(dir, { recursive: true })
  return dir
}

function imagesDir(): string {
  const dir = join(storeDir(), 'clipboard-images')
  mkdirSync(dir, { recursive: true })
  return dir
}

function clipboardPath(): string {
  return join(storeDir(), 'clipboard.json')
}

// Session cache
let _readClipboardDb: ClipboardDb | null = null
let _cacheTimestamp: number = 0
const CACHE_TTL = 10 * 1000 // 10 seconds

async function ensureDbLoaded(): Promise<void> {
  if (_readClipboardDb && Date.now() - _cacheTimestamp < CACHE_TTL) {
    return
  }
  try {
    const raw = readFileSync(clipboardPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ClipboardDb>
    _readClipboardDb = {
      items: Array.isArray(parsed.items) ? parsed.items : []
    }
  } catch {
    _readClipboardDb = { items: [] }
  }
  _cacheTimestamp = Date.now()
}

function writeDb(db: ClipboardDb): void {
  writeFileSync(clipboardPath(), `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  _readClipboardDb = db
  _cacheTimestamp = Date.now()
}

function detectSensitiveValue(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 16) return false
  if (/^sk-[A-Za-z0-9]{16,}$/.test(trimmed)) return true
  if (/^gh[pousr]_[A-Za-z0-9_]{20,}$/.test(trimmed)) return true
  if (/password\s*[=:]/i.test(trimmed)) return true
  if (/api[_-]?key\s*[=:]/i.test(trimmed)) return true
  if (/token\s*[=:]/i.test(trimmed)) return true
  return false
}

function sanitizeEntry(entry: ClipboardEntry): ClipboardEntry | null {
  const base = {
    id: String(entry.id ?? ''),
    createdAt: Number(entry.createdAt ?? 0),
    pinned: Boolean(entry.pinned),
    isSecret: Boolean(entry.isSecret),
  }
  if (!base.id || !Number.isFinite(base.createdAt)) return null

  switch (entry.kind) {
    case 'text': {
      const text = String(entry.text ?? '')
      if (!text) return null
      return {
        ...base,
        kind: 'text',
        text,
        preview: String(entry.preview ?? previewFromText(text)),
        charCount: Number(entry.charCount ?? text.length),
        lineCount: Number(entry.lineCount ?? text.split('\n').length),
      }
    }
    case 'image': {
      const imagePath = String((entry as ClipboardImageEntry).imagePath ?? '')
      if (!imagePath || !existsSync(imagePath)) return null
      return {
        ...base,
        kind: 'image',
        imagePath,
        width: Number((entry as ClipboardImageEntry).width ?? 0),
        height: Number((entry as ClipboardImageEntry).height ?? 0),
        byteSize: Number((entry as ClipboardImageEntry).byteSize ?? 0),
      }
    }
    case 'file': {
      const paths = Array.isArray((entry as ClipboardFileEntry).paths)
        ? (entry as ClipboardFileEntry).paths.map((p) => String(p)).filter(Boolean)
        : []
      if (paths.length === 0) return null
      return {
        ...base,
        kind: 'file',
        paths,
        preview:
          paths.length === 1 ? basename(paths[0]) : `${basename(paths[0])} + ${paths.length - 1} more`,
      }
    }
    default:
      return null
  }
}

function normalizeDb(db: ClipboardDb): ClipboardDb {
  return {
    items: db.items
      .map((item) => sanitizeEntry(item))
      .filter((item): item is ClipboardEntry => item !== null),
  }
}

function previewFromText(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstLine.slice(0, 140)
}

function insertEntry(db: ClipboardDb, entry: ClipboardEntry): ClipboardDb {
  const pinned = db.items.filter((item) => item.pinned && item.id !== entry.id)
  const rest = db.items.filter((item) => !item.pinned && item.id !== entry.id)
  return { items: [...pinned, entry, ...rest].slice(0, CLIPBOARD_LIMIT) }
}

function hashKey(kind: string, payload: string): string {
  return createHash('sha1').update(`${kind}|${payload}`).digest('hex').slice(0, 16)
}

function readFileUrls(): string[] {
  if (process.platform !== 'darwin') return []
  const formats = clipboard.availableFormats()
  const hasFileUrl = formats.some(
    (f) => f === 'public.file-url' || f === 'NSFilenamesPboardType' || f === 'Files',
  )
  if (!hasFileUrl) return []

  try {
    const raw = clipboard.read('public.file-url')
    if (!raw) return []
    const parts = raw
      .split(/\0|\r?\n/g)
      .map((part) => part.trim())
      .filter(Boolean)
    const paths = parts
      .map((url) => {
        try {
          if (url.startsWith('file://')) {
            return decodeURIComponent(new URL(url).pathname)
          }
          return url
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    return Array.from(new Set(paths))
  } catch {
    return []
  }
}

function idForText(text: string): string {
  return `text:${hashKey('text', text).slice(0, 12)}`
}
function idForFiles(paths: string[]): string {
  return `file:${hashKey('file', paths.slice().sort().join('|')).slice(0, 12)}`
}
function idForImage(hash: string): string {
  return `image:${hash.slice(0, 12)}`
}

function captureFileEntry(paths: string[], now: number): ClipboardEntry | null {
  if (paths.length === 0) return null
  return {
    id: idForFiles(paths),
    kind: 'file',
    createdAt: now,
    pinned: false,
    isSecret: false,
    paths,
    preview:
      paths.length === 1 ? basename(paths[0]) : `${basename(paths[0])} + ${paths.length - 1} more`,
  }
}

function captureImageEntry(now: number): ClipboardEntry | null {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null

  const buffer = image.toPNG()
  if (buffer.length === 0) return null

  const hash = createHash('sha1').update(buffer).digest('hex')
  const id = idForImage(hash)
  const file = join(imagesDir(), `${hash}.png`)

  if (!existsSync(file)) {
    writeFileSync(file, buffer)
  }

  return {
    id,
    kind: 'image',
    createdAt: now,
    pinned: false,
    isSecret: false,
    imagePath: file,
    width: image.getSize().width,
    height: image.getSize().height,
    byteSize: buffer.length,
  }
}

function captureTextEntry(now: number): ClipboardEntry | null {
  const text = clipboard.readText()
  if (!text || !text.trim()) return null

  return {
    id: idForText(text),
    kind: 'text',
    createdAt: now,
    pinned: false,
    isSecret: detectSensitiveValue(text),
    text,
    preview: previewFromText(text),
    charCount: text.length,
    lineCount: text.split('\n').length,
  }
}

/** Mutate the clipboard history based on what's currently on the
 *  pasteboard. Precedence: file URLs beat images beat text, because
 *  Finder and many apps set all three formats when you copy a file
 *  (and we want the richest kind to win). */
export function captureClipboardSnapshot(): void {
  const now = Date.now()
  ensureDbLoaded()
  if (!_readClipboardDb) return

  const fileUrls = readFileUrls()
  const candidate =
    captureFileEntry(fileUrls, now) ?? captureImageEntry(now) ?? captureTextEntry(now)
  if (!candidate) return

  const existing = _readClipboardDb.items.find((item) => item.id === candidate.id)
  const merged: ClipboardEntry = existing
    ? ({
        ...candidate,
        pinned: existing.pinned,
        createdAt: now,
      } as ClipboardEntry)
    : candidate

  if (_readClipboardDb.items[0]?.id === candidate.id && !existing?.pinned) {
    // The top entry already matches — nothing to do. Avoid rewriting the
    // JSON every poll tick when the user hasn't actually changed anything.
    return
  }

  const db = normalizeDb(insertEntry(_readClipboardDb, merged))
  writeDb(db)
}

export function listClipboardEntries(): ClipboardEntry[] {
  return normalizeDb(_readClipboardDb || { items: [] }).items
}

export function getClipboardEntry(id: string): ClipboardEntry | null {
  return listClipboardEntries().find((item) => item.id === id) ?? null
}

export function deleteClipboardEntry(id: string): boolean {
  const db = normalizeDb(_readClipboardDb || { items: [] })
  const entry = db.items.find((item) => item.id === id)
  if (!entry) return false

  const next = db.items.filter((item) => item.id !== id)
  writeDb({ items: next })

  // If this was an image and no other entry points at the same file, clean
  // up the PNG on disk. This keeps the images directory from unbounded
  // growth without risking deletion of a file still referenced elsewhere.
  if (entry.kind === 'image') {
    const stillReferenced = next.some(
      (item) => item.kind === 'image' && item.imagePath === entry.imagePath,
    )
    if (stillReferenced && existsSync(entry.imagePath)) {
      try {
        rmSync(entry.imagePath, { force: true })
      } catch {
        // non-fatal
      }
    }
  }

  return true
}

export function togglePinClipboardEntry(id: string): boolean {
  const db = normalizeDb(_readClipboardDb || { items: [] })
  const entry = db.items.find((item) => item.id === id)
  if (!entry) return false
  entry.pinned = !entry.pinned
  // Keep pinned entries above unpinned ones regardless of age.
  const pinned = db.items.filter((item) => item.pinned)
  const rest = db.items.filter((item) => !item.pinned)
  writeDb({ items: [...pinned, ...rest] })
  return true
}

export function clearClipboardHistory(): void {
  const db = normalizeDb(_readClipboardDb || { items: [] })
  for (const item of db.items) {
    if (item.kind === 'image' && existsSync(item.imagePath)) {
      try {
        rmSync(item.imagePath, { force: true })
      } catch {
        // non-fatal
      }
    }
  }
  writeDb({ items: [] })
}

/** Put a history entry back on the system clipboard. Images round-trip
 *  via nativeImage; files use the OS pasteboard URL format where we can,
 *  falling back to writing the path as text elsewhere. */
export function restoreClipboardEntry(id: string): boolean {
  const entry = getClipboardEntry(id)
  if (!entry) return false

  switch (entry.kind) {
    case 'text':
      clipboard.writeText(entry.text)
      return true
    case 'image': {
      if (!existsSync(entry.imagePath)) return false
      const img = nativeImage.createFromPath(entry.imagePath)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      return true
    }
    case 'file': {
      // Electron doesn't expose a portable "write file URL" on macOS, but
      // the URL form is accepted by most consumers and the text form is a
      // useful fallback.
      if (process.platform === 'darwin') {
        const url = `file://${encodeURI(entry.paths[0])}`
        clipboard.write({ text: entry.paths.join('\n'), bookmark: url })
      } else {
        clipboard.writeText(entry.paths.join('\n'))
      }
      return true
    }
    default:
      return false
  }
}

export function revealClipboardEntryInFinder(id: string): boolean {
  const entry = getClipboardEntry(id)
  if (!entry) return false
  if (entry.kind === 'image') {
    shell.showItemInFolder(entry.imagePath)
    return true
  }
  if (entry.kind === 'file' && entry.paths[0]) {
    shell.showItemInFolder(entry.paths[0])
    return true
  }
  return false
}

/** Return a base64 data URL for the renderer to display without bending
 *  file:// security rules. We read the PNG bytes every call — these are
 *  small and cached by the OS. */
export function readClipboardImagePayload(id: string): ClipboardImagePayload | null {
  const entry = getClipboardEntry(id)
  if (!entry || entry.kind !== 'image') return null
  if (!existsSync(entry.imagePath)) return null
  const bytes = readFileSync(entry.imagePath)
  return {
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    width: entry.width,
    height: entry.height,
    byteSize: entry.byteSize,
  }
}

// --- Background watcher ---------------------------------------------------

let watcherHandle: ReturnType<typeof setInterval> | null = null

/** Start polling the pasteboard. macOS doesn't expose a clipboard-change
 *  event, so polling is the pragmatic choice — and at 750ms it's both
 *  responsive and cheap. Calling this more than once is a no-op. */
export function startClipboardWatcher(intervalMs = 750): void {
  if (watcherHandle) return
  watcherHandle = setInterval(() => {
    try {
      captureClipboardSnapshot()
    } catch {
      // Swallow — a one-off clipboard read error should not take down the
      // interval timer.
    }
  }, intervalMs)
  // Don't keep the event loop alive solely for clipboard polling.
  if (typeof (watcherHandle as unknown as { unref?: () => void }).unref === 'function') {
    ;(watcherHandle as unknown as { unref: () => void }).unref()
  }
}

export function stopClipboardWatcher(): void {
  if (!watcherHandle) return
  clearInterval(watcherHandle)
  watcherHandle = null
}

// --- Legacy compat: item listing for the search index --------------------

/** Lightweight view used by the (old) search results UI — only text
 *  items can actually be copied via the `copy-text` action, so image and
 *  file entries are excluded from the search index surface. */
export function listClipboardTextItems(): Array<{
  id: string
  text: string
  createdAt: number
  pinned: boolean
  isSecret: boolean
  tags?: string[]
}> {
  return listClipboardEntries()
    .filter((item): item is ClipboardTextEntry => item.kind === 'text')
    .map((item) => ({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      pinned: item.pinned,
      isSecret: item.isSecret,
    }))
}

/** Clipboard contents live in a dedicated surface now: typing "Clipboard"
 *  surfaces a single entry that opens the history page. We deliberately
 *  keep history *out* of the global search index because leaking snippets
 *  of copied text/urls/paths into unrelated queries made the results noisy
 *  and accidentally exposed secrets. */
export const clipboardProvider: SearchProvider = {
  providerId: 'clipboard',
  async buildDocuments(): Promise<IndexedDocument[]> {
    return []
  },
}
