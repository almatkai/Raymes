import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const OPENRAY_CONFIG_DIR = join(homedir(), '.openray')
export const OPENRAY_CONFIG_PATH = join(OPENRAY_CONFIG_DIR, 'config.json')

export function readRawConfig(): Record<string, unknown> {
  if (!existsSync(OPENRAY_CONFIG_PATH)) {
    return {}
  }
  try {
    const raw = readFileSync(OPENRAY_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function writeConfigPatch(patch: Record<string, unknown>): void {
  mkdirSync(dirname(OPENRAY_CONFIG_PATH), { recursive: true })
  const prev = readRawConfig()
  const next = { ...prev, ...patch }
  writeFileSync(OPENRAY_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
}

/** How long (ms) after hiding the palette we keep UI state (e.g. Providers) when reopening. Default 60s. */
export function getUiStateRetentionMs(): number {
  const raw = readRawConfig()
  const v = raw.uiStateRetentionMs
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return v
  }
  return 60_000
}

/** When true, safety-gated destructive actions are previewed instead of
 *  executed. The renderer still sees a real confirmation dialog, and the
 *  action is recorded in the safety log as a dry run so the UI can show
 *  what *would* have happened. Off by default; flip it via the settings
 *  panel while diagnosing something risky. */
export function getSafetyDryRun(): boolean {
  const raw = readRawConfig()
  return raw.safetyDryRun === true
}

export function setSafetyDryRun(value: boolean): void {
  writeConfigPatch({ safetyDryRun: value })
}
