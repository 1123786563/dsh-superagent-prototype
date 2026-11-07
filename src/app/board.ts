/** Browser-safe board columns and query contract; no host runtime dependencies. */
export const BOARD_COLUMNS = ['queued', 'working', 'person', 'idle', 'ended'] as const
export type BoardColumnId = typeof BOARD_COLUMNS[number]
export type BoardOrder = 'updated' | 'created' | 'oldest'
export interface BoardQuery {
  q?: string
  source?: string
  order?: BoardOrder
  column?: BoardColumnId
  offset?: number
  limit?: number
}
