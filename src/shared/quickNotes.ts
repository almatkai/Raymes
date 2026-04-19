/** Quick notes persisted in `userData/search/notes.json`. */

export type QuickNoteEntry = {
  /** Stable id — unix ms when the note was created. */
  createdAt: number
  /** Last edit time — used for search ranking and list sorting. */
  updatedAt: number
  /** Rich-text body (HTML); first line is treated as title in the list. */
  text: string
}
