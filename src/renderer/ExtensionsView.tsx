import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExtensionManifest, InstalledExtension } from '../shared/extensions'
import {
  Button,
  Hint,
  HintBar,
  Kbd,
  Message,
  TextField,
  ViewHeader,
} from './ui/primitives'

export default function ExtensionsView({ onBack }: { onBack: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<Record<string, number>>({})
  const [store, setStore] = useState<ExtensionManifest[]>([])
  const [installed, setInstalled] = useState<InstalledExtension[]>([])
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cleanup = window.raymes.onExtensionInstallProgress((payload) => {
      setInstalling((prev) => ({ ...prev, [payload.id]: payload.progress }))
      if (payload.progress >= 100) {
        setInstalling((prev) => {
          const next = { ...prev }
          delete next[payload.id]
          return next
        })
      }
    })
    return cleanup
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [installedList, storeList] = await Promise.all([
        window.raymes.extensionList(),
        window.raymes.extensionSearchStore(query),
      ])
      setInstalled(
        installedList.map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          author: entry.author || 'Raycast Community',
          owner: entry.owner,
          downloadCount: entry.downloadCount,
          version: entry.version,
          installedAt: entry.installedAt,
        })),
      )
      setStore(storeList)
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [onBack])

  const installedIds = useMemo(() => new Set(installed.map((i) => i.id)), [installed])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="application"
      aria-label="Extensions"
      className="flex h-full min-h-0 w-full flex-col gap-2 outline-none animate-raymes-scale-in"
    >
      <div className="glass-card shrink-0 px-4 py-3 animate-raymes-scale-in">
        <ViewHeader
          title="Extensions"
          onBack={onBack}
          trailing={
            <Button variant="ghost" onClick={() => void reload()} disabled={loading}>
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          }
        />

        <div className="mt-2">
          <TextField
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the store"
            autoFocus
          />
        </div>
      </div>

      <section className="glass-card min-h-0 flex-1 overflow-y-auto px-4 py-3 pr-[calc(0.5rem+2px)] animate-raymes-scale-in">
        {store.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center">
            {loading ? (
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3 [animation-delay:120ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3 [animation-delay:240ms]" />
              </div>
            ) : (
              <p className="text-[12px] text-ink-3">No extensions match.</p>
            )}
          </div>
        ) : (
          <ul className="stagger space-y-1.5">
            {store.map((ext) => {
              const isInstalled = installedIds.has(ext.id)
              return (
                <li
                  key={ext.id}
                  className="glass-inset rounded-raymes-row p-3 transition hover:bg-white/[0.04]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13.5px] font-medium text-ink-1">{ext.name}</p>
                        {ext.downloadCount !== undefined ? (
                          <span className="shrink-0 text-[10px] text-ink-4">
                            ↓ {ext.downloadCount.toLocaleString()}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-4">
                        {ext.owner || ext.author} · {ext.id} · v{ext.version}
                      </p>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3 line-clamp-2">
                        {ext.description}
                      </p>
                    </div>
                    <Button
                      variant={isInstalled ? 'danger' : 'primary'}
                      disabled={loading || !!installing[ext.id]}
                      onClick={() => {
                        if (!isInstalled) {
                          setInstalling((prev) => ({ ...prev, [ext.id]: 1 }))
                        }
                        const action = isInstalled
                          ? window.raymes.extensionUninstall(ext.id)
                          : window.raymes.extensionInstall(ext.id)
                        void action
                          .then(() => {
                            setInstalling((prev) => {
                              const next = { ...prev }
                              delete next[ext.id]
                              return next
                            })
                            setMsg({
                              tone: 'success',
                              text: `${isInstalled ? 'Removed' : 'Installed'} ${ext.name}`,
                            })
                            return reload()
                          })
                          .catch((e: unknown) => {
                            setInstalling((prev) => {
                              const next = { ...prev }
                              delete next[ext.id]
                              return next
                            })
                            setMsg({
                              tone: 'error',
                              text: e instanceof Error ? e.message : 'Action failed',
                            })
                          })
                      }}
                    >
                      {installing[ext.id] !== undefined ? (
                        <div className="relative h-4 w-4">
                          <svg className="h-full w-full -rotate-90">
                            <circle
                              cx="8"
                              cy="8"
                              r="7"
                              stroke="currentColor"
                              strokeWidth="2"
                              fill="transparent"
                              strokeDasharray={`${(installing[ext.id]! / 100) * 44} 44`}
                            />
                          </svg>
                        </div>
                      ) : isInstalled ? 'Remove' : 'Install'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {msg ? (
        <div className="glass-card shrink-0 px-4 py-2 animate-raymes-scale-in">
          <Message tone={msg.tone}>{msg.text}</Message>
        </div>
      ) : null}

      <div className="glass-card shrink-0 px-4 py-2 animate-raymes-scale-in">
        <HintBar>
          <Hint label="Back" keys={<Kbd>Esc</Kbd>} />
        </HintBar>
      </div>
    </div>
  )
}
