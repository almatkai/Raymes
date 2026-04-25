import { useMemo, useState } from 'react'
import type { ExtensionRuntimeNode } from '../../../shared/extensionRuntime'

type ListRow = {
  id: string
  title: string
  subtitle: string
  section?: string
}

function parseListRows(node: ExtensionRuntimeNode): ListRow[] {
  const rows: ListRow[] = []

  const walk = (entry: ExtensionRuntimeNode, section?: string): void => {
    if (entry.type === 'List.Item') {
      const title = typeof entry.props?.title === 'string' ? entry.props.title : 'Untitled'
      const subtitle = typeof entry.props?.subtitle === 'string' ? entry.props.subtitle : ''
      const id = typeof entry.props?.id === 'string' ? entry.props.id : `${section || 'list'}:${rows.length}`
      rows.push({ id, title, subtitle, section })
      return
    }

    if (entry.type === 'List.Section') {
      const nextSection = typeof entry.props?.title === 'string' ? entry.props.title : section
      for (const child of entry.children ?? []) {
        walk(child, nextSection)
      }
      return
    }

    for (const child of entry.children ?? []) {
      walk(child, section)
    }
  }

  walk(node)
  return rows
}

export function ListRuntime({
  root,
  title,
  onBack,
  onRunPrimaryAction,
  onOpenActions,
}: {
  root: ExtensionRuntimeNode
  title: string
  onBack: () => void
  onRunPrimaryAction: () => void
  onOpenActions: () => void
}): JSX.Element {
  const rows = useMemo(() => parseListRows(root), [root])
  const [selected, setSelected] = useState(0)

  const emptyView = useMemo(() => {
    const candidate = (root.children ?? []).find((entry) => entry.type === 'List.EmptyView')
    if (!candidate) return null
    return {
      title: typeof candidate.props?.title === 'string' ? candidate.props.title : 'No results',
      description:
        typeof candidate.props?.description === 'string' ? candidate.props.description : '',
    }
  }, [root.children])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="glass-card mb-2 shrink-0 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onBack}
          >
            Back
          </button>
          <div className="text-[12px] font-semibold text-ink-2">{title}</div>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className="btn btn-ghost" onClick={onRunPrimaryAction}>
              Enter
            </button>
            <button type="button" className="btn btn-ghost" onClick={onOpenActions}>
              Cmd+K
            </button>
          </div>
        </div>
      </div>

      <div className="glass-card min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <div>
              <p className="text-[13px] text-ink-2">{emptyView?.title || 'No list items'}</p>
              {emptyView?.description ? (
                <p className="mt-1 text-[11px] text-ink-4">{emptyView.description}</p>
              ) : null}
            </div>
          </div>
        ) : (
          <ul className="space-y-1">
            {rows.map((row, index) => (
              <li key={row.id}>
                <button
                  type="button"
                  onMouseEnter={() => setSelected(index)}
                  onClick={onRunPrimaryAction}
                  className={`w-full rounded-raymes-row px-3 py-2 text-left transition ${
                    index === selected ? 'bg-white/15 text-ink-1' : 'text-ink-2 hover:bg-white/8'
                  }`}
                >
                  <p className="truncate text-[13px] font-medium">{row.title}</p>
                  {row.subtitle ? <p className="truncate text-[11px] text-ink-3">{row.subtitle}</p> : null}
                  {row.section ? <p className="truncate text-[10px] text-ink-4">{row.section}</p> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
