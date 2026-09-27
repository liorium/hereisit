import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const idPattern = /^[a-f0-9]{32}$/;
const tokenPattern = /^[!-~]{20,512}$/;

export async function readEnvelope(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error("Response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Token verification proves identity/status, NOT product permissions or account resource scope.
export async function inspectCloudflareTokenIdentities({ environment, env, fetchImpl = fetch }) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!["staging", "production"].includes(environment) || !idPattern.test(accountId ?? "")) {
    throw new Error("Invalid audit configuration");
  }
  const names = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_D1_API_TOKEN",
    "CLOUDFLARE_LOGPUSH_API_TOKEN",
    "CLOUDFLARE_CLEANUP_API_TOKEN",
    "CLOUDFLARE_D1_CLEANUP_API_TOKEN",
    "CLOUDFLARE_LOGPUSH_CLEANUP_API_TOKEN",
    `${environment.toUpperCase()}_ANALYTICS_READ_TOKEN`,
    `${environment.toUpperCase()}_LOGPUSH_STATUS_TOKEN`,
  ];
  const values = names
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value);
  const groups = new Map();
  const results = new Map();
  const entries = [];
  for (const name of names) {
    const token = env[name];
    if (typeof token !== "string" || !tokenPattern.test(token)) {
      entries.push({ name, status: "unknown", reason: token ? "invalid-format" : "missing" });
      continue;
    }
    if (!groups.has(token)) groups.set(token, []);
    groups.get(token).push(name);
    if (!results.has(token)) {
      const attempts = [];
      let identity;
      for (const issuer of ["account", "user"]) {
        const path = issuer === "account" ? `accounts/${accountId}` : "user";
        const attempt = { issuer };
        attempts.push(attempt);
        try {
          const response = await fetchImpl(
            `https://api.cloudflare.com/client/v4/${path}/tokens/verify`,
            {
              method: "GET",
              redirect: "error",
              signal: AbortSignal.timeout(8000),
              headers: { authorization: `Bearer ${token}`, accept: "application/json" },
            },
          );
          attempt.httpStatus = response.status;
          if (!response.ok) {
            await response.body?.cancel();
            continue;
          }
          const envelope = await readEnvelope(response);
          const result = envelope?.result;
          if (
            envelope?.success === true &&
            typeof result?.id === "string" &&
            idPattern.test(result?.id ?? "") &&
            ["active", "disabled", "expired"].includes(result?.status) &&
            !values.some((value) => result.id.includes(value))
          ) {
            identity = { issuer, tokenId: result.id, status: result.status };
            break;
          }
          attempt.failure = "invalid-response";
        } catch {
          // Never expose upstream errors, headers, bodies, credentials or derived fingerprints.
          attempt.failure = "request-or-response-failed";
        }
      }
      results.set(token, identity ?? { status: "unknown", attempts });
    }
    entries.push({ name, ...results.get(token) });
  }
  return {
    environment,
    complete: entries.every((entry) => entry.tokenId !== undefined),
    entries,
    // Equality is checked only in memory. Output contains slot names, never hashes or values.
    duplicateGroups: [...groups.values()].filter((group) => group.length > 1),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("Invalid arguments");
    const report = await inspectCloudflareTokenIdentities({
      environment: process.argv[2],
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write("Credential identity audit failed; no credential details emitted.\n");
    process.exitCode = 1;
  }
}
