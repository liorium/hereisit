import assert from "node:assert/strict";

const EMPTY_WEB_SHARE_CALLS = { canShare: 0, share: 0 };

export function installAvailableWebShareTripwire() {
  sessionStorage.setItem("__hereisitWebShareCalls", JSON.stringify({ canShare: 0, share: 0 }));
  const recordShareCall = (key) => {
    const calls = JSON.parse(
      sessionStorage.getItem("__hereisitWebShareCalls") ?? '{"canShare":0,"share":0}',
    );
    calls[key] += 1;
    sessionStorage.setItem("__hereisitWebShareCalls", JSON.stringify(calls));
  };
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: () => {
      recordShareCall("canShare");
      return true;
    },
  });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async () => {
      recordShareCall("share");
      throw new Error("Result delivery must not call Web Share");
    },
  });
}

export async function assertWebShareUnused(page) {
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("__hereisitWebShareCalls") ?? '{"canShare":0,"share":0}'),
    ),
    EMPTY_WEB_SHARE_CALLS,
    "Result delivery consulted Web Share.",
  );
}

export async function assertNoVisibleShareResultDelivery(resultDelivery) {
  const actionRoles = ["button", "link", "menuitem"];
  const [visibleActionCount, visibleShareActionCount, visibleStatusCopy] = await Promise.all([
    Promise.all(actionRoles.map((role) => resultDelivery.getByRole(role).count())).then((counts) =>
      counts.reduce((total, count) => total + count, 0),
    ),
    Promise.all(
      actionRoles.map((role) => resultDelivery.getByRole(role, { name: /공유/ }).count()),
    ).then((counts) => counts.reduce((total, count) => total + count, 0)),
    resultDelivery.getByRole("status").allTextContents(),
  ]);

  assert.ok(visibleActionCount > 0, "Visible result actions were unavailable.");
  assert.ok(visibleStatusCopy.length > 0, "Visible result status copy was unavailable.");
  assert.equal(visibleShareActionCount, 0, "A visible result action offered sharing.");
  assert.ok(
    visibleStatusCopy.every((copy) => !copy.includes("공유")),
    "Visible result status copy offered sharing.",
  );
}
