import { describe, expect, it } from 'vitest'
import type { Intent } from '../shared/intent'
import { classifyIntent } from './router'

async function expectIntent(input: string, expected: Intent): Promise<void> {
  await expect(classifyIntent(input)).resolves.toEqual(expected)
}

describe('classifyIntent', () => {
  it('routes slash commands to extension', async () => {
    await expectIntent('/calculator', { type: 'extension', name: 'calculator', args: '' })
  })

  it('parses extension name and args', async () => {
    await expectIntent('/weather nyc tomorrow', {
      type: 'extension',
      name: 'weather',
      args: 'nyc tomorrow',
    })
  })

  it('routes open … to system open-app', async () => {
    await expectIntent('open Safari', { type: 'application', target: 'Safari' })
  })

  it('is case-insensitive for system open', async () => {
    await expectIntent('OPEN Notes', { type: 'application', target: 'Notes' })
  })

  it('routes quit to system', async () => {
    await expectIntent('quit', { type: 'system', action: 'quit' })
  })

  it('routes calculator keyword to system', async () => {
    await expectIntent('calculator', { type: 'system', action: 'calculator' })
  })

  it('routes clear questions to answer', async () => {
    await expectIntent('what is the capital of France?', {
      type: 'ai',
      input: 'what is the capital of France?',
    })
  })

  it('routes imperative commands to agent', async () => {
    await expectIntent('send an email to john about the meeting', {
      type: 'agent',
      input: 'send an email to john about the meeting',
    })
  })

  it('does not classify long question-shaped text as answer', async () => {
    const long = `${'a'.repeat(118)}??`
    expect(long.length).toBeGreaterThanOrEqual(120)
    await expectIntent(long, { type: 'agent', input: long })
  })

  it('classifies question-prefix lines under 120 chars as answer', async () => {
    await expectIntent('how do I merge two lists in Python', {
      type: 'ai',
      input: 'how do I merge two lists in Python',
    })
  })

  it('classifies file-oriented prompts as file intent', async () => {
    await expectIntent('find file in downloads', {
      type: 'file',
      query: 'find file in downloads',
    })
  })

  it('maps natural language wifi toggle to system action', async () => {
    await expectIntent('turn off wifi please', {
      type: 'system',
      action: 'wifi-off',
    })
  })

  it('prefers extension over system when input starts with slash', async () => {
    await expectIntent('/open foo', { type: 'extension', name: 'open', args: 'foo' })
  })

  it('treats bare slash as extension with empty name', async () => {
    await expectIntent('/', { type: 'extension', name: '', args: '' })
  })
})
