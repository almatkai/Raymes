import { useMemo, useState } from 'react'
import type { ExtensionRuntimeNode } from '../../../shared/extensionRuntime'

type GridItem = {
  id: string
  title: string
  subtitle: string
}

function collectGridItems(root: ExtensionRuntimeNode): GridItem[] {
  const out: GridItem[] = []

  const walk = (node: ExtensionRuntimeNode): void => {
    if (node.type === 'Grid.Item') {
      const id = typeof node.props?.id === 'string' ? node.props.id : `grid:${out.length}`
      const title = typeof node.props?.title === 'string' ? node.props.title : 'Untitled'
      const subtitle = typeof node.props?.subtitle === 'string' ? node.props.subtitle : ''
      out.push({ id, title, subtitle })
      return
    }

    for (const child of node.children ?? []) {
      walk(child)
    }
  }

  walk(root)
  return out
}

export function GridRuntime({
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
  const items = useMemo(() => collectGridItems(root), [root])
  const [selected, setSelected] = useState(0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="glass-card mb-2 shrink-0 px-3 py-2">
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
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

      <div className="glass-card min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-3">
            No grid items
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={onRunPrimaryAction}
                className={`rounded-raymes-row border px-3 py-3 text-left transition ${
                  selected === index
                    ? 'border-white/25 bg-white/15 text-ink-1'
                    : 'border-white/10 bg-white/[0.03] text-ink-2 hover:bg-white/8'
                }`}
              >
                <p className="truncate text-[12px] font-medium">{item.title}</p>
                {item.subtitle ? <p className="truncate text-[11px] text-ink-4">{item.subtitle}</p> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
