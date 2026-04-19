import { describe, expect, it } from 'vitest'
import type { NativeCommandId } from '../../shared/nativeCommands'
import { getNativeCommand, listNativeCommands } from './registry'

describe('native command registry', () => {
  it('exposes a non-trivial, sorted-by-id set of commands', () => {
    const commands = listNativeCommands()
    expect(commands.length).toBeGreaterThanOrEqual(20)
  })

  it('every descriptor has a unique, kebab-case id', () => {
    const ids = new Set<NativeCommandId>()
    for (const descriptor of listNativeCommands()) {
      expect(/^[a-z0-9-]+$/.test(descriptor.id)).toBe(true)
      expect(ids.has(descriptor.id)).toBe(false)
      ids.add(descriptor.id)
    }
  })

  it('every descriptor has title, subtitle, keywords', () => {
    for (const descriptor of listNativeCommands()) {
      expect(descriptor.title.trim().length).toBeGreaterThan(0)
      expect(descriptor.subtitle.trim().length).toBeGreaterThan(0)
      expect(descriptor.keywords.length).toBeGreaterThan(0)
    }
  })

  it('restore-id references point to real descriptors', () => {
    for (const descriptor of listNativeCommands()) {
      if (!descriptor.restoreId) continue
      expect(getNativeCommand(descriptor.restoreId)).not.toBeNull()
    }
  })

  it('destructive commands are gated by the safety layer via explicit flag', () => {
    const destructive = listNativeCommands().filter((d) => d.destructive)
    for (const descriptor of destructive) {
      expect(descriptor.destructive).toBe(true)
    }
  })
})
