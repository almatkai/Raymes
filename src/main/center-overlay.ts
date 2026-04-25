import { BrowserWindow, screen } from 'electron'

let overlay: BrowserWindow | null = null
let currentDisplayId: number | null = null
let overlayReady = false
let pendingUpdate: (() => void) | null = null

/* ---------------------------------------------------------------------------
   Overlay HTML — full-screen center guides + magnetic zone.
   --------------------------------------------------------------------------- */
const OVERLAY_HTML = `<!DOCTYPE html>
<html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:transparent}

:root{
  --c-idle:rgba(150,150,150,0.3);
  --c-zone-idle:rgba(150,150,150,0.08);
  --c-active:rgba(59,130,246,0.92);
  --c-zone-active:rgba(59,130,246,0.16);
  --ease:cubic-bezier(0.22,1,0.36,1);
  --dur:160ms;
}

.root{position:relative;width:100%;height:100%;opacity:0;
  transition:opacity 180ms ease}
.root.visible{opacity:1}

.zone{position:absolute;background:var(--c-zone-idle);transition:background var(--dur) var(--ease)}
.zone-h{left:0;right:0;top:calc(50% - 12px);height:24px}
.zone-v{top:0;bottom:0;left:calc(50% - 12px);width:24px}

.line{position:absolute;transition:background var(--dur) var(--ease),
  box-shadow var(--dur) var(--ease),width var(--dur) var(--ease),
  height var(--dur) var(--ease)}
.line-h{left:0;right:0;top:50%;height:1px;transform:translateY(-50%);background:var(--c-idle)}
.line-v{left:50%;width:1px;height:18px;transform:translateX(-50%);background:var(--c-idle)}
.line-v-top{top:calc(50% - 30px)}
.line-v-bottom{top:calc(50% + 12px)}

.label{
  position:absolute;left:calc(50% + 18px);top:calc(50% + 18px);
  padding:2px 6px;border-radius:6px;
  background:rgba(15,18,24,0.72);color:rgba(198,205,218,0.95);
  font:500 10px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
  letter-spacing:.02em;transition:all var(--dur) var(--ease)
}

.root.active .zone{background:var(--c-zone-active)}
.root.active .line{background:var(--c-active);box-shadow:0 0 12px rgba(59,130,246,0.45)}
.root.active .line-h{height:2px}
.root.active .line-v{width:2px}
.root.active .label{color:rgba(191,219,254,.98);background:rgba(30,58,138,.58);
  box-shadow:0 0 10px rgba(59,130,246,.35)}
</style></head>
<body>
  <div id="r" class="root">
    <div class="zone zone-h"></div>
    <div class="zone zone-v"></div>
    <div class="line line-h"></div>
    <div class="line line-v line-v-top"></div>
    <div class="line line-v line-v-bottom"></div>
    <div class="label">Snap zone</div>
  </div>
</body></html>`

/* ---------------------------------------------------------------------------
   Internal helpers
   --------------------------------------------------------------------------- */

function applyState(state: 'approaching' | 'snap-ready'): void {
  if (!overlay || overlay.isDestroyed()) return

  const isActive = state === 'snap-ready'

  const js = `(()=>{
    const r=document.getElementById('r');
    if(!r)return;
    r.className='root${isActive ? ' visible active' : ' visible'}';
  })()`
  overlay.webContents.executeJavaScript(js).catch(() => {})
}

/** Destroy and recreate the overlay for a new display / workspace. */
function destroyOverlay(): void {
  if (overlay && !overlay.isDestroyed()) {
    overlay.destroy()
  }
  overlay = null
  overlayReady = false
  pendingUpdate = null
  currentDisplayId = null
}

function createOverlay(display: Electron.Display): void {
  // Always start fresh — avoids stale workspace / display state on macOS
  destroyOverlay()

  const { workArea } = display
  overlay = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  overlay.setIgnoreMouseEvents(true)

  if (process.platform === 'darwin') {
    // Same workspace behaviour as the main launcher window:
    // visible on all Spaces so it follows the user across desktops.
    overlay.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    overlay.setAlwaysOnTop(true, 'screen-saver')
  }

  currentDisplayId = display.id

  const encoded = encodeURIComponent(OVERLAY_HTML)
  overlay
    .loadURL(`data:text/html;charset=utf-8,${encoded}`)
    .then(() => {
      if (!overlay || overlay.isDestroyed()) return
      overlayReady = true
      overlay.showInactive()
      // Flush any state update that was queued while the page was loading
      if (pendingUpdate) {
        const fn = pendingUpdate
        pendingUpdate = null
        fn()
      }
    })
    .catch(() => {})
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */

export function showCenterOverlay(
  win: BrowserWindow,
  state: 'approaching' | 'snap-ready',
): void {
  const bounds = win.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })

  // Create a fresh overlay if it doesn't exist or if the display changed.
  // Recreating on display change avoids macOS issues with transparent windows
  // moving between monitors / Spaces.
  if (!overlay || overlay.isDestroyed() || currentDisplayId !== display.id) {
    createOverlay(display)
  }

  if (!overlayReady) {
    // Page not loaded yet — queue the update
    pendingUpdate = () => applyState(state)
    return
  }

  // Ensure the overlay is visible and on top every time
  if (overlay && !overlay.isDestroyed()) {
    overlay.showInactive()
    if (process.platform === 'darwin') {
      overlay.moveTop()
    }
  }

  applyState(state)
}

/** Pre-create overlay so first drag can show guides instantly. */
export function prepareCenterOverlay(win: BrowserWindow): void {
  const bounds = win.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  })
  if (!overlay || overlay.isDestroyed() || currentDisplayId !== display.id) {
    createOverlay(display)
  }
}

/** Fade guides out then tear down the overlay so the next drag gets a fresh one. */
export function hideCenterOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return

  const js = `(()=>{
    const r=document.getElementById('r');
    if(!r)return;
    r.className='root';
  })()`
  overlay.webContents.executeJavaScript(js).catch(() => {})

  // Small delay before destruction to allow fade out if desired, 
  // but user wanted "immediately disappears", so we destroy quickly.
  setTimeout(() => {
    destroyOverlay()
  }, 50)
}

/** Destroy the overlay window immediately (call on app quit). */
export function cleanupCenterOverlay(): void {
  destroyOverlay()
}
