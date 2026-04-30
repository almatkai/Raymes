import { useCallback, useEffect, useState } from 'react'
import type {
  ExtensionRunCommandResult,
  ExtensionRuntimeAction,
  ExtensionRuntimeNode,
} from '../shared/extensionRuntime'
import { Message } from './ui/primitives'
import { ExtensionRuntimeSurface } from './src/raycast-api'

type RuntimeViewState = {
  sessionId: string
  extensionId: string
  commandName: string
  title: string
  root: ExtensionRuntimeNode
  actions: ExtensionRuntimeAction[]
  message?: string
}

function fromRunResult(result: Extract<ExtensionRunCommandResult, { ok: true; mode: 'view' }>): RuntimeViewState {
  return {
    sessionId: result.sessionId,
    extensionId: result.extensionId,
    commandName: result.commandName,
    title: result.title,
    root: result.root,
    actions: result.actions,
    message: result.message,
  }
}

export default function ExtensionRuntimeView({
  initial,
  onBack,
}: {
  initial: Extract<ExtensionRunCommandResult, { ok: true; mode: 'view' }>
  onBack: () => void
}): JSX.Element {
  const [state, setState] = useState<RuntimeViewState>(() => fromRunResult(initial))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setState(fromRunResult(initial))
    setError(null)
  }, [initial])

  const handleSearchTextChanged = useCallback(async (searchText: string) => {
    console.log(`[RuntimeView] Search text changed, sending to sandbox: "${searchText}"`)
    const result = await window.raymes.extensionSearchTextChanged({
      sessionId: state.sessionId,
      searchText,
    })

    if (!result.ok) {
      console.error('[RuntimeView] Search failed:', result.message)
      setError(result.message)
      return
    }

    if (result.mode === 'no-view') {
      console.log('[RuntimeView] Search returned no-view result')
      setState((prev) => ({ ...prev, message: result.message }))
      return
    }

    console.log(`[RuntimeView] Search returned view with root type="${result.root.type}", ${result.root.children?.length ?? 0} children`)
    setState({
      sessionId: result.sessionId,
      extensionId: result.extensionId,
      commandName: result.commandName,
      title: result.title,
      root: result.root,
      actions: result.actions,
      message: result.message,
    })
  }, [state.sessionId])

  return (
    <div
      role="application"
      aria-label="Extension Runtime"
      className="flex h-full min-h-0 w-full flex-col gap-2 outline-none animate-raymes-scale-in"
    >
      <div className="min-h-0 flex-1">
        <ExtensionRuntimeSurface
          sessionId={state.sessionId}
          title={state.title}
          extensionId={state.extensionId}
          commandName={state.commandName}
          root={state.root}
          actions={state.actions}
          onBack={onBack}
          onSearchTextChanged={handleSearchTextChanged}
          onInvokeAction={async (actionId, formValues) => {
            setError(null)
            const result = await window.raymes.extensionInvokeAction({
              sessionId: state.sessionId,
              actionId,
              formValues,
            })

            if (!result.ok) {
              setError(result.message)
              return
            }

            if (result.mode === 'no-view') {
              setState((prev) => ({ ...prev, message: result.message }))
              return
            }

            setState({
              sessionId: result.sessionId,
              extensionId: result.extensionId,
              commandName: result.commandName,
              title: result.title,
              root: result.root,
              actions: result.actions,
              message: result.message,
            })
          }}
        />
      </div>

      {error ? (
        <div className="glass-card shrink-0 px-3 py-2">
          <Message tone="error">{error}</Message>
        </div>
      ) : null}

      {state.message ? (
        <div className="glass-card shrink-0 px-3 py-2">
          <Message>{state.message}</Message>
        </div>
      ) : null}
    </div>
  )
}
