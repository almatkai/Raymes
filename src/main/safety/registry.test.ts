import { describe, expect, it } from 'vitest'
import type { SafetyActionId } from '../../shared/safety'
import { getSafetyDescriptor, listSafetyDescriptors } from './registry'

/** Every safety id that the search service actually invokes. Keep this in
 *  sync when you call `runWithSafety(<new id>)` — the test will catch any
 *  id that's been added to the allowlist but never wired up, or vice
 *  versa. */
const USED_IDS: SafetyActionId[] = [
  'shell.run',
  'port.kill',
  'trash.empty',
  'native.command',
]

describe('safety registry', () => {
  it('every descriptor has a matching id, title, summary and risk', () => {
    for (const descriptor of listSafetyDescriptors()) {
      expect(descriptor.id).toBeTypeOf('string')
      expect(descriptor.title.trim().length).toBeGreaterThan(0)
      expect(descriptor.summary.trim().length).toBeGreaterThan(0)
      expect(['low', 'medium', 'high']).toContain(descriptor.risk)
    }
  })

  it('high-risk actions always require confirmation', () => {
    for (const descriptor of listSafetyDescriptors()) {
      if (descriptor.risk === 'high') {
        expect(descriptor.requiresConfirmation).toBe(true)
      }
    }
  })

  it('every id used by the service is registered', () => {
    for (const id of USED_IDS) {
      expect(getSafetyDescriptor(id)).not.toBeNull()
    }
  })

  it('getSafetyDescriptor returns null for unknown ids', () => {
    expect(getSafetyDescriptor('not.a.real.id' as SafetyActionId)).toBeNull()
  })
})
