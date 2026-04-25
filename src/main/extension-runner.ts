import { clipboard, shell } from 'electron'
import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import type {
  ExtensionInvokeActionRequest,
  ExtensionInvokeActionResult,
  ExtensionRunCommandRequest,
  ExtensionRunCommandResult,
  ExtensionRuntimeAction,
  ExtensionRuntimeNode,
} from '../shared/extensionRuntime'
import { getExtensionPreferences, resolveInstalledPackageJsonPath } from './extension-registry'

type PackageCommand = {
  name?: string
  title?: string
  mode?: string
  path?: string
  entry?: string
  entrypoint?: string
  file?: string
  source?: string
}

type ExtensionPackageJson = {
  name?: string
  title?: string
  commands?: PackageCommand[]
}

type RuntimeFeedback = {
  kind: 'toast' | 'hud'
  style?: string
  title?: string
  message?: string
}

type RuntimeActionHandler = (formValues?: Record<string, string>) => Promise<void> | void

type RuntimeSession = {
  id: string
  extensionId: string
  commandName: string
  title: string
  packageRoot: string
  actionHandlers: Map<string, RuntimeActionHandler>
  currentActions: ExtensionRuntimeAction[]
  feedback: RuntimeFeedback[]
  stack: unknown[]
  preferences: Record<string, unknown>
}

type JsxNode = {
  __jsx: true
  type: unknown
  props: Record<string, unknown>
  key?: unknown
}

type RaycastComponentToken = {
  __raycastComponent: true
  name: string
}

const RUNTIME_COMPONENT_LIMIT = 10_000
const RUNTIME_RECURSION_LIMIT = 80
const SESSIONS_SOFT_LIMIT = 30
const BUILTIN_SET = new Set<string>(builtinModules)
const JSX_FRAGMENT = Symbol.for('raymes.jsx.fragment')

const sessions = new Map<string, RuntimeSession>()

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function parsePackageJson(path: string): ExtensionPackageJson {
  if (!existsSync(path)) {
    throw new Error(`Missing package.json at ${path}`)
  }

  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as ExtensionPackageJson
  return parsed && typeof parsed === 'object' ? parsed : {}
}

function findCommandInManifest(pkg: ExtensionPackageJson, commandName: string): PackageCommand {
  const command = (pkg.commands ?? []).find((entry) => entry.name === commandName)
  if (!command) {
    throw new Error(`Command not found: ${commandName}`)
  }
  return command
}

function resolveCommandEntry(
  packageRoot: string,
  commandName: string,
  command: PackageCommand,
): string {
  const prebuilt = join(packageRoot, '.sc-build', `${commandName}.js`)
  if (existsSync(prebuilt)) return prebuilt

  const explicit = [command.path, command.entrypoint, command.entry, command.file, command.source]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => join(packageRoot, entry))

  const src = join(packageRoot, 'src')
  const defaults = [
    join(src, `${commandName}.tsx`),
    join(src, `${commandName}.ts`),
    join(src, `${commandName}.jsx`),
    join(src, `${commandName}.js`),
    join(src, commandName, 'index.tsx'),
    join(src, commandName, 'index.ts'),
    join(src, commandName, 'index.jsx'),
    join(src, commandName, 'index.js'),
  ]

  const candidate = [...explicit, ...defaults].find((entry) => existsSync(entry))
  if (!candidate) {
    throw new Error(`Could not resolve entry file for command ${commandName}`)
  }
  return candidate
}

async function bundleCommand(entryPath: string, packageRoot: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    absWorkingDir: packageRoot,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    target: 'node20',
    external: [
      '@raycast/api',
      '@raycast/utils',
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ],
    logLevel: 'silent',
  })

  const output = result.outputFiles?.[0]?.text
  if (!output) {
    throw new Error('esbuild did not produce output')
  }
  return output
}

function createJsxRuntimeShim(): Record<string, unknown> {
  const jsx = (type: unknown, props?: Record<string, unknown>, key?: unknown): JsxNode => ({
    __jsx: true,
    type,
    props: props ?? {},
    key,
  })

  return {
    Fragment: JSX_FRAGMENT,
    jsx,
    jsxs: jsx,
    jsxDEV: jsx,
  }
}

function createReactShim(): Record<string, unknown> {
  const jsxRuntime = createJsxRuntimeShim()
  const jsx = jsxRuntime.jsx as (type: unknown, props?: Record<string, unknown>, key?: unknown) => JsxNode

  const react = {
    Fragment: JSX_FRAGMENT,
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      const nextProps = { ...(props ?? {}) }
      if (children.length === 1) {
        nextProps.children = children[0]
      } else if (children.length > 1) {
        nextProps.children = children
      }
      return jsx(type, nextProps)
    },
    useState: <T,>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial
      const setState = (): void => {
        // This runtime is single-pass and intentionally stateless.
      }
      return [value, setState]
    },
    useEffect: (): void => {
      // No-op: side effects are not replayed across renders in this runtime.
    },
    useLayoutEffect: (): void => {
      // No-op.
    },
    useMemo: <T,>(factory: () => T): T => factory(),
    useCallback: <T extends (...args: unknown[]) => unknown>(callback: T): T => callback,
    useRef: <T,>(value: T): { current: T } => ({ current: value }),
    useContext: (): null => null,
    useReducer: <S, A>(
      reducer: (state: S, action: A) => S,
      initialArg: S,
    ): [S, (action: A) => void] => {
      let current = initialArg
      return [current, (action: A) => {
        current = reducer(current, action)
      }]
    },
    memo: <T,>(component: T): T => component,
    forwardRef: <T,>(renderer: T): T => renderer,
    isValidElement: (value: unknown): boolean => isJsxNode(value),
  }

  return {
    ...react,
    default: react,
    __esModule: true,
  }
}

function makeToken(name: string): RaycastComponentToken {
  return { __raycastComponent: true, name }
}

function isToken(value: unknown): value is RaycastComponentToken {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { __raycastComponent?: unknown }).__raycastComponent === true &&
      typeof (value as { name?: unknown }).name === 'string',
  )
}

function normalizeActionTitle(typeName: string, props: Record<string, unknown>): string {
  if (typeof props.title === 'string' && props.title.trim().length > 0) {
    return props.title.trim()
  }

  switch (typeName) {
    case 'Action.CopyToClipboard':
      return 'Copy to Clipboard'
    case 'Action.OpenInBrowser':
      return 'Open in Browser'
    case 'Action.Push':
      return 'Open'
    case 'Action.Pop':
      return 'Back'
    case 'Action.ShowInFinder':
      return 'Show in Finder'
    case 'Action.SubmitForm':
      return 'Submit'
    default:
      return 'Action'
  }
}

function parseShortcut(shortcut: unknown): ExtensionRuntimeAction['shortcut'] | undefined {
  if (!shortcut || typeof shortcut !== 'object') return undefined
  const s = shortcut as { modifiers?: unknown; key?: unknown }
  const modifiers = Array.isArray(s.modifiers)
    ? s.modifiers.filter((m): m is string => typeof m === 'string')
    : undefined
  const key = typeof s.key === 'string' ? s.key : undefined
  if (!modifiers && !key) return undefined
  return { modifiers, key }
}

function pushFeedback(session: RuntimeSession, feedback: RuntimeFeedback): void {
  session.feedback.push(feedback)
  if (session.feedback.length > 20) {
    session.feedback.splice(0, session.feedback.length - 20)
  }
}

function createLocalStorageShim(packageRoot: string): Record<string, unknown> {
  const storagePath = join(packageRoot, '.raymes-local-storage.json')

  const readAll = (): Record<string, string> => {
    if (!existsSync(storagePath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(storagePath, 'utf8')) as Record<string, string>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeAll = (value: Record<string, string>): void => {
    mkdirSync(dirname(storagePath), { recursive: true })
    writeFileSync(storagePath, JSON.stringify(value, null, 2), 'utf8')
  }

  return {
    getItem: async (key: string): Promise<string | undefined> => readAll()[String(key)],
    setItem: async (key: string, value: string): Promise<void> => {
      const all = readAll()
      all[String(key)] = String(value)
      writeAll(all)
    },
    removeItem: async (key: string): Promise<void> => {
      const all = readAll()
      delete all[String(key)]
      writeAll(all)
    },
    clear: async (): Promise<void> => writeAll({}),
    allItems: async (): Promise<Record<string, string>> => readAll(),
  }
}

function createRaycastApiShim(session: RuntimeSession): Record<string, unknown> {
  const List = Object.assign(makeToken('List'), {
    Item: makeToken('List.Item'),
    Section: makeToken('List.Section'),
    EmptyView: makeToken('List.EmptyView'),
  })

  const Form = Object.assign(makeToken('Form'), {
    TextField: makeToken('Form.TextField'),
    TextArea: makeToken('Form.TextArea'),
    Checkbox: makeToken('Form.Checkbox'),
    Dropdown: makeToken('Form.Dropdown'),
    DatePicker: makeToken('Form.DatePicker'),
    PasswordField: makeToken('Form.PasswordField'),
    Separator: makeToken('Form.Separator'),
    Description: makeToken('Form.Description'),
  })

  const Grid = Object.assign(makeToken('Grid'), {
    Item: makeToken('Grid.Item'),
    Section: makeToken('Grid.Section'),
    EmptyView: makeToken('Grid.EmptyView'),
  })

  const Detail = makeToken('Detail')

  const Action = Object.assign(makeToken('Action'), {
    CopyToClipboard: makeToken('Action.CopyToClipboard'),
    OpenInBrowser: makeToken('Action.OpenInBrowser'),
    Push: makeToken('Action.Push'),
    Pop: makeToken('Action.Pop'),
    ShowInFinder: makeToken('Action.ShowInFinder'),
    SubmitForm: makeToken('Action.SubmitForm'),
  })

  const ActionPanel = makeToken('ActionPanel')

  return {
    List,
    Form,
    Grid,
    Detail,
    Action,
    ActionPanel,
    Toast: {
      Style: {
        Success: 'success',
        Failure: 'failure',
        Animated: 'animated',
      },
    },
    environment: {
      raycastVersion: '1.80.0',
      extensionName: session.extensionId,
      commandName: session.commandName,
      isDevelopment: false,
      commandMode: 'view',
      assetsPath: join(session.packageRoot, 'assets'),
      supportPath: join(session.packageRoot, '.raymes-support'),
    },
    LocalStorage: createLocalStorageShim(session.packageRoot),
    Clipboard: {
      copy: async (value: unknown): Promise<void> => {
        clipboard.writeText(String(value ?? ''))
      },
      paste: async (value: unknown): Promise<void> => {
        clipboard.writeText(String(value ?? ''))
      },
      read: async (): Promise<{ text?: string }> => {
        const text = clipboard.readText()
        return text ? { text } : {}
      },
      readText: async (): Promise<string> => clipboard.readText(),
    },
    getPreferenceValues: (): Record<string, unknown> => session.preferences,
    useNavigation: () => ({
      push: (next: unknown): void => {
        session.stack.push(next)
      },
      pop: (): void => {
        if (session.stack.length > 1) {
          session.stack.pop()
        }
      },
    }),
    showToast: async (
      optionsOrStyle: unknown,
      title?: string,
      message?: string,
    ): Promise<{ hide: () => Promise<void> }> => {
      if (typeof optionsOrStyle === 'string') {
        pushFeedback(session, {
          kind: 'toast',
          style: optionsOrStyle,
          title: title ? String(title) : undefined,
          message: message ? String(message) : undefined,
        })
      } else {
        const opts = (optionsOrStyle && typeof optionsOrStyle === 'object'
          ? optionsOrStyle
          : {}) as {
          style?: unknown
          title?: unknown
          message?: unknown
        }
        pushFeedback(session, {
          kind: 'toast',
          style: typeof opts.style === 'string' ? opts.style : undefined,
          title: typeof opts.title === 'string' ? opts.title : undefined,
          message: typeof opts.message === 'string' ? opts.message : undefined,
        })
      }
      return {
        hide: async (): Promise<void> => {
          // No-op for compatibility.
        },
      }
    },
    showHUD: async (title: unknown): Promise<void> => {
      pushFeedback(session, { kind: 'hud', message: String(title || '') })
    },
    open: async (target: unknown): Promise<void> => {
      if (typeof target !== 'string') return
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('mailto:')) {
        await shell.openExternal(target)
      }
    },
    showInFinder: async (path: unknown): Promise<void> => {
      if (typeof path !== 'string') return
      shell.showItemInFolder(path)
    },
    confirmAlert: async (): Promise<boolean> => true,
    openExtensionPreferences: async (): Promise<void> => {
      // Preferences editing is handled by Raymes settings.
    },
    openCommandPreferences: async (): Promise<void> => {
      // Preferences editing is handled by Raymes settings.
    },
  }
}

function createRaycastUtilsShim(session: RuntimeSession): Record<string, unknown> {
  return {
    usePromise: () => ({
      data: undefined,
      isLoading: false,
      error: undefined,
      revalidate: async () => {},
      mutate: async () => {},
    }),
    useFetch: () => ({
      data: undefined,
      isLoading: false,
      error: undefined,
      revalidate: async () => {},
      mutate: async () => {},
    }),
    useCachedPromise: () => ({
      data: undefined,
      isLoading: false,
      error: undefined,
      revalidate: async () => {},
      mutate: async () => {},
      pagination: undefined,
    }),
    showFailureToast: (error: unknown): void => {
      pushFeedback(session, {
        kind: 'toast',
        style: 'failure',
        title: error instanceof Error ? error.message : String(error),
      })
    },
  }
}

function isJsxNode(value: unknown): value is JsxNode {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { __jsx?: unknown }).__jsx === true &&
      'type' in (value as Record<string, unknown>) &&
      'props' in (value as Record<string, unknown>),
  )
}

function sanitizeValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry))
      .filter((entry) => entry !== undefined)
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'function') continue
      if (key === 'children') continue
      const sanitized = sanitizeValue(entry)
      if (sanitized !== undefined) {
        out[key] = sanitized
      }
    }
    return out
  }

  return undefined
}

function registerAction(
  typeName: string,
  props: Record<string, unknown>,
  session: RuntimeSession,
): void {
  const id = makeId('ext-action')
  const title = normalizeActionTitle(typeName, props)

  const kind: ExtensionRuntimeAction['kind'] =
    typeName === 'Action.CopyToClipboard'
      ? 'copy'
      : typeName === 'Action.OpenInBrowser'
        ? 'open'
        : typeName === 'Action.Push'
          ? 'push'
          : typeName === 'Action.Pop'
            ? 'pop'
            : typeName === 'Action.SubmitForm'
              ? 'submit-form'
              : typeName === 'Action.ShowInFinder'
                ? 'show-in-finder'
                : 'action'

  const style = typeof props.style === 'string' && props.style.toLowerCase() === 'destructive'
    ? 'destructive'
    : 'default'

  const action: ExtensionRuntimeAction = {
    id,
    title,
    style,
    shortcut: parseShortcut(props.shortcut),
    kind,
  }

  session.currentActions.push(action)

  const handler: RuntimeActionHandler = async (formValues) => {
    if (kind === 'copy') {
      const content = props.content ?? props.title ?? ''
      clipboard.writeText(String(content ?? ''))
    }

    if (kind === 'open') {
      const url = typeof props.url === 'string' ? props.url : ''
      if (url) {
        await shell.openExternal(url)
      }
    }

    if (kind === 'show-in-finder') {
      const path = typeof props.path === 'string' ? props.path : ''
      if (path) {
        shell.showItemInFolder(path)
      }
    }

    if (kind === 'push' && props.target !== undefined) {
      session.stack.push(props.target)
    }

    if (kind === 'pop') {
      if (session.stack.length > 1) {
        session.stack.pop()
      }
    }

    if (kind === 'submit-form' && typeof props.onSubmit === 'function') {
      await Promise.resolve((props.onSubmit as (values?: Record<string, string>) => unknown)(formValues ?? {}))
      return
    }

    if (typeof props.onAction === 'function') {
      await Promise.resolve((props.onAction as () => unknown)())
    }
  }

  session.actionHandlers.set(id, handler)
}

function walkRuntimeNodes(
  input: unknown,
  session: RuntimeSession,
  depth: number,
  budget: { remaining: number },
): ExtensionRuntimeNode[] {
  if (budget.remaining <= 0 || depth > RUNTIME_RECURSION_LIMIT) {
    return []
  }

  if (input == null || typeof input === 'boolean') {
    return []
  }

  if (Array.isArray(input)) {
    return input.flatMap((entry) => walkRuntimeNodes(entry, session, depth, budget))
  }

  if (!isJsxNode(input)) {
    return []
  }

  const type = input.type
  const props = input.props ?? {}

  if (type === JSX_FRAGMENT) {
    return walkRuntimeNodes(props.children, session, depth + 1, budget)
  }

  if (typeof type === 'function') {
    let rendered: unknown
    try {
      rendered = type(props)
    } catch {
      return []
    }
    return walkRuntimeNodes(rendered, session, depth + 1, budget)
  }

  const typeName = isToken(type)
    ? type.name
    : typeof type === 'string'
      ? type
      : ''
  if (!typeName) return []

  if (typeName.startsWith('Action')) {
    if (typeName === 'ActionPanel') {
      return walkRuntimeNodes(props.children, session, depth + 1, budget)
    }
    registerAction(typeName, props, session)
    return []
  }

  budget.remaining -= 1
  const node: ExtensionRuntimeNode = {
    type: typeName,
    props: sanitizeValue(props) as Record<string, unknown> | undefined,
    children: walkRuntimeNodes(props.children, session, depth + 1, budget),
  }

  return [node]
}

function formatFeedback(feedback: RuntimeFeedback | undefined): string {
  if (!feedback) return 'Extension command completed.'
  if (feedback.kind === 'hud') {
    return feedback.message || 'Extension command completed.'
  }
  const title = feedback.title?.trim() || ''
  const message = feedback.message?.trim() || ''
  if (title && message) return `${title}: ${message}`
  return title || message || 'Extension command completed.'
}

function renderCurrentView(session: RuntimeSession): ExtensionRunCommandResult | ExtensionInvokeActionResult {
  const top = session.stack.at(-1)
  if (!top) {
    return {
      ok: false,
      message: 'No view is available for this extension session.',
    }
  }

  session.actionHandlers.clear()
  session.currentActions = []

  const budget = { remaining: RUNTIME_COMPONENT_LIMIT }
  const nodes = walkRuntimeNodes(top, session, 0, budget)

  const root: ExtensionRuntimeNode = nodes[0] ?? {
    type: 'Detail',
    props: { markdown: 'This extension returned an empty view.' },
    children: [],
  }

  return {
    ok: true,
    mode: 'view',
    message: formatFeedback(session.feedback.at(-1)),
    sessionId: session.id,
    extensionId: session.extensionId,
    commandName: session.commandName,
    title: session.title,
    root,
    actions: [...session.currentActions],
  }
}

function pruneSessions(): void {
  if (sessions.size <= SESSIONS_SOFT_LIMIT) return
  const ids = [...sessions.keys()]
  const overflow = sessions.size - SESSIONS_SOFT_LIMIT
  for (let i = 0; i < overflow; i += 1) {
    const id = ids[i]
    if (id) sessions.delete(id)
  }
}

function runBundle(
  code: string,
  packageRoot: string,
  session: RuntimeSession,
): unknown {
  const fileRequire = createRequire(join(packageRoot, 'package.json'))
  const jsxRuntimeShim = createJsxRuntimeShim()
  const reactShim = createReactShim()
  const raycastApiShim = createRaycastApiShim(session)
  const raycastUtilsShim = createRaycastUtilsShim(session)

  const customRequire = (specifier: string): unknown => {
    if (specifier === '@raycast/api') return raycastApiShim
    if (specifier === '@raycast/utils') return raycastUtilsShim
    if (specifier === 'react') return reactShim
    if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
      return jsxRuntimeShim
    }

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      return fileRequire(specifier)
    }

    if (specifier.startsWith('node:') || BUILTIN_SET.has(specifier)) {
      return fileRequire(specifier)
    }

    return fileRequire(specifier)
  }

  const context = vm.createContext({
    console,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    URL,
  })

  const wrapped = `(function(exports, require, module, __filename, __dirname) {\n${code}\n})`
  const script = new vm.Script(wrapped, {
    filename: join(packageRoot, '.raymes-runtime-bundle.cjs'),
  })

  const fn = script.runInContext(context)
  const mod: { exports: unknown } = { exports: {} }
  fn(mod.exports, customRequire, mod, join(packageRoot, '.raymes-runtime-bundle.cjs'), packageRoot)
  return mod.exports
}

function getCommandExport(moduleExports: unknown): ((props: { arguments: Record<string, string> }) => unknown) | null {
  if (typeof moduleExports === 'function') {
    return moduleExports as (props: { arguments: Record<string, string> }) => unknown
  }

  if (moduleExports && typeof moduleExports === 'object') {
    const exp = moduleExports as { default?: unknown }
    if (typeof exp.default === 'function') {
      return exp.default as (props: { arguments: Record<string, string> }) => unknown
    }
  }

  return null
}

async function runCommandFromPackagePath(
  packageJsonPath: string,
  extensionId: string,
  commandName: string,
  argumentValues: Record<string, string>,
): Promise<ExtensionRunCommandResult> {
  const packageRoot = dirname(packageJsonPath)
  const pkg = parsePackageJson(packageJsonPath)
  const command = findCommandInManifest(pkg, commandName)

  const mode = String(command.mode || '').toLowerCase()
  const title = String(command.title || commandName)
  const entryPath = resolveCommandEntry(packageRoot, commandName, command)
  const bundled = await bundleCommand(entryPath, packageRoot)

  const session: RuntimeSession = {
    id: makeId('ext-session'),
    extensionId,
    commandName,
    title,
    packageRoot,
    actionHandlers: new Map(),
    currentActions: [],
    feedback: [],
    stack: [],
    preferences: getExtensionPreferences(extensionId, commandName),
  }

  const moduleExports = runBundle(bundled, packageRoot, session)
  const commandFn = getCommandExport(moduleExports)
  if (!commandFn) {
    return { ok: false, message: 'Extension command entry is not executable.' }
  }

  const result = await Promise.resolve(commandFn({ arguments: argumentValues }))

  if (mode === 'no-view' || !isJsxNode(result)) {
    const message = formatFeedback(session.feedback.at(-1))
    return {
      ok: true,
      mode: 'no-view',
      message,
    }
  }

  session.stack = [result]
  sessions.set(session.id, session)
  pruneSessions()
  return renderCurrentView(session)
}

export async function runExtensionCommand(
  request: ExtensionRunCommandRequest,
): Promise<ExtensionRunCommandResult> {
  const extensionId = String(request.extensionId || '').trim()
  const commandName = String(request.commandName || '').trim()
  if (!extensionId || !commandName) {
    return { ok: false, message: 'Extension id and command name are required.' }
  }

  const packagePath = resolveInstalledPackageJsonPath(extensionId)
  if (!packagePath) {
    return { ok: false, message: `Extension is not installed: ${extensionId}` }
  }

  try {
    return await runCommandFromPackagePath(
      packagePath,
      extensionId,
      commandName,
      request.argumentValues ?? {},
    )
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runExtensionCommandFromPackageJson(
  packageJsonPath: string,
  commandName: string,
  argumentValues?: Record<string, string>,
): Promise<ExtensionRunCommandResult> {
  const normalizedPath = String(packageJsonPath || '').trim()
  const normalizedCommandName = String(commandName || '').trim()
  if (!normalizedPath || !normalizedCommandName) {
    return { ok: false, message: 'packageJsonPath and commandName are required.' }
  }

  const extensionId = `raycast.${dirname(normalizedPath).split('/').pop() || 'external'}`
  try {
    return await runCommandFromPackagePath(
      normalizedPath,
      extensionId,
      normalizedCommandName,
      argumentValues ?? {},
    )
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function invokeExtensionAction(
  request: ExtensionInvokeActionRequest,
): Promise<ExtensionInvokeActionResult> {
  const sessionId = String(request.sessionId || '').trim()
  const actionId = String(request.actionId || '').trim()
  if (!sessionId || !actionId) {
    return { ok: false, message: 'sessionId and actionId are required.' }
  }

  const session = sessions.get(sessionId)
  if (!session) {
    return { ok: false, message: 'Extension session not found.' }
  }

  if (actionId === '__nav_pop__') {
    if (session.stack.length > 1) {
      session.stack.pop()
    }
    return renderCurrentView(session)
  }

  const handler = session.actionHandlers.get(actionId)
  if (!handler) {
    return { ok: false, message: 'Action is no longer available in this session.' }
  }

  try {
    await Promise.resolve(handler(request.formValues ?? {}))
    if (session.stack.length > 0) {
      return renderCurrentView(session)
    }

    return {
      ok: true,
      mode: 'no-view',
      message: formatFeedback(session.feedback.at(-1)),
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export function disposeExtensionSession(sessionId: string): boolean {
  return sessions.delete(sessionId)
}

export function clearAllExtensionSessions(): void {
  sessions.clear()
}
