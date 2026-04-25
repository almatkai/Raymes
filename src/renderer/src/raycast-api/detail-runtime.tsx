import ReactMarkdown from 'react-markdown'
import type { ExtensionRuntimeNode } from '../../../shared/extensionRuntime'

function markdownFromNode(root: ExtensionRuntimeNode): string {
  if (typeof root.props?.markdown === 'string') return root.props.markdown

  for (const child of root.children ?? []) {
    if (typeof child.props?.markdown === 'string') {
      return child.props.markdown
    }
  }

  return ''
}

export function DetailRuntime({
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
  const markdown = markdownFromNode(root)

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

      <div className="glass-card min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {markdown ? (
          <article className="prose prose-invert max-w-none text-[13px] leading-relaxed">
            <ReactMarkdown>{markdown}</ReactMarkdown>
          </article>
        ) : (
          <div className="text-[12px] text-ink-3">No detail content</div>
        )}
      </div>
    </div>
  )
}
