import { expect, type Page } from "@playwright/test";

type WebShareCalls = { canShare: number; share: number };
type ResultDeliveryWindow = Window & {
  __hereisitBlockDownloads?: boolean;
  __hereisitWebShareCalls?: WebShareCalls;
};

export async function installAvailableWebShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as ResultDeliveryWindow;
    tracked.__hereisitWebShareCalls = { canShare: 0, share: 0 };
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => {
        const calls = tracked.__hereisitWebShareCalls ?? { canShare: 0, share: 0 };
        calls.canShare += 1;
        tracked.__hereisitWebShareCalls = calls;
        return true;
      },
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        const calls = tracked.__hereisitWebShareCalls ?? { canShare: 0, share: 0 };
        calls.share += 1;
        tracked.__hereisitWebShareCalls = calls;
        throw new Error("Result delivery must not call Web Share");
      },
    });
  });
}

export async function expectWebShareUnused(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as ResultDeliveryWindow).__hereisitWebShareCalls ?? {
            canShare: 0,
            share: 0,
          },
      ),
    )
    .toEqual({ canShare: 0, share: 0 });
}

export async function installDownloadActivationController(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as ResultDeliveryWindow;
    tracked.__hereisitBlockDownloads = false;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (tracked.__hereisitBlockDownloads && this.download.length > 0) {
        throw new Error("controlled download activation failure");
      }
      originalClick.call(this);
    };
  });
}

export async function setDownloadActivationBlocked(page: Page, blocked: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as ResultDeliveryWindow).__hereisitBlockDownloads = value;
  }, blocked);
}
