export type Intent =
  | { type: 'answer'; input: string }
  | { type: 'agent'; input: string }
  | { type: 'ai'; input: string }
  | { type: 'file'; query: string }
  | { type: 'application'; target: string }
  | { type: 'command'; command: string; confidence: number }
  | { type: 'extension'; name: string; args: string }
  | {
      type: 'system'
      action:
        | 'open-app'
        | 'calculator'
        | 'quit'
        | 'wifi-on'
        | 'wifi-off'
        | 'dark-mode-on'
        | 'dark-mode-off'
        | 'mute-on'
        | 'mute-off'
      target?: string
    }
