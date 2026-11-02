/**
 * Registry for browser-side private state (polling, playback, drafts, view
 * caches). Sign-out calls clearPrivateState() before navigating away.
 */
type Cleanup = () => void;
const cleanups = new Set<Cleanup>();

export const PRIVATE_STORAGE_PREFIX = "sa:";

export function registerPrivateState(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

function purge(storage: Storage | undefined): void {
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(PRIVATE_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

let controller = new AbortController();

/** Signal for every private fetch/poll; aborted when private state is cleared. */
export function privateSignal(): AbortSignal {
  return controller.signal;
}

export function clearPrivateState(): void {
  controller.abort();
  controller = new AbortController();
  for (const cleanup of [...cleanups]) {
    try {
      cleanup();
    } catch {
      // A failing cleanup must not keep the rest of the private state alive.
    }
  }
  if (typeof window === "undefined") return;
  try {
    purge(window.sessionStorage);
    purge(window.localStorage);
  } catch {
    // Storage may be unavailable (privacy mode); nothing to clear then.
  }
}
