/** Permission manager shared types. One structured surface covering every
 *  native capability the app may request — Accessibility, Automation (Apple
 *  Events), Input Monitoring, Microphone, Calendar. The main process owns
 *  detection + request logic; the renderer consumes a read-only snapshot. */

export type PermissionId =
  | 'accessibility'
  | 'automation'
  | 'input-monitoring'
  | 'microphone'
  | 'calendar'
  | 'screen-recording'

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unsupported'

export type PermissionDescriptor = {
  id: PermissionId
  title: string
  summary: string
  /** Why the app may need this capability, shown in the settings UI. */
  rationale: string
  /** macOS System Settings deep link, if available. */
  settingsUrl?: string
  /** One-liner recovery hint the UI can surface when state !== granted. */
  remediation: string
}

export type PermissionStatus = {
  descriptor: PermissionDescriptor
  state: PermissionState
  /** Timestamp of the last fresh probe. */
  checkedAt: number
}

export type PermissionsSnapshot = {
  platform: NodeJS.Platform
  statuses: PermissionStatus[]
}
