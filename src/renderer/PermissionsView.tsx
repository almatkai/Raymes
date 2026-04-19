import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PermissionsSnapshot,
  PermissionState,
  PermissionStatus,
} from '../shared/permissions'
import { Button, Hint, HintBar, Kbd, Message, ViewHeader, cx } from './ui/primitives'

const STATE_LABEL: Record<PermissionState, string> = {
  granted: 'Granted',
  denied: 'Denied',
  restricted: 'Restricted',
  'not-determined': 'Not granted',
  unsupported: 'N/A',
}

function stateTone(state: PermissionState): string {
  switch (state) {
    case 'granted':
      return 'text-emerald-300 bg-emerald-300/10 ring-emerald-300/20'
    case 'denied':
    case 'restricted':
      return 'text-rose-300 bg-rose-300/10 ring-rose-300/20'
    case 'not-determined':
      return 'text-amber-300 bg-amber-300/10 ring-amber-300/20'
    default:
      return 'text-ink-3 bg-white/[0.04] ring-white/10'
  }
}

export default function PermissionsView({ onBack }: { onBack: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(
    null,
  )

  const reload = useCallback(async () => {
    try {
      const snap = await window.raymes.getPermissions()
      setSnapshot(snap)
    } catch (error) {
      setBanner({
        tone: 'error',
        text: `Could not read permissions: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }, [])

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

  const request = async (status: PermissionStatus): Promise<void> => {
    setPending(status.descriptor.id)
    setBanner(null)
    try {
      const next = await window.raymes.requestPermission(status.descriptor.id)
      await reload()
      if (next.state === 'granted') {
        setBanner({ tone: 'success', text: `${next.descriptor.title} is now granted.` })
      } else {
        setBanner({
          tone: 'info',
          text: `${next.descriptor.title}: ${next.descriptor.remediation}`,
        })
      }
    } catch (error) {
      setBanner({
        tone: 'error',
        text: `Could not request ${status.descriptor.title}: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="application"
      aria-label="Permissions"
      className="flex h-full min-h-0 w-full flex-col gap-2 outline-none animate-raymes-scale-in"
    >
      <div className="glass-card shrink-0 px-4 py-3 animate-raymes-scale-in">
        <ViewHeader
          title="Permissions"
          onBack={onBack}
          trailing={
            <Button variant="quiet" onClick={() => void reload()}>
              Refresh
            </Button>
          }
        />
      </div>

      <div className="glass-card min-h-0 flex-1 overflow-y-auto px-4 py-3 pr-[calc(0.5rem+2px)] animate-raymes-scale-in">
        {banner ? (
          <div className="mb-2">
            <Message tone={banner.tone}>{banner.text}</Message>
          </div>
        ) : null}
        {!snapshot ? (
          <p className="text-[12px] text-ink-3">Loading…</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snapshot.statuses.map((status) => (
              <li
                key={status.descriptor.id}
                className="rounded-raymes-row border border-white/5 bg-white/[0.02] px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-display text-[13px] font-semibold text-ink-1">
                        {status.descriptor.title}
                      </span>
                      <span
                        className={cx(
                          'rounded-raymes-chip px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] ring-1 ring-inset',
                          stateTone(status.state),
                        )}
                      >
                        {STATE_LABEL[status.state]}
                      </span>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-snug text-ink-3">
                      {status.descriptor.rationale}
                    </p>
                    {status.state !== 'granted' && status.state !== 'unsupported' ? (
                      <p className="mt-1 text-[11px] leading-snug text-ink-4">
                        {status.descriptor.remediation}
                      </p>
                    ) : null}
                  </div>
                  {status.state !== 'granted' && status.state !== 'unsupported' ? (
                    <Button
                      variant="primary"
                      onClick={() => void request(status)}
                      disabled={pending === status.descriptor.id}
                    >
                      {pending === status.descriptor.id ? 'Opening…' : 'Request'}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card shrink-0 px-4 py-2 animate-raymes-scale-in">
        <HintBar>
          <Hint label="Refresh" keys={<Kbd>R</Kbd>} />
          <Hint label="Back" keys={<Kbd>Esc</Kbd>} />
        </HintBar>
      </div>
    </div>
  )
}
