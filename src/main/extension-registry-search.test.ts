import { describe, expect, it } from 'vitest'

import { scoreCatalogEntrySearch, type CatalogEntry } from './extension-registry'

function catalogEntry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    name: 'example',
    title: 'Example',
    description: '',
    author: '',
    contributors: [],
    icon: '',
    iconUrl: '',
    screenshotUrls: [],
    categories: [],
    platforms: [],
    commands: [],
    ...overrides,
  }
}

describe('extension catalog search scoring', () => {
  it('does not match short queries in the middle of unrelated words', () => {
    const brew = catalogEntry({
      name: 'brew',
      title: 'Brew',
      description: 'Search and install Homebrew packages',
    })
    const arc = catalogEntry({
      name: 'arc',
      title: 'Arc',
      description: 'Control Arc browser tabs',
    })

    expect(scoreCatalogEntrySearch(brew, 'arc')).toBe(0)
    expect(scoreCatalogEntrySearch(arc, 'arc')).toBeGreaterThan(0)
  })

  it('still allows word-prefix matches for short queries', () => {
    const archive = catalogEntry({
      name: 'archive-tabs',
      title: 'Archive Tabs',
      description: 'Archive browser tabs',
    })

    expect(scoreCatalogEntrySearch(archive, 'arc')).toBeGreaterThan(0)
  })
})
