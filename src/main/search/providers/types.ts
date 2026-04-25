import type { SearchAction, SearchCategory } from '../../../shared/search'

export type IndexedDocument = {
  id: string
  category: SearchCategory
  title: string
  subtitle: string
  tokens: string
  action: SearchAction
  updatedAt: number
  sourcePath?: string
  sourceMtime?: number
  popularity?: number
}

export type SearchProvider = {
  providerId: string
  buildDocuments: () => Promise<IndexedDocument[]>
}
