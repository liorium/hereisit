import { type AvailableToolId, findAvailableToolById } from "@hereisit/tool-registry/catalog";

export const MAX_PERSONAL_TOOLS = 12;
export const FAVORITES_STORAGE_KEY = "hereisit.favorite-tools.v1";
export const RECENT_STORAGE_KEY = "hereisit.recent-tools.v1";

export interface ToolPreferencesSnapshot {
  favorites: readonly AvailableToolId[];
  recent: readonly AvailableToolId[];
  persistence: "local" | "memory";
}

export interface ToolPreferencesStore {
  getSnapshot(): ToolPreferencesSnapshot;
  subscribe(listener: () => void): () => void;
  recordRecent(id: AvailableToolId): void;
  toggleFavorite(id: AvailableToolId): void;
}

type ToolPreferencesStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY_AVAILABLE_TOOL_IDS: readonly AvailableToolId[] = Object.freeze([]);
const EMPTY_MEMORY_SNAPSHOT: ToolPreferencesSnapshot = Object.freeze({
  favorites: EMPTY_AVAILABLE_TOOL_IDS,
  recent: EMPTY_AVAILABLE_TOOL_IDS,
  persistence: "memory",
});

function freezeToolIds(ids: readonly AvailableToolId[]): readonly AvailableToolId[] {
  return Object.freeze([...ids]);
}

function createSnapshot(
  favorites: readonly AvailableToolId[],
  recent: readonly AvailableToolId[],
  persistence: ToolPreferencesSnapshot["persistence"],
): ToolPreferencesSnapshot {
  return Object.freeze({ favorites, recent, persistence });
}

function parseStoredValue(value: string | null): readonly unknown[] | undefined {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeStoredToolIds<T extends string>(
  value: unknown,
  resolveId: (value: string) => T | undefined,
  limit = MAX_PERSONAL_TOOLS,
): readonly T[] {
  if (!Array.isArray(value) || limit <= 0) return Object.freeze([]);

  const normalized: T[] = [];
  const seen = new Set<T>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const id = resolveId(candidate);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length >= limit) break;
  }
  return Object.freeze(normalized);
}

export function createToolPreferencesStore(
  resolveStorage?: () => ToolPreferencesStorage,
): ToolPreferencesStore {
  const hasInjectedStorage = resolveStorage !== undefined;
  const storageResolver = resolveStorage ?? (() => window.localStorage);
  const listeners = new Set<() => void>();
  let initialized = false;
  let storage: ToolPreferencesStorage | undefined;
  let snapshot = EMPTY_MEMORY_SNAPSHOT;

  function initialize(): void {
    if (initialized) return;
    initialized = true;

    let favoriteValue: string | null;
    let recentValue: string | null;
    try {
      storage = storageResolver();
      favoriteValue = storage.getItem(FAVORITES_STORAGE_KEY);
      recentValue = storage.getItem(RECENT_STORAGE_KEY);
    } catch {
      storage = undefined;
      snapshot = EMPTY_MEMORY_SNAPSHOT;
      return;
    }

    const resolveAvailableId = (id: string): AvailableToolId | undefined =>
      findAvailableToolById(id)?.id as AvailableToolId | undefined;
    const storedFavorites = parseStoredValue(favoriteValue);
    const storedRecent = parseStoredValue(recentValue);
    if (storedFavorites === undefined || storedRecent === undefined) {
      storage = undefined;
      snapshot = EMPTY_MEMORY_SNAPSHOT;
      return;
    }
    const favorites = normalizeStoredToolIds(
      storedFavorites,
      resolveAvailableId,
      MAX_PERSONAL_TOOLS,
    );
    const recent = normalizeStoredToolIds(storedRecent, resolveAvailableId, MAX_PERSONAL_TOOLS);
    snapshot = createSnapshot(favorites, recent, "local");
  }

  function initializeForMutation(): void {
    if (!initialized && !hasInjectedStorage && typeof window === "undefined") {
      initialized = true;
      snapshot = EMPTY_MEMORY_SNAPSHOT;
      return;
    }
    initialize();
  }

  function publish(next: ToolPreferencesSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function persist(
    key: typeof FAVORITES_STORAGE_KEY | typeof RECENT_STORAGE_KEY,
    ids: readonly AvailableToolId[],
  ): ToolPreferencesSnapshot["persistence"] {
    if (snapshot.persistence === "memory" || storage === undefined) return "memory";
    try {
      storage.setItem(key, JSON.stringify(ids));
      return "local";
    } catch {
      storage = undefined;
      return "memory";
    }
  }

  return {
    getSnapshot() {
      if (!initialized && !hasInjectedStorage && typeof window === "undefined") {
        return EMPTY_MEMORY_SNAPSHOT;
      }
      initialize();
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recordRecent(id) {
      initializeForMutation();
      if (snapshot.recent[0] === id) return;

      const recent = freezeToolIds(
        [id, ...snapshot.recent.filter((recentId) => recentId !== id)].slice(0, MAX_PERSONAL_TOOLS),
      );
      const persistence = persist(RECENT_STORAGE_KEY, recent);
      publish(createSnapshot(snapshot.favorites, recent, persistence));
    },
    toggleFavorite(id) {
      initializeForMutation();
      const favorites = snapshot.favorites.includes(id)
        ? freezeToolIds(snapshot.favorites.filter((favoriteId) => favoriteId !== id))
        : freezeToolIds([...snapshot.favorites, id].slice(-MAX_PERSONAL_TOOLS));
      const persistence = persist(FAVORITES_STORAGE_KEY, favorites);
      publish(createSnapshot(favorites, snapshot.recent, persistence));
    },
  };
}

export const toolPreferencesStore: ToolPreferencesStore = createToolPreferencesStore();
