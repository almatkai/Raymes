/** Small shared flag store for cross-module window behavior toggles.
 *
 *  Kept in its own module so both `index.ts` (which owns the BrowserWindow
 *  and listens for `blur`) and `ipc.ts` (which receives renderer-driven
 *  toggles) can read/write without a circular import. */

let suppressBlurHide = false

export function setSuppressBlurHide(value: boolean): void {
  suppressBlurHide = value
}

export function shouldSuppressBlurHide(): boolean {
  return suppressBlurHide
}
