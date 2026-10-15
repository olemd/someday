// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory fixed-window rate limits for the self-hosted server (§10a).
 * Assumes a single instance (documented); a restart resets the counters.
 */
import type { RateLimiter } from '../../core/ports';

export function memoryRateLimiter(nowMs: () => number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = 0;
  return async (key, limit, windowSec) => {
    const now = nowMs() / 1000;
    const start = Math.floor(now / windowSec) * windowSec;
    const k = `${key}:${windowSec}`;
    const w = windows.get(k);
    if (!w || w.start !== start) windows.set(k, { start, count: 1 });
    else w.count++;
    // Drop finished windows now and then so the map cannot grow without bound.
    if (now - lastSweep > 600) {
      lastSweep = now;
      for (const [key2, v] of windows) if (v.start + 86_400 < now) windows.delete(key2);
    }
    return windows.get(k)!.count <= limit;
  };
}
