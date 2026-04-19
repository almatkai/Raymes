/** Row returned for the dedicated Snippets surface (command bar → Snippets). */
export type SnippetListRow = {
  id: string
  title: string
  subtitle: string
  trigger: string
  bodyTemplate: string
  /** Expanded body at list time (for preview); copy uses fresh interpolation. */
  resolvedPreview: string
  /** Shipped defaults cannot be edited or removed from the UI. */
  readonly: boolean
}

/** Payload for creating or updating a user snippet. */
export type SnippetWritePayload = {
  label: string
  trigger: string
  body: string
}
