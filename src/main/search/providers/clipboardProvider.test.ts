import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testUserData = join(tmpdir(), 'tezbar-clipboard-provider-test')

const mocks = vi.hoisted(() => {
  const state = {
    text: '',
    filePaths: [] as string[],
    captureImages: false,
    image: false,
    imageBytes: Buffer.from('test-png'),
    changeCount: 1,
  }
  const image = {
    isEmpty: () => !state.image,
    getSize: () => ({ width: 100, height: 100 }),
    resize: () => image,
    toPNG: () => state.imageBytes,
  }
  const clipboard = {
    readSnapshot: vi.fn(() => ({
      text: state.text,
      filePaths: state.filePaths,
      hasImage: state.image,
      changeCount: state.changeCount,
    })),
    readText: vi.fn(() => state.text),
    readFilePaths: vi.fn(() => state.filePaths),
    availableFormats: vi.fn(() => [] as string[]),
    read: vi.fn(() => ''),
    readImage: vi.fn(() => image),
    writeText: vi.fn(),
    writeImage: vi.fn(),
    write: vi.fn(),
  }
  return {
    state,
    clipboard,
    userData: '',
  }
})
mocks.userData = testUserData

vi.mock('@tezbar/desktop-runtime', () => ({
  app: { getPath: () => mocks.userData },
  clipboard: mocks.clipboard,
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  shell: { showItemInFolder: vi.fn() },
}))

vi.mock('../../llm/configStore', () => ({
  readRawConfig: () => ({
    clipboardWatchEnabled: true,
    clipboardCaptureImages: mocks.state.captureImages,
  }),
  writeConfigPatch: vi.fn(),
}))

describe('clipboard watcher', () => {
  afterEach(() => {
    vi.useRealTimers()
    try { rmSync(mocks.userData, { recursive: true, force: true }) } catch { /* Windows file lock */ }
    mocks.state.text = ''
    mocks.state.filePaths = []
    mocks.state.captureImages = false
    mocks.state.image = false
    mocks.state.changeCount = 1
  })

  it('stores copied files as paths and deduplicates repeated copies', async () => {
    vi.resetModules()
    try { rmSync(mocks.userData, { recursive: true, force: true }) } catch { /* Windows */ }
    mocks.state.text = ''
    mocks.state.filePaths = ['/Users/example/Pictures/photo.png']
    mocks.state.captureImages = false
    mocks.state.image = false

    const provider = await import('./clipboardProvider')
    provider.captureClipboardSnapshot()
    provider.captureClipboardSnapshot()

    expect(mocks.clipboard.readSnapshot).toHaveBeenCalled()
    expect(provider.listClipboardEntries()).toEqual([
      expect.objectContaining({
        kind: 'file',
        paths: ['/Users/example/Pictures/photo.png'],
      }),
    ])
    expect(provider.listClipboardEntries()).toHaveLength(1)
    expect(existsSync(join(mocks.userData, 'search', 'clipboard-images'))).toBe(false)
    expect(provider.restoreClipboardEntry(provider.listClipboardEntries()[0].id)).toBe(true)
    if (process.platform === 'darwin') {
      expect(mocks.clipboard.write).toHaveBeenCalledWith(
        expect.objectContaining({ filePaths: ['/Users/example/Pictures/photo.png'] }),
      )
    } else {
      expect(mocks.clipboard.writeText).toHaveBeenCalledWith('/Users/example/Pictures/photo.png')
    }
  })

  it('detects a file-only clipboard without copying the file contents', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    try { rmSync(mocks.userData, { recursive: true, force: true }) } catch { /* Windows */ }
    mocks.state.text = ''
    mocks.state.filePaths = ['/Users/example/Documents/report.pdf']
    mocks.state.captureImages = false
    mocks.state.image = false

    const provider = await import('./clipboardProvider')
    provider.startClipboardWatcher()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(provider.listClipboardEntries()).toEqual([
      expect.objectContaining({ kind: 'file', paths: ['/Users/example/Documents/report.pdf'] }),
    ])
    provider.stopClipboardWatcher()
  })

  it('stores one payload for repeated identical image copies', async () => {
    vi.resetModules()
    try { rmSync(mocks.userData, { recursive: true, force: true }) } catch { /* Windows */ }
    mocks.state.text = ''
    mocks.state.filePaths = []
    mocks.state.captureImages = true
    mocks.state.image = true

    const provider = await import('./clipboardProvider')
    provider.captureClipboardSnapshot()
    provider.captureClipboardSnapshot()

    const entries = provider.listClipboardEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(
      expect.objectContaining({ kind: 'image', byteSize: mocks.state.imageBytes.length }),
    )
    expect(readdirSync(provider.getClipboardImagesDir())).toHaveLength(1)
  })

  it('keeps polling after idle instead of missing the next copy for seconds', async () => {
    vi.useFakeTimers()
    try { rmSync(mocks.userData, { recursive: true, force: true }) } catch { /* Windows */ }
    mocks.state.text = 'first copy'
    mocks.state.filePaths = []
    mocks.state.captureImages = false
    mocks.state.image = false

    const provider = await import('./clipboardProvider')
    provider.startClipboardWatcher()
    await vi.advanceTimersByTimeAsync(2_500)

    mocks.state.text = 'copy after idle'
    await vi.advanceTimersByTimeAsync(100)

    expect(provider.listClipboardEntries().map((entry) => entry.kind === 'text' && entry.text)).toContain(
      'copy after idle',
    )

    provider.stopClipboardWatcher()
    vi.useRealTimers()
    try { rmSync(mocks.userData, { recursive: true, force: true }) } catch { /* Windows */ }
  })
})
