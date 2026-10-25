/** Shared invalidation only. Payloads and permissions remain owned by each client. */
interface Fence {
  generation: number;
  activeWrites: number;
  listeners: Set<(generation: number, pattern?: string) => void>;
}
const fences = new Map<string, Fence>();
export function acquireReadFence(
  scope: string,
  invalidate: (generation: number, pattern?: string) => void,
) {
  let fence = fences.get(scope);
  if (!fence) {
    fence = { generation: 0, activeWrites: 0, listeners: new Set() };
    fences.set(scope, fence);
  }
  const shared = fence;
  shared.listeners.add(invalidate);
  invalidate(shared.generation);
  const cleanup = () => {
    if (shared.listeners.size === 0 && shared.activeWrites === 0 && fences.get(scope) === shared)
      fences.delete(scope);
  };
  const invalidateAll = (pattern?: string) => {
    shared.generation++;
    for (const listener of shared.listeners) listener(shared.generation, pattern);
  };
  let released = false;
  return {
    generation: () => shared.generation,
    activeWrites: () => shared.activeWrites,
    invalidate: invalidateAll,
    beginWrite: () => {
      shared.activeWrites++;
      invalidateAll();
    },
    endWrite: () => {
      invalidateAll();
      shared.activeWrites--;
      cleanup();
    },
    release: () => {
      if (released) return;
      released = true;
      shared.listeners.delete(invalidate);
      cleanup();
    },
  };
}
