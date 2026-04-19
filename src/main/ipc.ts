import { BrowserWindow, ipcMain, shell } from 'electron'
import { setSuppressBlurHide } from './windowState'
import {
  IPC_CHANNELS,
  parseAiActionRequest,
  parseSearchExecuteRequest,
  parseVoiceModelRequest,
  parseVoiceSpeakRequest,
  parseVoiceTranscribeRequest,
} from '../shared/ipc'
import type { SearchAction } from '../shared/search'
import { streamAnswerToRenderer } from './llm/answerStream'
import { setLauncherContentHeight } from './windowBounds'
import {
  getSafetyDryRun,
  getUiStateRetentionMs,
  readRawConfig,
  setSafetyDryRun,
  writeConfigPatch,
} from './llm/configStore'
import {
  clearDeviceSession,
  persistCopilotTokens,
  pollGithubDeviceFlow,
  startGithubDeviceFlow,
} from './llm/githubCopilotAuth'
import { listModelsForProvider } from './llm/listModels'
import { buildProviderForId, invalidateProviderCache, readLLMConfig } from './llm/registry'
import type { ProviderId } from '../shared/llmConfig'
import { classifyIntent } from './router'
import {
  getExtensionInstallError,
  inspectExtensionIntegrity,
  installExtension,
  listInstalledExtensions,
  reinstallExtension,
  searchStoreExtensions,
  uninstallExtension,
} from './extensions/service'
import {
  executeSearchAction,
  getSearchBenchmarkHistory,
  listOpenPorts,
  reindexQuickNotes,
  reindexSnippets,
  runSearchBenchmarks,
  searchEverything,
} from './search/service'
import {
  addQuickNote,
  deleteQuickNote,
  listQuickNotes,
  updateQuickNote,
} from './search/providers/notesProvider'
import { fetchFrankfurterLatest } from './currency/frankfurter'
import { addNamedPort, listNamedPorts, removeNamedPort } from './portManager/namedPortsStore'
import { runAiActionMode } from './llm/actionMode'
import {
  downloadVoiceModel,
  getSelectedVoiceModelId,
  listSttModes,
  listVoiceModels,
  setSelectedVoiceModelId,
  speakText,
  stopSpeaking,
  transcribeAudio,
} from './voice/service'
import type { VoiceModelId } from '../shared/voice'
import { requestPermission, snapshotPermissions } from './permissions/manager'
import type { PermissionId } from '../shared/permissions'
import { clearSafetyLog, listSafetyLog } from './safety/log'
import { listSafetyDescriptors } from './safety/registry'
import { listNativeCommands } from './nativeCommands/registry'
import {
  clearClipboardHistory,
  deleteClipboardEntry,
  listClipboardEntries,
  readClipboardImagePayload,
  restoreClipboardEntry,
  revealClipboardEntryInFinder,
  togglePinClipboardEntry,
} from './search/providers/clipboardProvider'
import {
  addUserSnippet,
  copySnippetById,
  deleteUserSnippet,
  listSnippetsForUi,
  updateUserSnippet,
} from './search/providers/snippetsProvider'

const LLM_DEFAULTS = {
  uiStateRetentionMs: 60_000,
} as const

let answerAbort: AbortController | null = null

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('llm-config-get', async () => ({
    ...LLM_DEFAULTS,
    ...readLLMConfig(),
    ...readRawConfig(),
    uiStateRetentionMs: getUiStateRetentionMs(),
  }))

  ipcMain.handle('llm-config-set', async (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return
    writeConfigPatch(patch as Record<string, unknown>)
    invalidateProviderCache()
  })

  ipcMain.handle('llm-provider-statuses', async () => {
    const cfg = readLLMConfig()
    const ids: ProviderId[] = ['openai', 'openai-compatible', 'anthropic', 'ollama', 'copilot', 'gemini']
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          const ok = await buildProviderForId(id, cfg).isAvailable()
          return [id, ok] as const
        } catch {
          return [id, false] as const
        }
      }),
    )
    return Object.fromEntries(entries) as Record<ProviderId, boolean>
  })

  ipcMain.handle('llm-list-models', async (_event, providerId: unknown) => {
    const id = providerId as ProviderId
    if (
      id !== 'openai' &&
      id !== 'openai-compatible' &&
      id !== 'anthropic' &&
      id !== 'ollama' &&
      id !== 'copilot' &&
      id !== 'gemini'
    )
      return []
    try {
      return await listModelsForProvider(id)
    } catch {
      return []
    }
  })

  // Renderer reports its measured content height. We clamp to the launcher
  // bounds and update the window content size programmatically — the user
  // still cannot drag to resize because the BrowserWindow is resizable:false.
  ipcMain.handle('window-set-content-height', async (_event, raw: unknown) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) return
    setLauncherContentHeight(win, value)
  })

  ipcMain.handle('permissions:snapshot', async () => snapshotPermissions())

  ipcMain.handle('permissions:request', async (_event, raw: unknown) => {
    if (typeof raw !== 'string') {
      throw new Error('Permission id must be a string')
    }
    return requestPermission(raw as PermissionId)
  })

  ipcMain.handle('safety:descriptors', async () => listSafetyDescriptors())

  ipcMain.handle('safety:log', async () => listSafetyLog())

  ipcMain.handle('safety:log-clear', async () => {
    clearSafetyLog()
  })

  ipcMain.handle('safety:dry-run:get', async () => getSafetyDryRun())
  ipcMain.handle('safety:dry-run:set', async (_event, raw: unknown) => {
    setSafetyDryRun(raw === true)
    return getSafetyDryRun()
  })

  ipcMain.handle('native-commands:list', async () => listNativeCommands())

  ipcMain.handle('clipboard:list', async () => listClipboardEntries())

  ipcMain.handle('clipboard:restore', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return false
    return restoreClipboardEntry(id)
  })

  ipcMain.handle('clipboard:delete', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return false
    return deleteClipboardEntry(id)
  })

  ipcMain.handle('clipboard:toggle-pin', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return false
    return togglePinClipboardEntry(id)
  })

  ipcMain.handle('clipboard:reveal', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return false
    return revealClipboardEntryInFinder(id)
  })

  ipcMain.handle('clipboard:image', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return null
    return readClipboardImagePayload(id)
  })

  ipcMain.handle('clipboard:clear', async () => {
    clearClipboardHistory()
  })

  ipcMain.handle('snippets:list', async () => listSnippetsForUi())

  ipcMain.handle('snippets:copy', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, message: 'Invalid snippet' }
    return copySnippetById(id)
  })

  ipcMain.handle('snippets:add', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, message: 'Invalid payload' }
    const o = payload as { label?: unknown; trigger?: unknown; body?: unknown }
    const r = addUserSnippet({
      label: typeof o.label === 'string' ? o.label : '',
      trigger: typeof o.trigger === 'string' ? o.trigger : '',
      body: typeof o.body === 'string' ? o.body : '',
    })
    if (r.ok) await reindexSnippets()
    return r
  })

  ipcMain.handle('snippets:update', async (_event, id: unknown, payload: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, message: 'Invalid snippet id' }
    if (!payload || typeof payload !== 'object') return { ok: false, message: 'Invalid payload' }
    const o = payload as { label?: unknown; trigger?: unknown; body?: unknown }
    const r = updateUserSnippet(id, {
      label: typeof o.label === 'string' ? o.label : '',
      trigger: typeof o.trigger === 'string' ? o.trigger : '',
      body: typeof o.body === 'string' ? o.body : '',
    })
    if (r.ok) await reindexSnippets()
    return r
  })

  ipcMain.handle('snippets:delete', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, message: 'Invalid snippet id' }
    const r = deleteUserSnippet(id)
    if (r.ok) await reindexSnippets()
    return r
  })

  ipcMain.handle('notes:list', async () => listQuickNotes())

  ipcMain.handle('notes:append', async (_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return null
    const entry = addQuickNote(text)
    await reindexQuickNotes()
    return entry
  })

  ipcMain.handle('notes:update', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false
    const o = payload as { createdAt?: unknown; text?: unknown }
    if (typeof o.createdAt !== 'number' || typeof o.text !== 'string') return false
    const ok = updateQuickNote(o.createdAt, o.text)
    if (ok) await reindexQuickNotes()
    return ok
  })

  ipcMain.handle('notes:delete', async (_event, createdAt: unknown) => {
    if (typeof createdAt !== 'number') return false
    const ok = deleteQuickNote(createdAt)
    if (ok) await reindexQuickNotes()
    return ok
  })

  ipcMain.handle('open-external-url', async (_event, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:') return
    if (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.github.com')) return
    await shell.openExternal(url)
  })

  ipcMain.handle('github-device-start', async (_event, clientId: unknown) => {
    if (typeof clientId !== 'string' || !clientId.trim()) {
      throw new Error('GitHub OAuth Client ID is required for device sign-in.')
    }
    return startGithubDeviceFlow(clientId.trim())
  })

  ipcMain.handle('github-device-poll', async () => {
    const r = await pollGithubDeviceFlow()
    if (r.status === 'success') {
      persistCopilotTokens(r.access_token, r.refresh_token, r.expires_in)
      invalidateProviderCache()
    }
    return r
  })

  ipcMain.handle('github-device-cancel', async () => {
    clearDeviceSession()
  })

  ipcMain.handle(IPC_CHANNELS.QUERY, async (event, input: unknown) => {
    const text = typeof input === 'string' ? input : String(input ?? '')
    const intent = await classifyIntent(text)
    console.log('[query] intent:', intent)
    if (intent.type === 'answer' || intent.type === 'ai') {
      answerAbort?.abort()
      answerAbort = new AbortController()
      const ac = answerAbort
      void streamAnswerToRenderer(event.sender, intent.input, ac.signal).finally(() => {
        if (answerAbort === ac) answerAbort = null
      })
    }
    return intent
  })

  ipcMain.handle('cancel', async () => {
    answerAbort?.abort()
  })

  ipcMain.handle('get-extensions', async () => {
    return listInstalledExtensions()
  })

  ipcMain.handle('extensions:listInstalled', async () => {
    return listInstalledExtensions()
  })

  ipcMain.handle('extensions:searchStore', async (_event, query: unknown) => {
    const q = typeof query === 'string' ? query : ''
    return searchStoreExtensions(q)
  })

  ipcMain.handle('extensions:install', async (_event, extensionId: unknown) => {
    if (typeof extensionId !== 'string' || !extensionId.trim()) {
      throw new Error('A valid extension id is required')
    }
    return installExtension(extensionId)
  })

  ipcMain.handle('extensions:uninstall', async (_event, extensionId: unknown) => {
    if (typeof extensionId !== 'string' || !extensionId.trim()) {
      throw new Error('A valid extension id is required')
    }
    return uninstallExtension(extensionId)
  })

  ipcMain.handle('extensions:integrity', async (_event, extensionId: unknown) => {
    if (typeof extensionId !== 'string' || !extensionId.trim()) {
      throw new Error('A valid extension id is required')
    }
    return inspectExtensionIntegrity(extensionId)
  })

  ipcMain.handle('extensions:reinstall', async (_event, extensionId: unknown) => {
    if (typeof extensionId !== 'string' || !extensionId.trim()) {
      throw new Error('A valid extension id is required')
    }
    return reinstallExtension(extensionId)
  })

  ipcMain.handle('extensions:install-error', async (_event, extensionId: unknown) => {
    if (typeof extensionId !== 'string' || !extensionId.trim()) return null
    return getExtensionInstallError(extensionId)
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_ALL, async (_event, query: unknown) => {
    const q = typeof query === 'string' ? query : ''
    return searchEverything(q)
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_BENCHMARK_RUN, async () => {
    return runSearchBenchmarks()
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_BENCHMARK_HISTORY, async () => {
    return getSearchBenchmarkHistory()
  })

  ipcMain.handle('currency:frankfurter-latest', async (_event, from: unknown) => {
    if (typeof from !== 'string' || !from.trim()) {
      throw new Error('Frankfurter: currency code required')
    }
    return fetchFrankfurterLatest(from.trim())
  })

  ipcMain.handle('open-ports:list', async () => {
    return listOpenPorts()
  })

  ipcMain.handle('port-manager:named:list', async () => listNamedPorts())

  ipcMain.handle('port-manager:named:add', async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : ''
    const port = typeof o.port === 'number' ? o.port : Number(o.port)
    return addNamedPort(name, port)
  })

  ipcMain.handle('port-manager:named:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) return false
    return removeNamedPort(id.trim())
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_EXECUTE, async (_event, payload: unknown) => {
    try {
      const request = parseSearchExecuteRequest(payload)
      return executeSearchAction(request.action, request.context)
    } catch {
      if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid search action payload')
      }
      return executeSearchAction(payload as SearchAction)
    }
  })

  ipcMain.handle(IPC_CHANNELS.AI_ACTION, async (_event, payload: unknown) => {
    const req = parseAiActionRequest(payload)
    const cfg = readLLMConfig()

    if (cfg.aiActionRequirePermission !== false && req.allowAutomation !== true) {
      return {
        ok: false,
        output: 'Action mode requires explicit permission. Retry with allowAutomation=true.',
      }
    }

    return runAiActionMode({
      ...req,
      redactSensitive: req.redactSensitive ?? cfg.aiActionRedactionEnabled !== false,
    })
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_TTS_SPEAK, async (_event, payload: unknown) => {
    const req = parseVoiceSpeakRequest(payload)
    await speakText(req.text)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_TTS_STOP, async () => {
    stopSpeaking()
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_STT_MODES, async () => {
    return listSttModes()
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_STT_TRANSCRIBE, async (_event, payload: unknown) => {
    const req = parseVoiceTranscribeRequest(payload)
    return transcribeAudio(req)
  })

  // Renderer toggles this around Hold-to-Speak so the mic permission sheet
  // or any brief focus change while recording does not hide the launcher.
  ipcMain.handle('window:suppress-blur-hide', async (_event, payload: unknown) => {
    setSuppressBlurHide(payload === true)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_MODELS_LIST, async () => {
    return listVoiceModels()
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_MODEL_DOWNLOAD, async (_event, payload: unknown) => {
    const req = parseVoiceModelRequest(payload)
    return downloadVoiceModel(req.modelId as VoiceModelId)
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_MODEL_GET_SELECTED, async () => {
    return { modelId: getSelectedVoiceModelId() }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_MODEL_SET_SELECTED, async (_event, payload: unknown) => {
    const req = parseVoiceModelRequest(payload)
    return { modelId: setSelectedVoiceModelId(req.modelId as VoiceModelId) }
  })

  ipcMain.handle('window:show', async () => {
    const win = getWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  ipcMain.handle('window:hide', async () => {
    const win = getWindow()
    if (win) win.hide()
  })
}
