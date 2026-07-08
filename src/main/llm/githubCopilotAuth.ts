import { readRawConfig, writeConfigPatch } from './configStore'

const COPILOT_API = 'https://api.githubcopilot.com'
const DEFAULT_GITHUB_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const GITHUB_COPILOT_OAUTH_SCOPE = 'repo workflow'

export type DeviceCodeStartResult = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

let deviceSession: { device_code: string; interval: number; client_id: string } | null = null

export function clearDeviceSession(): void {
  deviceSession = null
}

function resolveGithubOAuthClientId(clientId?: string): string {
  const trimmed = clientId?.trim()
  return trimmed || DEFAULT_GITHUB_COPILOT_CLIENT_ID
}

function getObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function startGithubDeviceFlow(clientId?: string): Promise<DeviceCodeStartResult> {
  const resolvedClientId = resolveGithubOAuthClientId(clientId)
  const body = new URLSearchParams({
    client_id: resolvedClientId,
    scope: GITHUB_COPILOT_OAUTH_SCOPE,
  })
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`GitHub device code failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const json = (await res.json()) as DeviceCodeStartResult
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('GitHub device code: malformed response')
  }
  deviceSession = {
    device_code: json.device_code,
    interval: Math.max(5, json.interval ?? 5),
    client_id: resolvedClientId,
  }
  return json
}

export type PollResult =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | {
    status: 'success'
    access_token: string
    refresh_token?: string
    expires_in?: number
    client_id: string
  }
  | { status: 'error'; error: string }

export async function pollGithubDeviceFlow(): Promise<PollResult> {
  if (!deviceSession) {
    return { status: 'error', error: 'No device session. Start sign-in again.' }
  }
  const body = new URLSearchParams({
    client_id: deviceSession.client_id,
    device_code: deviceSession.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  const err = typeof json.error === 'string' ? json.error : ''
  if (err === 'authorization_pending') {
    return { status: 'authorization_pending' }
  }
  if (err === 'slow_down') {
    return { status: 'slow_down' }
  }
  if (err && err !== '') {
    deviceSession = null
    return { status: 'error', error: typeof json.error_description === 'string' ? json.error_description : err }
  }
  const access_token = typeof json.access_token === 'string' ? json.access_token : ''
  if (!access_token) {
    return { status: 'error', error: 'No access_token in response' }
  }
  const refresh_token = typeof json.refresh_token === 'string' ? json.refresh_token : undefined
  const expires_in = typeof json.expires_in === 'number' ? json.expires_in : undefined
  const client_id = deviceSession.client_id
  deviceSession = null
  return { status: 'success', access_token, refresh_token, expires_in, client_id }
}

export async function refreshGithubAccessToken(
  refreshToken: string,
  clientId: string,
  signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    client_id: resolveGithubOAuthClientId(clientId),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal,
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Token refresh failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const access_token = typeof json.access_token === 'string' ? json.access_token : ''
  if (!access_token) {
    throw new Error('Token refresh: missing access_token')
  }
  return {
    access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : refreshToken,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
  }
}

export function persistCopilotTokens(
  accessToken: string,
  refreshToken?: string,
  expiresInSec?: number,
  clientId?: string,
): void {
  const raw = readRawConfig()
  const providerConfigs = getObjectRecord(raw.providerConfigs)
  const copilotConfig = getObjectRecord(providerConfigs.copilot)
  const nextCopilotConfig: Record<string, unknown> = {
    ...copilotConfig,
    copilotGithubToken: accessToken,
  }
  const trimmedClientId = clientId?.trim()
  if (trimmedClientId) {
    nextCopilotConfig.githubOAuthClientId = trimmedClientId
  }

  const patch: Record<string, unknown> = {
    copilotGithubToken: accessToken,
    providerConfigs: {
      ...providerConfigs,
      copilot: nextCopilotConfig,
    },
  }
  if (trimmedClientId) patch.githubOAuthClientId = trimmedClientId
  if (refreshToken) {
    patch.copilotRefreshToken = refreshToken
    nextCopilotConfig.copilotRefreshToken = refreshToken
  }
  if (expiresInSec !== undefined) {
    const expiresAt = Date.now() + expiresInSec * 1000
    patch.copilotExpiresAt = expiresAt
    nextCopilotConfig.copilotExpiresAt = expiresAt
  }
  writeConfigPatch(patch)
}

export async function copilotApiPing(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${COPILOT_API}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'Tezbar/0.1.0',
        'Copilot-Integration-Id': 'vscode-chat',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}
