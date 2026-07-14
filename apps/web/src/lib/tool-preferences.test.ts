import { findAvailableToolById } from "@hereisit/tool-registry/catalog";
import { describe, expect, it } from "vitest";
import {
  createToolPreferencesStore,
  FAVORITES_STORAGE_KEY,
  MAX_PERSONAL_TOOLS,
  normalizeStoredToolIds,
  RECENT_STORAGE_KEY,
} from "./tool-preferences";

interface StorageWrite {
  key: string;
  value: string;
}

class FakeStorage {
  readonly writes: StorageWrite[] = [];
  private readonly values = new Map<string, string>();

  constructor(initial: Partial<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      if (value !== undefined) this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
}

function expectIdOnlyWrites(writes: readonly StorageWrite[]): void {
  for (const write of writes) {
    expect([FAVORITES_STORAGE_KEY, RECENT_STORAGE_KEY]).toContain(write.key);
    const payload: unknown = JSON.parse(write.value);
    expect(Array.isArray(payload)).toBe(true);
    if (!Array.isArray(payload)) continue;
    expect(payload.every((value) => typeof value === "string")).toBe(true);
    expect(payload.every((value) => findAvailableToolById(value) !== undefined)).toBe(true);
  }
}

describe("normalizeStoredToolIds", () => {
  it("keeps available IDs in first-seen order and removes duplicates", () => {
    expect(
      normalizeStoredToolIds(
        ["pdf.merge", "image.compress", "pdf.merge", "image.resize", "image.compress"],
        (value) => findAvailableToolById(value)?.id,
      ),
    ).toEqual(["pdf.merge", "image.compress", "image.resize"]);
  });

  it("drops non-strings, removed IDs, and planned IDs", () => {
    expect(
      normalizeStoredToolIds(
        ["removed.tool", 42, null, "media.video-compress", "image.convert"],
        (value) => findAvailableToolById(value)?.id,
      ),
    ).toEqual(["image.convert"]);
  });

  it("returns an empty frozen list for non-array values", () => {
    const normalized = normalizeStoredToolIds(
      { toolId: "image.compress" },
      (value) => findAvailableToolById(value)?.id,
    );

    expect(normalized).toEqual([]);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("caps a synthetic inventory at the first 12 IDs", () => {
    const syntheticIds = Array.from({ length: 13 }, (_, index) => `synthetic.${index + 1}`);
    const syntheticInventory = new Set(syntheticIds);

    expect(
      normalizeStoredToolIds(
        syntheticIds,
        (value) => (syntheticInventory.has(value) ? value : undefined),
        MAX_PERSONAL_TOOLS,
      ),
    ).toEqual(syntheticIds.slice(0, 12));
  });
});

describe("createToolPreferencesStore", () => {
  it("resolves storage lazily and filters both stored lists to available IDs", () => {
    const storage = new FakeStorage({
      [FAVORITES_STORAGE_KEY]: JSON.stringify([
        "pdf.merge",
        "media.video-compress",
        "pdf.merge",
        "removed.tool",
        "image.compress",
      ]),
      [RECENT_STORAGE_KEY]: JSON.stringify([
        "image.resize",
        "image.resize",
        "media.video-compress",
        "pdf.split",
      ]),
    });
    let resolutions = 0;
    const store = createToolPreferencesStore(() => {
      resolutions += 1;
      return storage;
    });

    expect(resolutions).toBe(0);
    expect(store.getSnapshot()).toEqual({
      favorites: ["pdf.merge", "image.compress"],
      recent: ["image.resize", "pdf.split"],
      persistence: "local",
    });
    expect(resolutions).toBe(1);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(resolutions).toBe(1);
  });

  it.each([
    ["malformed JSON", "{not-json", JSON.stringify([])],
    ["a non-array payload", JSON.stringify([]), JSON.stringify({ id: "pdf.merge" })],
  ])("switches permanently to memory for %s", (_case, favorites, recent) => {
    const storage = new FakeStorage({
      [FAVORITES_STORAGE_KEY]: favorites,
      [RECENT_STORAGE_KEY]: recent,
    });
    const store = createToolPreferencesStore(() => storage);

    expect(store.getSnapshot()).toEqual({ favorites: [], recent: [], persistence: "memory" });

    store.recordRecent("pdf.merge");
    store.toggleFavorite("image.compress");

    expect(store.getSnapshot()).toEqual({
      favorites: ["image.compress"],
      recent: ["pdf.merge"],
      persistence: "memory",
    });
    expect(storage.writes).toEqual([]);
  });

  it("records recents newest-first and does not republish an identical head", () => {
    const storage = new FakeStorage({
      [RECENT_STORAGE_KEY]: JSON.stringify(["pdf.merge", "image.compress"]),
    });
    const store = createToolPreferencesStore(() => storage);
    const initial = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.recordRecent("image.resize");
    const changed = store.getSnapshot();
    expect(changed.recent).toEqual(["image.resize", "pdf.merge", "image.compress"]);
    expect(changed).not.toBe(initial);
    expect(notifications).toBe(1);

    store.recordRecent("image.resize");
    expect(store.getSnapshot()).toBe(changed);
    expect(notifications).toBe(1);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]).toEqual({
      key: RECENT_STORAGE_KEY,
      value: JSON.stringify(["image.resize", "pdf.merge", "image.compress"]),
    });
    expectIdOnlyWrites(storage.writes);
  });

  it("moves a repeated recent ID to the front and publishes one changed snapshot", () => {
    const storage = new FakeStorage({
      [RECENT_STORAGE_KEY]: JSON.stringify(["pdf.merge", "image.compress", "image.resize"]),
    });
    const store = createToolPreferencesStore(() => storage);
    store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.recordRecent("image.resize");

    expect(store.getSnapshot().recent).toEqual(["image.resize", "pdf.merge", "image.compress"]);
    expect(notifications).toBe(1);
    expectIdOnlyWrites(storage.writes);
  });

  it("adds and removes favorites explicitly with one notification per toggle", () => {
    const storage = new FakeStorage();
    const store = createToolPreferencesStore(() => storage);
    store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.toggleFavorite("pdf.merge");
    expect(store.getSnapshot().favorites).toEqual(["pdf.merge"]);
    expect(notifications).toBe(1);

    store.toggleFavorite("image.compress");
    expect(store.getSnapshot().favorites).toEqual(["pdf.merge", "image.compress"]);
    expect(notifications).toBe(2);

    store.toggleFavorite("pdf.merge");
    expect(store.getSnapshot().favorites).toEqual(["image.compress"]);
    expect(notifications).toBe(3);
    expect(storage.writes).toEqual([
      { key: FAVORITES_STORAGE_KEY, value: JSON.stringify(["pdf.merge"]) },
      {
        key: FAVORITES_STORAGE_KEY,
        value: JSON.stringify(["pdf.merge", "image.compress"]),
      },
      { key: FAVORITES_STORAGE_KEY, value: JSON.stringify(["image.compress"]) },
    ]);
    expectIdOnlyWrites(storage.writes);
  });

  it("returns cached frozen snapshots until data changes", () => {
    const storage = new FakeStorage();
    const store = createToolPreferencesStore(() => storage);
    const initial = store.getSnapshot();

    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.favorites)).toBe(true);
    expect(Object.isFrozen(initial.recent)).toBe(true);
    expect(store.getSnapshot()).toBe(initial);

    store.recordRecent("pdf.merge");
    const changed = store.getSnapshot();
    expect(changed).not.toBe(initial);
    expect(Object.isFrozen(changed)).toBe(true);
    expect(Object.isFrozen(changed.recent)).toBe(true);
    expect(store.getSnapshot()).toBe(changed);
    expectIdOnlyWrites(storage.writes);
  });

  it("switches permanently to memory when a storage read is denied", () => {
    let reads = 0;
    let writes = 0;
    const store = createToolPreferencesStore(() => ({
      getItem() {
        reads += 1;
        throw new DOMException("Denied", "SecurityError");
      },
      setItem() {
        writes += 1;
      },
    }));

    expect(store.getSnapshot()).toEqual({ favorites: [], recent: [], persistence: "memory" });
    expect(reads).toBe(1);

    store.recordRecent("pdf.merge");
    store.toggleFavorite("image.compress");

    expect(store.getSnapshot()).toEqual({
      favorites: ["image.compress"],
      recent: ["pdf.merge"],
      persistence: "memory",
    });
    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });

  it("keeps the changed data in memory when a storage write is denied", () => {
    const storage = new FakeStorage();
    let writeAttempts = 0;
    const store = createToolPreferencesStore(() => ({
      getItem: storage.getItem.bind(storage),
      setItem(key, value) {
        writeAttempts += 1;
        storage.writes.push({ key, value });
        throw new DOMException("Denied", "QuotaExceededError");
      },
    }));
    store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.recordRecent("pdf.merge");

    expect(store.getSnapshot()).toEqual({
      favorites: [],
      recent: ["pdf.merge"],
      persistence: "memory",
    });
    expect(notifications).toBe(1);
    expect(writeAttempts).toBe(1);
    expect(storage.writes).toEqual([
      { key: RECENT_STORAGE_KEY, value: JSON.stringify(["pdf.merge"]) },
    ]);
    expectIdOnlyWrites(storage.writes);

    store.toggleFavorite("image.compress");
    store.recordRecent("image.resize");

    expect(store.getSnapshot()).toEqual({
      favorites: ["image.compress"],
      recent: ["image.resize", "pdf.merge"],
      persistence: "memory",
    });
    expect(notifications).toBe(3);
    expect(writeAttempts).toBe(1);
    expectIdOnlyWrites(storage.writes);
  });

  it("uses memory without resolving browser storage during a server read", () => {
    const store = createToolPreferencesStore();

    expect(store.getSnapshot()).toEqual({ favorites: [], recent: [], persistence: "memory" });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
});
