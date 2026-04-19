import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { tryConsumeCommandSurfaceEscape } from './escapeGate'
import CommandBar from './CommandBar'
import AgentChatView from './AgentChatView'
import ProvidersView from './ProvidersView'
import SettingsView from './SettingsView'
import ExtensionsView from './ExtensionsView'
import OpenPortsView from './OpenPortsView'
import PermissionsView from './PermissionsView'
import ClipboardView from './ClipboardView'
import NotesView from './NotesView'
import { RAYMES_NEW_SNIPPET_EVENT } from '../shared/snippetEvents'
import type { AiChatBoot } from '../shared/aiChatSurface'
import { RAYMES_AI_NEW_CHAT_EVENT, RAYMES_QUICK_NOTE_SHORTCUT_EVENT } from '../shared/aiChatSurface'
import SnippetsView from './SnippetsView'

type Surface =
  | 'command'
  | 'ai-chat'
  | 'providers'
  | 'settings'
  | 'extensions'
  | 'open-ports'
  | 'permissions'
  | 'clipboard'
  | 'snippets'
  | 'notes'

const PANEL_SELECTORS: Record<Exclude<Surface, 'command'>, string> = {
  'ai-chat': '[aria-label="AI Chat"]',
  providers: '[aria-label="Providers"]',
  settings: '[aria-label="Settings"]',
  extensions: '[aria-label="Extensions"]',
  'open-ports': '[aria-label="Open Ports"]',
  permissions: '[aria-label="Permissions"]',
  clipboard: '[aria-label="Clipboard History"]',
  snippets: '[aria-label="Snippets"]',
  notes: '[aria-label="Quick Notes"]',
}

/** How much vertical padding the outer app container adds. Kept in sync
 *  with the `p-2` below so we can report accurate content height to the
 *  main process (otherwise the window would be 16px too short). */
const OUTER_PADDING_PX = 16

export default function App(): JSX.Element {
  const [surface, setSurface] = useState<Surface>('command')
  const [openPortsInitialTab, setOpenPortsInitialTab] = useState<'listen' | 'named'>('listen')
  const [notesInitialSelectedId, setNotesInitialSelectedId] = useState<number | null>(null)
  const [aiChatBoot, setAiChatBoot] = useState<AiChatBoot>({ kind: 'panel' })
  const [aiChatKey, setAiChatKey] = useState(0)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastReportedHeightRef = useRef<number>(-1)
  const surfaceRef = useRef<Surface>('command')

  const focusSurface = (nextSurface: Surface): void => {
    requestAnimationFrame(() => {
      if (nextSurface !== 'command') {
        const panel = document.querySelector<HTMLElement>(PANEL_SELECTORS[nextSurface])
        if (panel) {
          panel.focus()
          return
        }
      }
      document.getElementById('command-input')?.focus()
    })
  }

  useEffect(() => {
    const off = window.raymes.onWindowShown(({ resetUi }) => {
      if (resetUi) setSurface('command')
      focusSurface(resetUi ? 'command' : surface)
    })
    return off
  }, [surface])

  useEffect(() => {
    focusSurface(surface)
  }, [surface])

  useEffect(() => {
    surfaceRef.current = surface
  }, [surface])

  // Global ⌘N — route by surface (snippets → new snippet; AI chat → new chat;
  // command bar → quick-note shortcut event for CommandBar).
  useEffect(() => {
    return window.raymes.onQuickNoteSaveShortcut(() => {
      const s = surfaceRef.current
      if (s === 'ai-chat') {
        window.dispatchEvent(new Event(RAYMES_AI_NEW_CHAT_EVENT))
        return
      }
      if (s === 'snippets') {
        window.dispatchEvent(new Event(RAYMES_NEW_SNIPPET_EVENT))
        return
      }
      window.dispatchEvent(new Event(RAYMES_QUICK_NOTE_SHORTCUT_EVENT))
    })
  }, [])

  // Global key routing fallback.
  //
  // Each sub-view (Settings, Providers, Permissions, Clipboard, …) attaches
  // its own capture-phase Escape handler so it can express nuance — e.g.
  // "Escape clears the search box before navigating back". They all call
  // stopPropagation() when they handle the event, which skips this
  // handler.
  //
  // When no sub-view handled it (timing edge cases, or a simple view that
  // didn't bother wiring its own listener), we still do the right thing:
  // from any sub-surface we pop back to `command`, and only from the
  // command surface does Escape actually hide the launcher. That
  // guarantee is the "back not close" contract users rely on.
  //
  // On the command surface, `CommandBar` may still need Escape first
  // (pin picker, pending extension form). It registers a consumer via
  // `escapeGate` so we never hide the window while that UI is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (surface === 'ai-chat') {
          if (tryConsumeCommandSurfaceEscape()) return
          setSurface('command')
          return
        }
        if (surface !== 'command') {
          setSurface('command')
          return
        }
        if (tryConsumeCommandSurfaceEscape()) {
          return
        }
        void window.raymes.hide()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setSurface('providers')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [surface])

  // Report measured content height so the launcher shrinks for sparse
  // states (empty command bar) and grows up to its max otherwise. The
  // main process clamps to [WINDOW_MIN_HEIGHT..WINDOW_MAX_HEIGHT] so
  // runaway layouts cannot take the window past the launcher envelope.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return

    const report = (): void => {
      const measured = Math.ceil(el.getBoundingClientRect().height) + OUTER_PADDING_PX
      if (measured === lastReportedHeightRef.current) return
      lastReportedHeightRef.current = measured
      void window.raymes.setWindowContentHeight(measured)
    }

    report()
    const observer = new ResizeObserver(() => report())
    observer.observe(el)
    return () => observer.disconnect()
  }, [surface])

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-transparent p-2">
      {/* Dedicated drag handle strip — the full top edge of the window
          is a draggable region so the user can reposition the launcher
          without hitting interactive content underneath. The rest of
          the app stays non-draggable so clicks on rows/buttons behave
          normally. */}
      <div
        aria-hidden
        className="drag-region pointer-events-auto absolute left-0 right-0 top-0 z-10 h-2"
      />
      <div
        ref={contentRef}
        key={surface}
        className="relative z-0 flex h-full w-full animate-raymes-fade-in flex-col"
      >
        {surface === 'providers' ? (
          <ProvidersView onBack={() => setSurface('command')} />
        ) : surface === 'settings' ? (
          <SettingsView
            onBack={() => setSurface('command')}
            onOpenPermissions={() => setSurface('permissions')}
          />
        ) : surface === 'extensions' ? (
          <ExtensionsView onBack={() => setSurface('command')} />
        ) : surface === 'open-ports' ? (
          <OpenPortsView
            initialTab={openPortsInitialTab}
            onBack={() => {
              setOpenPortsInitialTab('listen')
              setSurface('command')
            }}
          />
        ) : surface === 'permissions' ? (
          <PermissionsView onBack={() => setSurface('settings')} />
        ) : surface === 'clipboard' ? (
          <ClipboardView onBack={() => setSurface('command')} />
        ) : surface === 'snippets' ? (
          <SnippetsView onBack={() => setSurface('command')} />
        ) : surface === 'notes' ? (
          <NotesView
            onBack={() => setSurface('command')}
            initialSelectedNoteId={notesInitialSelectedId}
          />
        ) : surface === 'ai-chat' ? (
          <AgentChatView
            key={aiChatKey}
            boot={aiChatBoot}
            onBack={() => setSurface('command')}
            onOpenProviders={() => setSurface('providers')}
          />
        ) : (
          <CommandBar
            onOpenAiChat={(nextBoot) => {
              setAiChatBoot(nextBoot)
              setAiChatKey((k) => k + 1)
              setSurface('ai-chat')
            }}
            onOpenProviders={() => setSurface('providers')}
            onOpenSettings={() => setSurface('settings')}
            onOpenExtensions={() => setSurface('extensions')}
            onOpenPortsPage={(opts) => {
              setOpenPortsInitialTab(opts?.tab ?? 'listen')
              setSurface('open-ports')
            }}
            onOpenClipboardPage={() => setSurface('clipboard')}
            onOpenSnippetsPage={() => setSurface('snippets')}
            onOpenNotesPage={(opts) => {
              setNotesInitialSelectedId(typeof opts?.createdAt === 'number' ? opts.createdAt : null)
              setSurface('notes')
            }}
          />
        )}
      </div>
    </div>
  )
}
