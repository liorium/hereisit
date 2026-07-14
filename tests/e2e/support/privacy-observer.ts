import {
  type ConsoleMessage,
  expect,
  type JSHandle,
  type Page,
  type Route,
} from "@playwright/test";

const DEFAULT_ORIGIN = "http://127.0.0.1:4173";

interface BrowserPrivacyState {
  historyUrls: string[];
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
  disposeConsoleArgument?: (argument: JSHandle) => Promise<void>;
  origin?: string;
  sentinels?: readonly string[];
}

export async function installPrivacyObserver(
  page: Page,
  options: PrivacyObserverOptions = {},
): Promise<{
  assertClean(expectedDownloads?: number, requireParserWorker?: boolean): Promise<void>;
  read(): Promise<PrivacyObservation>;
}> {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const sentinels = options.sentinels ?? [];
  const violations: string[] = [];
  const leaks: string[] = [];
  const externalRequests: string[] = [];
  const writeRequests: string[] = [];
  const consoleMessages: string[] = [];
  const pendingConsoleInspections = new Set<Promise<void>>();
  const context = page.context();
  let requestCount = 0;
  let parserWorkerRequests = 0;
  let downloads = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  let stopped = false;
  const disposeConsoleArgument =
    options.disposeConsoleArgument ?? ((argument: JSHandle) => argument.dispose());

  await page.addInitScript(() => {
    const state: BrowserPrivacyState = {
      historyUrls: [],
      objectUrls: [],
      storageWrites: [],
    };
    window.__hereisitPrivacyObserver = state;

    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      state.storageWrites.push(`${key}:${value}`);
      return Reflect.apply(nativeSetItem, this, [key, value]);
    };
    const nativeRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function removeItem(key: string) {
      state.storageWrites.push(`remove:${key}`);
      return Reflect.apply(nativeRemoveItem, this, [key]);
    };
    const nativeClear = Storage.prototype.clear;
    Storage.prototype.clear = function clear() {
      state.storageWrites.push("clear");
      return Reflect.apply(nativeClear, this, []);
    };

    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = nativeCreateObjectUrl(object);
      state.objectUrls.push(url);
      return url;
    };

    const recordHistoryUrl = (url: string | URL | null | undefined) => {
      if (url !== undefined && url !== null) state.historyUrls.push(String(url));
    };
    const nativePushState = history.pushState.bind(history);
    history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
      recordHistoryUrl(url);
      nativePushState(data, unused, url);
    };
    const nativeReplaceState = history.replaceState.bind(history);
    history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
      recordHistoryUrl(url);
      nativeReplaceState(data, unused, url);
    };
  });

  const routeHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    requestCount += 1;
    if (url.origin !== origin) {
      violations.push("cross-origin");
      externalRequests.push(request.url());
    }
    if (!["GET", "HEAD"].includes(request.method()) || request.postData() !== null) {
      if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
      if (request.postData() !== null) violations.push("request-body");
      writeRequests.push(`${request.method()} ${request.url()}`);
    }
    if (url.pathname.startsWith("/pdfjs/") && !url.pathname.startsWith("/pdfjs/6.1.200/")) {
      violations.push("unpinned-pdfjs");
    }
    if (sentinels.some((sentinel) => decodeURIComponent(request.url()).includes(sentinel))) {
      leaks.push("request-url");
    }
    if (url.pathname === "/pdfjs/6.1.200/pdf.worker.min.mjs") parserWorkerRequests += 1;
    await route.continue();
  };

  const inspectConsoleArguments = async (message: ConsoleMessage): Promise<void> => {
    if (sentinels.length === 0) return;
    let arguments_: ReturnType<ConsoleMessage["args"]> = [];
    try {
      arguments_ = message.args();
      for (const argument of arguments_) {
        const found = await argument.evaluate((root, expectedSentinels) => {
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
              if ("value" in descriptor) {
                enqueue(descriptor.value);
              } else {
                throw new Error("Console argument contains an uninspectable accessor");
              }
            }
          }
          return false;
        }, sentinels);
        if (found) {
          leaks.push("console-argument");
          return;
        }
      }
    } catch {
      leaks.push("console-inspection-failed");
    } finally {
      const cleanupResults = await Promise.allSettled(
        arguments_.map((argument) => disposeConsoleArgument(argument)),
      );
      if (cleanupResults.some((result) => result.status === "rejected")) {
        leaks.push("console-cleanup-failed");
      }
    }
  };

  const consoleHandler = (message: ConsoleMessage) => {
    try {
      const text = message.text();
      consoleMessages.push(text);
      if (sentinels.some((sentinel) => text.includes(sentinel))) leaks.push("console");
    } catch {
      leaks.push("console-inspection-failed");
    }
    if (sentinels.length === 0) return;
    const inspection = inspectConsoleArguments(message);
    pendingConsoleInspections.add(inspection);
    void inspection.then(
      () => pendingConsoleInspections.delete(inspection),
      () => pendingConsoleInspections.delete(inspection),
    );
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
  const drainConsoleInspections = async (): Promise<void> => {
    while (pendingConsoleInspections.size > 0) {
      await Promise.allSettled([...pendingConsoleInspections]);
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
    async read() {
      await flushConsoleEvents();
      await drainConsoleInspections();
      const browserState = await page.evaluate(
        () =>
          window.__hereisitPrivacyObserver ?? {
            historyUrls: [],
            objectUrls: [],
            storageWrites: [],
          },
      );
      if (
        sentinels.some((sentinel) =>
          browserState.historyUrls.some((url) => decodeURIComponent(url).includes(sentinel)),
        )
      ) {
        leaks.push("history-url");
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
      await drainConsoleInspections();
      expect(violations).toEqual([]);
      expect(leaks).toEqual([]);
      expect(downloads).toBe(expectedDownloads);
      expect(failedRequests).toBe(0);
      expect(pageErrors).toBe(0);
      if (requireParserWorker) expect(parserWorkerRequests).toBeGreaterThan(0);
    },
  };
}
