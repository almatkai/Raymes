import type { SearchCategory, SearchResult } from '../../shared/search'
import type { SearchIndexDatabase } from './indexDb'

type BenchmarkCase = {
  query: string
  expected: Array<{ category?: SearchCategory; idPrefix?: string }>
}

const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    query: 'open safari',
    expected: [{ category: 'applications' }],
  },
  {
    query: 'wifi off',
    expected: [{ category: 'commands', idPrefix: 'command:wifi-off' }],
  },
  {
    query: 'quick note',
    expected: [{ category: 'quick-notes' }],
  },
  {
    query: 'clipboard history',
    expected: [{ category: 'clipboard' }],
  },
  {
    query: 'snippet date',
    expected: [{ category: 'snippets' }],
  },
  {
    query: 'port manager',
    expected: [{ category: 'extensions' }],
  },
]

function matchesExpectation(result: SearchResult, expected: BenchmarkCase['expected'][number]): boolean {
  if (expected.category && result.category !== expected.category) return false
  if (expected.idPrefix && !result.id.startsWith(expected.idPrefix)) return false
  return true
}

function precisionAtK(results: SearchResult[], benchmark: BenchmarkCase, k: number): number {
  if (k <= 0) return 0
  const top = results.slice(0, k)
  if (top.length === 0) return 0

  let relevant = 0
  for (const row of top) {
    if (benchmark.expected.some((target) => matchesExpectation(row, target))) {
      relevant += 1
    }
  }

  return relevant / k
}

export type BenchmarkReport = {
  generatedAt: number
  benchmarkSize: number
  precisionAt5: number
  precisionAt10: number
  clickThroughRank: number
}

export async function runOfflineBenchmarks(
  searchFn: (query: string) => Promise<SearchResult[]>,
  db: SearchIndexDatabase,
): Promise<BenchmarkReport> {
  const perCase5: number[] = []
  const perCase10: number[] = []

  for (const benchmark of BENCHMARK_CASES) {
    const results = await searchFn(benchmark.query)
    perCase5.push(precisionAtK(results, benchmark, 5))
    perCase10.push(precisionAtK(results, benchmark, 10))
  }

  const precisionAt5 = perCase5.reduce((acc, value) => acc + value, 0) / Math.max(1, perCase5.length)
  const precisionAt10 = perCase10.reduce((acc, value) => acc + value, 0) / Math.max(1, perCase10.length)

  db.writeBenchmarkSnapshot(precisionAt5, precisionAt10, BENCHMARK_CASES.length)

  return {
    generatedAt: Date.now(),
    benchmarkSize: BENCHMARK_CASES.length,
    precisionAt5,
    precisionAt10,
    clickThroughRank: db.readRecentClickAverage(),
  }
}

export function readBenchmarkHistory(db: SearchIndexDatabase): BenchmarkReport[] {
  return db.readBenchmarkHistory().map((snapshot) => ({
    generatedAt: snapshot.createdAt,
    benchmarkSize: 0,
    precisionAt5: snapshot.precisionAt5,
    precisionAt10: snapshot.precisionAt10,
    clickThroughRank: snapshot.avgClickRank,
  }))
}
