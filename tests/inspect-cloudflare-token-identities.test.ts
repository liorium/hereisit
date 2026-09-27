import { describe, expect, it } from "vitest";
import { inspectCloudflareTokenIdentities } from "../scripts/inspect-cloudflare-token-identities.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const token = "private-token-that-must-never-appear";
const tokenId = "ed17574386854bf78a67040be0a770b0";

describe("Cloudflare credential identity inspection", () => {
  it("reports a complete identity inventory only when every configured slot is verified", async () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: accountId };
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_D1_API_TOKEN",
      "CLOUDFLARE_LOGPUSH_API_TOKEN",
      "CLOUDFLARE_CLEANUP_API_TOKEN",
      "CLOUDFLARE_D1_CLEANUP_API_TOKEN",
      "CLOUDFLARE_LOGPUSH_CLEANUP_API_TOKEN",
      "PRODUCTION_ANALYTICS_READ_TOKEN",
      "PRODUCTION_LOGPUSH_STATUS_TOKEN",
    ])
      env[name] = token;
    const result = await inspectCloudflareTokenIdentities({
      environment: "production",
      env,
      fetchImpl: async () =>
        Response.json({ success: true, result: { id: tokenId, status: "active" } }),
    });
    expect(result.complete).toBe(true);
    expect(result.duplicateGroups[0]).toHaveLength(8);
    expect(result.entries.every((entry) => entry.tokenId === tokenId)).toBe(true);
  });

  it("groups equal values without fingerprints and uses only bounded GET verification", async () => {
    const calls: string[] = [];
    const result = await inspectCloudflareTokenIdentities({
      environment: "production",
      env: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_CLEANUP_API_TOKEN: token,
      },
      fetchImpl: async (url, init) => {
        calls.push(String(url));
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.headers.authorization).toBe(`Bearer ${token}`);
        return Response.json({
          success: true,
          result: { id: tokenId, status: "active", ignored: token },
          messages: [{ message: token }],
        });
      },
    });
    expect(calls).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
    ]);
    expect(result.entries[0]).toMatchObject({
      name: "CLOUDFLARE_API_TOKEN",
      tokenId,
      status: "active",
      issuer: "account",
    });
    expect(result.duplicateGroups).toEqual([
      ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_CLEANUP_API_TOKEN"],
    ]);
    expect(result.entries).toHaveLength(8);
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toMatch(/fingerprint|ignored|message/);
  });

  it("falls back to user verification and never equates denied verification with invalidity", async () => {
    const result = await inspectCloudflareTokenIdentities({
      environment: "staging",
      env: { CLOUDFLARE_ACCOUNT_ID: accountId, STAGING_LOGPUSH_STATUS_TOKEN: token },
      fetchImpl: async (url) =>
        String(url).includes("/user/")
          ? Response.json({ success: true, result: { id: tokenId, status: "expired" } })
          : Response.json({ success: false, errors: [{ message: token }] }, { status: 403 }),
    });
    expect(result.entries.at(-1)).toMatchObject({ issuer: "user", status: "expired", tokenId });
    const denied = await inspectCloudflareTokenIdentities({
      environment: "staging",
      env: { CLOUDFLARE_ACCOUNT_ID: accountId, STAGING_LOGPUSH_STATUS_TOKEN: token },
      fetchImpl: async () => Response.json({ errors: [{ message: token }] }, { status: 403 }),
    });
    expect(denied.entries.at(-1)).toEqual({
      name: "STAGING_LOGPUSH_STATUS_TOKEN",
      status: "unknown",
      attempts: [
        { issuer: "account", httpStatus: 403 },
        { issuer: "user", httpStatus: 403 },
      ],
    });
    expect(JSON.stringify(denied)).not.toContain(token);
  });

  it.each([
    "throw",
    "echo",
    "oversize",
    "malformed",
    "unsuccessful",
    "array-id",
  ])("does not leak or accept %s provider responses", async (kind) => {
    const secret = "a".repeat(32);
    const result = await inspectCloudflareTokenIdentities({
      environment: "production",
      env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: secret },
      fetchImpl: async () => {
        if (kind === "throw") throw new Error(secret);
        if (kind === "oversize") return new Response(secret.repeat(4096));
        if (kind === "malformed") return new Response(secret);
        return Response.json({
          success: kind !== "unsuccessful",
          result: {
            id: kind === "array-id" ? [tokenId] : kind === "echo" ? secret : tokenId,
            status: "active",
          },
        });
      },
    });
    expect(result.entries[0].status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects invalid environment/account input before sending credentials", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return Response.json({});
    };
    for (const environment of ["other", "production"]) {
      await expect(
        inspectCloudflareTokenIdentities({
          environment,
          env: { CLOUDFLARE_ACCOUNT_ID: token },
          fetchImpl,
        }),
      ).rejects.toThrow("Invalid audit configuration");
    }
    expect(calls).toBe(0);
  });
});
