export const REMOTE_CACHE_LIMIT_BYTES = Math.floor(1.5 * 1024 ** 3);

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
