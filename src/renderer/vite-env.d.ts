/// <reference types="vite/client" />

import type { TezbarApi } from '../shared/desktop-api'

declare global {
  interface Window {
    tezbar: TezbarApi
    __TEZBAR_WINDOW_LABEL__?: string
  }
}

export { }
