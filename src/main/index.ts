import { app, BrowserWindow, globalShortcut, Menu, nativeImage, screen, session, Tray } from 'electron'
import { join } from 'node:path'
import { getUiStateRetentionMs } from './llm/configStore'
import { registerIpcHandlers, shutdownIpcHandlers } from './ipc'
import {
  startClipboardWatcher,
  stopClipboardWatcher,
} from './search/providers/clipboardProvider'
import {
  clampLauncherHeight,
  WINDOW_MAX_HEIGHT,
  WINDOW_MIN_HEIGHT,
  WINDOW_TOP_FACTOR,
  WINDOW_WIDTH,
} from './windowBounds'

import { isPhysicalKeyDown } from './bridge'
import { shouldSuppressBlurHide } from './windowState'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let commandBarVisible = false
/** Set when the palette is hidden; used to decide whether to reset renderer UI on reopen. */
let lastPaletteHideAt: number | null = null

/** After Alt+Space opens the launcher, poll HID key state so a sustained chord
 *  starts local dictation (push-to-talk) while `globalShortcut` only fires once. */
const ALT_SPACE_HOLD_MS = 150
const ALT_SPACE_POLL_MS = 12
const ALT_SPACE_WATCH_MAX_MS = 120_000

let altSpaceHoldTimer: ReturnType<typeof setInterval> | null = null
let altSpaceHoldOpenedAt = 0
let altSpaceHotkeyDictationArmed = false
let altSpaceHoldTriggered = false
let altSpaceFocusedHoldTimer: ReturnType<typeof setTimeout> | null = null
let altSpaceFocusedPressedAt = 0
let altSpaceFocusedHoldTriggered = false

function releaseAltSpaceHotkeyDictation(): void {
  if (altSpaceHotkeyDictationArmed && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('voice:hotkey-hold', { phase: 'release' })
  }
  altSpaceHotkeyDictationArmed = false
}

function stopAltSpaceHoldWatcher(): void {
  if (altSpaceHoldTimer !== null) {
    clearInterval(altSpaceHoldTimer)
    altSpaceHoldTimer = null
  }
  releaseAltSpaceHotkeyDictation()
  altSpaceHoldTriggered = false
}

function stopFocusedAltSpaceGesture(): void {
  if (altSpaceFocusedHoldTimer !== null) {
    clearTimeout(altSpaceFocusedHoldTimer)
    altSpaceFocusedHoldTimer = null
  }
  altSpaceFocusedPressedAt = 0
  altSpaceFocusedHoldTriggered = false
}

function toggleCommandBarImmediate(): void {
  if (!mainWindow) return

  if (commandBarVisible) {
    // If the palette is marked visible but not focused (e.g. user switched Space),
    // reopen it in the current active Space instead of toggling it off there.
    if (!mainWindow.isFocused()) {
      hideCommandBar()
      showCommandBar()
      return
    }
    hideCommandBar()
    return
  }

  showCommandBar()
}

function activateMicFromAltSpaceHold(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  // Hold gesture semantics:
  // - if closed: open + start dictation
  // - if open: keep it open and start dictation again
  if (!commandBarVisible || !mainWindow.isFocused()) {
    showCommandBar()
  }

  if (!altSpaceHotkeyDictationArmed) {
    mainWindow.webContents.send('voice:hotkey-hold', { phase: 'press' })
    altSpaceHotkeyDictationArmed = true
  }
  altSpaceHoldTriggered = true
}

function startFocusedAltSpaceGesture(): void {
  if (altSpaceFocusedPressedAt !== 0) return

  altSpaceFocusedPressedAt = Date.now()
  altSpaceFocusedHoldTriggered = false
  altSpaceFocusedHoldTimer = setTimeout(() => {
    altSpaceFocusedHoldTimer = null
    if (altSpaceFocusedPressedAt === 0) return
    activateMicFromAltSpaceHold()
    altSpaceFocusedHoldTriggered = true
  }, ALT_SPACE_HOLD_MS)
}

function finishFocusedAltSpaceGestureOnRelease(): void {
  if (altSpaceFocusedPressedAt === 0) return

  const elapsed = Date.now() - altSpaceFocusedPressedAt
  const holdTriggered = altSpaceFocusedHoldTriggered
  stopFocusedAltSpaceGesture()

  if (holdTriggered || elapsed >= ALT_SPACE_HOLD_MS) {
    if (!holdTriggered) {
      // Edge case: threshold elapsed, but timeout callback did not run yet.
      activateMicFromAltSpaceHold()
    }
    releaseAltSpaceHotkeyDictation()
    return
  }

  toggleCommandBarImmediate()
}

function isAltSpaceReleaseInput(input: Electron.Input): boolean {
  if (input.type !== 'keyUp') return false

  const key = input.key.toLowerCase()
  const code = input.code?.toLowerCase() ?? ''
  return (
    key === 'space'
    || key === ' '
    || key === 'alt'
    || key === 'option'
    || code === 'space'
    || code === 'altleft'
    || code === 'altright'
  )
}

function startAltSpaceHoldWatcher(): void {
  stopAltSpaceHoldWatcher()
  if (process.platform !== 'darwin') {
    toggleCommandBarImmediate()
    return
  }

  altSpaceHoldOpenedAt = Date.now()
  altSpaceHotkeyDictationArmed = false
  altSpaceHoldTriggered = false

  altSpaceHoldTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopAltSpaceHoldWatcher()
      return
    }

    const elapsed = Date.now() - altSpaceHoldOpenedAt
    if (elapsed > ALT_SPACE_WATCH_MAX_MS) {
      stopAltSpaceHoldWatcher()
      return
    }

    let combo = false
    try {
      combo = isPhysicalKeyDown('space') && isPhysicalKeyDown('option')
    } catch {
      stopAltSpaceHoldWatcher()
      return
    }

    if (altSpaceHoldTriggered) {
      if (!combo) {
        stopAltSpaceHoldWatcher()
      }
      return
    }

    // Only classify tap-vs-hold once we cross the threshold so a key-down
    // never toggles immediately.
    if (elapsed < ALT_SPACE_HOLD_MS) {
      return
    }

    // Still held at threshold => hold behavior (activate mic).
    if (combo) {
      activateMicFromAltSpaceHold()
      return
    }

    // Not held at threshold => quick click/tap behavior (toggle UI).
    toggleCommandBarImmediate()
    stopAltSpaceHoldWatcher()
  }, ALT_SPACE_POLL_MS)
}

function handleAltSpaceHotkey(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (commandBarVisible && mainWindow.isFocused()) {
    startFocusedAltSpaceGesture()
    return
  }

  stopFocusedAltSpaceGesture()
  startAltSpaceHoldWatcher()
}

function createTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAAf8+9hAAAADElEQVR42mNgwMAAABgABXlY2Z8AAAAASUVORK5CYII='
  )
}

function isPaletteUiStale(lastHideAt: number | null, ttlMs: number): boolean {
  if (lastHideAt === null) return false
  if (ttlMs === 0) return true
  return Date.now() - lastHideAt > ttlMs
}

function placeWindow(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const { width, height, x, y } = screen.getDisplayNearestPoint(cursor).workArea
  const [, curH] = win.getContentSize()
  const contentH = clampLauncherHeight(curH || WINDOW_MAX_HEIGHT)
  const winX = x + Math.floor((width - WINDOW_WIDTH) / 2)
  const winY = y + Math.floor(height * WINDOW_TOP_FACTOR)
  win.setBounds({ x: winX, y: winY, width: WINDOW_WIDTH, height: contentH })
}

function showCommandBar(): void {
  if (!mainWindow) return

  // macOS keeps a window attached to its last Space; temporarily showing on all
  // workspaces lets us present it in the currently active Space, then we disable
  // that mode right away so it does not stay visible everywhere.
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
  }

  placeWindow(mainWindow)
  mainWindow.show()
  mainWindow.focus()
  commandBarVisible = true

  if (process.platform === 'darwin') {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.setVisibleOnAllWorkspaces(false, {
        visibleOnFullScreen: true,
      })
    }, 0)
  }
}

function hideCommandBar(): void {
  stopFocusedAltSpaceGesture()
  stopAltSpaceHoldWatcher()
  if (!mainWindow) return

  commandBarVisible = false
  lastPaletteHideAt = Date.now()
  mainWindow.hide()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_MAX_HEIGHT,
    minWidth: WINDOW_WIDTH,
    maxWidth: WINDOW_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    maxHeight: WINDOW_MAX_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating')
  }

  mainWindow.on('blur', () => {
    if (shouldSuppressBlurHide()) return
    hideCommandBar()
  })

  mainWindow.on('show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const ttl = getUiStateRetentionMs()
    const stale = isPaletteUiStale(lastPaletteHideAt, ttl)
    mainWindow.webContents.send('window-shown', { resetUi: stale })
  })

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (altSpaceFocusedPressedAt === 0) return
    if (!isAltSpaceReleaseInput(input)) return
    finishFocusedAltSpaceGestureOnRelease()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerHotkey(): void {
  const okSpace = globalShortcut.register('Alt+Space', handleAltSpaceHotkey)
  const okEnter = globalShortcut.register('Alt+Enter', toggleCommandBarImmediate)
  const okNote = globalShortcut.register('CommandOrControl+N', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    showCommandBar()
    mainWindow.webContents.send('notes:quick-save-shortcut')
  })

  if (!okSpace) {
    console.warn('Failed to register global shortcut Alt+Space')
  }
  if (!okEnter) {
    console.warn('Failed to register global shortcut Alt+Enter')
  }
  if (!okNote) {
    console.warn('Failed to register global shortcut CommandOrControl+N (quick note)')
  }
}

app.whenReady().then(() => {
  app.setName('Raymes')
  Menu.setApplicationMenu(null)

  // Chromium denies `getUserMedia` requests by default in Electron. The
  // launcher needs the mic for Hold-to-Speak; granting `media` here lets
  // the renderer call `navigator.mediaDevices.getUserMedia({ audio: true })`
  // without getting an instant NotAllowedError. The OS still prompts the
  // user via its native microphone sheet the first time — Electron just
  // needs to stop vetoing the request before it reaches the OS.
  // Note: Electron only declares 'media' in its permission enum (Chromium
  // decides between mic/camera/display inside the `media` umbrella and
  // exposes the specific kind via the request `details`). Approving
  // 'media' is enough for mic capture — the OS still shows its own
  // microphone consent sheet.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
      return
    }
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media'
  })

  registerIpcHandlers(() => mainWindow)
  createWindow()
  placeWindow(mainWindow!)

  tray = new Tray(createTrayIcon())
  tray.setToolTip('Raymes')
  tray.on('click', () => {
    showCommandBar()
  })

  registerHotkey()

  // Collect clipboard history in the background so the dedicated
  // clipboard view is useful even when the launcher has never been
  // opened in this session.
  startClipboardWatcher()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  stopFocusedAltSpaceGesture()
  stopAltSpaceHoldWatcher()
  globalShortcut.unregisterAll()
  stopClipboardWatcher()
  shutdownIpcHandlers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
