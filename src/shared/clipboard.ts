/** Kinds of things the clipboard can hold that we know how to preview.
 *  Anything else (e.g. RTF, arbitrary binary) is ignored so the history
 *  stays useful rather than getting flooded with opaque blobs. */
export type ClipboardKind = 'text' | 'image' | 'file'

type ClipboardBase = {
  id: string
  createdAt: number
  pinned: boolean
  isSecret: boolean
}

export type ClipboardTextEntry = ClipboardBase & {
  kind: 'text'
  text: string
  /** First non-empty line, truncated. Used for the list preview. */
  preview: string
  charCount: number
  lineCount: number
}

export type ClipboardImageEntry = ClipboardBase & {
  kind: 'image'
  /** Absolute path to the PNG we persisted on disk. */
  imagePath: string
  width: number
  height: number
  byteSize: number
}

export type ClipboardFileEntry = ClipboardBase & {
  kind: 'file'
  paths: string[]
  /** Convenience label for the list view — the basename of the first path. */
  preview: string
}

export type ClipboardEntry = ClipboardTextEntry | ClipboardImageEntry | ClipboardFileEntry

/** Payload we return for the renderer when it asks for an image. We can't
 *  hand over a `file://` URL directly because the renderer runs in a
 *  sandboxed origin; the main process reads the bytes and returns a base64
 *  dataURL instead. */
export type ClipboardImagePayload = {
  dataUrl: string
  width: number
  height: number
  byteSize: number
}
