import { type ConsoleMessage, expect, type Page, type Route } from "@playwright/test";

const DEFAULT_ORIGIN = "http://127.0.0.1:4173";

interface BrowserPrivacyState {
  leaks: string[];
  objectUrls: string[];
  storageWrites: string[];
}

declare global {
  interface Window {
    __hereisitPrivacyObserver?: BrowserPrivacyState;
  }
}

export interface PrivacyObservation {
  requestCount: number;
  externalRequests: readonly string[];
  writeRequests: readonly string[];
  consoleMessages: readonly string[];
  storageWrites: readonly string[];
  objectUrls: readonly string[];
}

export interface PrivacyObserverOptions {
  fulfillProbePathPrefix?: string;
  origin?: string;
  sentinels?: readonly string[];
}

export async function installPrivacyObserver(
  page: Page,
  options: PrivacyObserverOptions = {},
): Promise<{
  assertClean(expectedDownloads?: number, requireParserWorker?: boolean): Promise<void>;
  clear(): Promise<void>;
  read(): Promise<PrivacyObservation>;
}> {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const sentinels = options.sentinels ?? [];
  const violations: string[] = [];
  const leaks: string[] = [];
  const externalRequests: string[] = [];
  const writeRequests: string[] = [];
  const consoleMessages: string[] = [];
  const context = page.context();
  let requestCount = 0;
  let parserWorkerRequests = 0;
  let downloads = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  let stopped = false;
  await page.addInitScript(
    ({ expectedSentinels }) => {
      const state: BrowserPrivacyState = {
        leaks: [],
        objectUrls: [],
        storageWrites: [],
      };
      window.__hereisitPrivacyObserver = state;

      const inspectConsoleValue = (root: unknown): boolean => {
        const maximumInspectedValues = 10_000;
        const stack: unknown[] = [];
        const visited = new WeakSet<object>();
        let reservedValues = 0;
        const reserve = (count: number) => {
          if (
            !Number.isSafeInteger(count) ||
            count < 0 ||
            count > maximumInspectedValues - reservedValues
          ) {
            throw new Error("Console argument exceeded the privacy inspection limit");
          }
          reservedValues += count;
        };
        const enqueue = (...values: unknown[]) => {
          reserve(values.length);
          stack.push(...values);
        };
        enqueue(root);

        while (stack.length > 0) {
          const value = stack.pop();
          if (typeof value === "string") {
            if (expectedSentinels.some((sentinel) => value.includes(sentinel))) return true;
            continue;
          }
          if (value === null || (typeof value !== "object" && typeof value !== "function")) {
            continue;
          }

          const objectValue = value as object;
          if (visited.has(objectValue)) continue;
          visited.add(objectValue);
          if (
            typeof File !== "undefined" &&
            objectValue instanceof File &&
            expectedSentinels.some((sentinel) => objectValue.name.includes(sentinel))
          ) {
            return true;
          }
          if (
            (typeof Blob !== "undefined" && objectValue instanceof Blob) ||
            (typeof ArrayBuffer !== "undefined" &&
              (objectValue instanceof ArrayBuffer || ArrayBuffer.isView(objectValue))) ||
            (typeof SharedArrayBuffer !== "undefined" && objectValue instanceof SharedArrayBuffer)
          ) {
            throw new Error("Console argument contains an uninspectable byte container");
          }
          if (Array.isArray(objectValue)) {
            const lengthDescriptor = Reflect.getOwnPropertyDescriptor(objectValue, "length");
            if (
              lengthDescriptor === undefined ||
              !("value" in lengthDescriptor) ||
              typeof lengthDescriptor.value !== "number"
            ) {
              throw new Error("Console array length became unreadable");
            }
            reserve(lengthDescriptor.value);
          }
          if (objectValue instanceof Map) {
            const sizeGetter = Reflect.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
            if (sizeGetter === undefined) throw new Error("Console map size became unreadable");
            const size = Reflect.apply(sizeGetter, objectValue, []);
            if (!Number.isSafeInteger(size) || size < 0) {
              throw new Error("Console map size is invalid");
            }
            if (size > Math.floor((maximumInspectedValues - reservedValues) / 2)) {
              throw new Error("Console map exceeded the privacy inspection limit");
            }
            Map.prototype.forEach.call(objectValue, (mapValue: unknown, mapKey: unknown) => {
              enqueue(mapKey, mapValue);
            });
          } else if (objectValue instanceof Set) {
            const sizeGetter = Reflect.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
            if (sizeGetter === undefined) throw new Error("Console set size became unreadable");
            const size = Reflect.apply(sizeGetter, objectValue, []);
            if (!Number.isSafeInteger(size) || size < 0) {
              throw new Error("Console set size is invalid");
            }
            if (size > maximumInspectedValues - reservedValues) {
              throw new Error("Console set exceeded the privacy inspection limit");
            }
            Set.prototype.forEach.call(objectValue, (setValue: unknown) => {
              enqueue(setValue);
            });
          }

          const ownKeys = Reflect.ownKeys(objectValue);
          reserve(ownKeys.length);
          for (const key of ownKeys) {
            const renderedKey = typeof key === "symbol" ? key.description : key;
            if (
              renderedKey !== undefined &&
              expectedSentinels.some((sentinel) => renderedKey.includes(sentinel))
            ) {
              return true;
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(objectValue, key);
            if (descriptor === undefined) {
              throw new Error("Console argument property became unreadable");
            }
            if ("value" in descriptor) enqueue(descriptor.value);
            else throw new Error("Console argument contains an uninspectable accessor");
          }
        }
        return false;
      };
      const inspectConsoleValues = (values: readonly unknown[]) => {
        if (expectedSentinels.length === 0) return;
        try {
          if (values.some((value) => inspectConsoleValue(value))) state.leaks.push("console");
        } catch {
          state.leaks.push("console-inspection-failed");
        }
      };
      const consoleMethods = [
        "assert",
        "count",
        "countReset",
        "debug",
        "dir",
        "dirxml",
        "error",
        "group",
        "groupCollapsed",
        "info",
        "log",
        "table",
        "time",
        "timeEnd",
        "timeLog",
        "timeStamp",
        "trace",
        "warn",
      ] as const;
      for (const method of consoleMethods) {
        const nativeMethod = console[method];
        if (typeof nativeMethod !== "function") continue;
        Object.defineProperty(console, method, {
          configurable: true,
          value: (...values: unknown[]) => {
            inspectConsoleValues(values);
            Reflect.apply(nativeMethod, console, values);
          },
          writable: true,
        });
      }

      const containsSentinel = (...values: string[]) =>
        values.some((value) => expectedSentinels.some((sentinel) => value.includes(sentinel)));
      const encodedValueContainsSentinel = (value: string) => {
        if (containsSentinel(value)) return true;
        try {
          return containsSentinel(decodeURIComponent(value));
        } catch {
          return false;
        }
      };
      const storageArea = (storage: Storage) => {
        try {
          if (storage === window.localStorage) return "localStorage";
          if (storage === window.sessionStorage) return "sessionStorage";
        } catch {
          // The operation itself will retain the browser's native denied-storage behavior.
        }
        return "storage";
      };

      const nativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key: string, value: string) {
        state.storageWrites.push(`${storageArea(this)}:set`);
        if (containsSentinel(key, value)) state.leaks.push("storage");
        return Reflect.apply(nativeSetItem, this, [key, value]);
      };
      const nativeRemoveItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function removeItem(key: string) {
        state.storageWrites.push(`${storageArea(this)}:remove`);
        if (containsSentinel(key)) state.leaks.push("storage");
        return Reflect.apply(nativeRemoveItem, this, [key]);
      };
      const nativeClear = Storage.prototype.clear;
      Storage.prototype.clear = function clear() {
        state.storageWrites.push(`${storageArea(this)}:clear`);
        return Reflect.apply(nativeClear, this, []);
      };

      const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object: Blob | MediaSource) => {
        const url = nativeCreateObjectUrl(object);
        state.objectUrls.push("blob-url-created");
        return url;
      };

      const recordHistoryUrl = (url: string | URL | null | undefined) => {
        if (url !== undefined && url !== null && encodedValueContainsSentinel(String(url))) {
          state.leaks.push("history-url");
        }
      };
      const inspectHistoryState = (root: unknown): string | undefined => {
        const maximumInspectedValues = 10_000;
        const stack: unknown[] = [];
        const visited = new WeakSet<object>();
        let reservedValues = 0;
        const reserve = (count: number) => {
          if (
            !Number.isSafeInteger(count) ||
            count < 0 ||
            count > maximumInspectedValues - reservedValues
          ) {
            throw new Error("History state exceeded the privacy inspection limit");
          }
          reservedValues += count;
        };
        const enqueue = (...values: unknown[]) => {
          reserve(values.length);
          stack.push(...values);
        };
        enqueue(root);

        while (stack.length > 0) {
          const value = stack.pop();
          if (typeof value === "string") {
            if (encodedValueContainsSentinel(value)) return "history-state";
            continue;
          }
          if (value === null || (typeof value !== "object" && typeof value !== "function")) {
            continue;
          }

          const objectValue = value as object;
          if (visited.has(objectValue)) continue;
          visited.add(objectValue);
          if (
            typeof File !== "undefined" &&
            objectValue instanceof File &&
            encodedValueContainsSentinel(objectValue.name)
          ) {
            return "history-state";
          }
          if (
            (typeof Blob !== "undefined" && objectValue instanceof Blob) ||
            (typeof ArrayBuffer !== "undefined" &&
              (objectValue instanceof ArrayBuffer || ArrayBuffer.isView(objectValue))) ||
            (typeof SharedArrayBuffer !== "undefined" && objectValue instanceof SharedArrayBuffer)
          ) {
            return "history-state-bytes";
          }
          if (Array.isArray(objectValue)) {
            const lengthDescriptor = Reflect.getOwnPropertyDescriptor(objectValue, "length");
            if (
              lengthDescriptor === undefined ||
              !("value" in lengthDescriptor) ||
              typeof lengthDescriptor.value !== "number"
            ) {
              return "history-state-inspection-failed";
            }
            reserve(lengthDescriptor.value);
          }
          if (objectValue instanceof Map) {
            const sizeGetter = Reflect.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
            if (sizeGetter === undefined) return "history-state-inspection-failed";
            const size = Reflect.apply(sizeGetter, objectValue, []);
            if (!Number.isSafeInteger(size) || size < 0) {
              return "history-state-inspection-failed";
            }
            reserve(size * 2);
            Map.prototype.forEach.call(objectValue, (mapValue: unknown, mapKey: unknown) => {
              stack.push(mapKey, mapValue);
            });
          } else if (objectValue instanceof Set) {
            const sizeGetter = Reflect.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
            if (sizeGetter === undefined) return "history-state-inspection-failed";
            const size = Reflect.apply(sizeGetter, objectValue, []);
            if (!Number.isSafeInteger(size) || size < 0) {
              return "history-state-inspection-failed";
            }
            reserve(size);
            Set.prototype.forEach.call(objectValue, (setValue: unknown) => {
              stack.push(setValue);
            });
          }

          const ownKeys = Reflect.ownKeys(objectValue);
          reserve(ownKeys.length);
          for (const key of ownKeys) {
            const renderedKey = typeof key === "symbol" ? key.description : key;
            if (renderedKey !== undefined && encodedValueContainsSentinel(renderedKey)) {
              return "history-state";
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(objectValue, key);
            if (descriptor === undefined || !("value" in descriptor)) {
              return "history-state-inspection-failed";
            }
            stack.push(descriptor.value);
          }
        }
        return undefined;
      };
      const recordHistoryState = (data: unknown) => {
        try {
          const leak = inspectHistoryState(data);
          if (leak !== undefined) state.leaks.push(leak);
        } catch {
          state.leaks.push("history-state-inspection-failed");
        }
      };
      const nativePushState = history.pushState.bind(history);
      history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
        recordHistoryUrl(url);
        recordHistoryState(data);
        nativePushState(data, unused, url);
      };
      const nativeReplaceState = history.replaceState.bind(history);
      history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
        recordHistoryUrl(url);
        recordHistoryState(data);
        nativeReplaceState(data, unused, url);
      };
    },
    { expectedSentinels: [...sentinels] },
  );

  const routeHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    requestCount += 1;
    if (url.origin !== origin) {
      violations.push("cross-origin");
      externalRequests.push(`${request.method()} cross-origin`);
    }
    if (!["GET", "HEAD"].includes(request.method()) || request.postData() !== null) {
      if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
      if (request.postData() !== null) violations.push("request-body");
      writeRequests.push(
        `${request.method()} ${url.origin === origin ? "same-origin" : "cross-origin"}`,
      );
    }
    if (url.pathname.startsWith("/pdfjs/") && !url.pathname.startsWith("/pdfjs/6.1.200/")) {
      violations.push("unpinned-pdfjs");
    }
    if (sentinels.some((sentinel) => decodeURIComponent(request.url()).includes(sentinel))) {
      leaks.push("request-url");
    }
    if (url.pathname === "/pdfjs/6.1.200/pdf.worker.min.mjs") parserWorkerRequests += 1;
    if (
      options.fulfillProbePathPrefix !== undefined &&
      url.pathname.startsWith(options.fulfillProbePathPrefix)
    ) {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.continue();
  };

  const consoleHandler = (message: ConsoleMessage) => {
    try {
      const text = message.text();
      consoleMessages.push(message.type());
      if (sentinels.some((sentinel) => text.includes(sentinel))) leaks.push("console");
    } catch {
      leaks.push("console-inspection-failed");
    }
  };
  const downloadHandler = () => {
    downloads += 1;
  };
  const failedRequestHandler = () => {
    failedRequests += 1;
  };
  const pageErrorHandler = () => {
    pageErrors += 1;
  };

  await context.route("**/*", routeHandler);
  page.on("console", consoleHandler);
  page.on("download", downloadHandler);
  context.on("requestfailed", failedRequestHandler);
  page.on("pageerror", pageErrorHandler);

  const flushConsoleEvents = async (): Promise<void> => {
    try {
      await page.evaluate(() => undefined);
    } catch {
      leaks.push("console-inspection-sync-failed");
    }
  };
  const stopObserving = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    page.off("console", consoleHandler);
    page.off("download", downloadHandler);
    context.off("requestfailed", failedRequestHandler);
    page.off("pageerror", pageErrorHandler);
    try {
      await context.unroute("**/*", routeHandler);
    } catch {
      violations.push("observer-cleanup-failed");
    }
  };

  return {
    async clear() {
      await flushConsoleEvents();
      violations.length = 0;
      leaks.length = 0;
      externalRequests.length = 0;
      writeRequests.length = 0;
      consoleMessages.length = 0;
      requestCount = 0;
      parserWorkerRequests = 0;
      downloads = 0;
      failedRequests = 0;
      pageErrors = 0;
      await page.evaluate(() => {
        const state = window.__hereisitPrivacyObserver;
        if (state === undefined) return;
        state.leaks.length = 0;
        state.objectUrls.length = 0;
        state.storageWrites.length = 0;
      });
    },
    async read() {
      await flushConsoleEvents();
      const browserState = await page.evaluate(
        () =>
          window.__hereisitPrivacyObserver ?? {
            leaks: [],
            objectUrls: [],
            storageWrites: [],
          },
      );
      for (const leak of browserState.leaks) {
        if (!leaks.includes(leak)) leaks.push(leak);
      }
      return {
        requestCount,
        externalRequests: [...externalRequests],
        writeRequests: [...writeRequests],
        consoleMessages: [...consoleMessages],
        storageWrites: [...browserState.storageWrites],
        objectUrls: [...browserState.objectUrls],
      };
    },
    async assertClean(expectedDownloads = 0, requireParserWorker = true) {
      await this.read();
      await stopObserving();
      expect(violations).toEqual([]);
      expect(leaks).toEqual([]);
      expect(downloads).toBe(expectedDownloads);
      expect(failedRequests).toBe(0);
      expect(pageErrors).toBe(0);
      if (requireParserWorker) expect(parserWorkerRequests).toBeGreaterThan(0);
    },
  };
}
