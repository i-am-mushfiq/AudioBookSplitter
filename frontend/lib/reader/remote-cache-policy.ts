export const REMOTE_CACHE_LIMIT_BYTES = Math.floor(1.5 * 1024 ** 3);
export const REMOTE_CACHE_PREVIOUS_SESSIONS = 2;
export const REMOTE_CACHE_NEXT_SESSIONS = 3;

export interface CachePolicyEntry {
  key: string;
  size: number;
  sequence: number;
}

export interface CacheEvictionPlan {
  cacheable: boolean;
  evict: string[];
  total_after: number;
}

export interface SessionCacheWindow {
  retain_indexes: number[];
  prefetch_indexes: number[];
}

/**
 * Keep a bounded moving audio window. Retention is ordered by the audiobook,
 * while background fetching prioritizes forward playback and then rewind.
 */
export function planSessionCacheWindow(
  sessionCount: number,
  currentIndex: number,
  previous = REMOTE_CACHE_PREVIOUS_SESSIONS,
  next = REMOTE_CACHE_NEXT_SESSIONS,
): SessionCacheWindow {
  if (sessionCount <= 0 || currentIndex < 0 || currentIndex >= sessionCount) return { retain_indexes: [], prefetch_indexes: [] };
  const start = Math.max(0, currentIndex - previous);
  const end = Math.min(sessionCount - 1, currentIndex + next);
  const retain_indexes = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  const forward = Array.from({ length: end - currentIndex }, (_, offset) => currentIndex + offset + 1);
  const backward = Array.from({ length: currentIndex - start }, (_, offset) => currentIndex - offset - 1);
  return { retain_indexes, prefetch_indexes: [...forward, ...backward] };
}

/**
 * Plan a FIFO/round-robin eviction. Cache hits do not move to the back of the
 * queue: every successfully cached object gets one turn before being released.
 */
export function planRoundRobinEviction(
  existing: CachePolicyEntry[],
  incoming: CachePolicyEntry,
  limit = REMOTE_CACHE_LIMIT_BYTES,
): CacheEvictionPlan {
  if (incoming.size > limit) return { cacheable: false, evict: [], total_after: existing.reduce((sum, item) => sum + item.size, 0) };

  const withoutReplacement = existing.filter((item) => item.key !== incoming.key);
  let total = withoutReplacement.reduce((sum, item) => sum + item.size, 0) + incoming.size;
  const evict: string[] = [];
  for (const item of [...withoutReplacement].sort((a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key))) {
    if (total <= limit) break;
    evict.push(item.key);
    total -= item.size;
  }
  return { cacheable: true, evict, total_after: total };
}
