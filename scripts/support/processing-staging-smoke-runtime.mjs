const transientFailures = new Set([
  "processing staging smoke failed [public-policy]",
  "processing staging smoke failed [maintainer-policy-missing]",
  "processing staging smoke failed [maintainer-policy-identity]",
  "processing staging smoke failed [maintainer-policy-execution]",
  "processing staging smoke failed [job-create-upstream-rate-limit]",
]);
const maximumPolicyAttempts = 12;

function waitForPropagation() {
  return new Promise((resolve) => setTimeout(resolve, 10_000));
}

export async function runProcessingStagingBrowserSmoke(
  input,
  implementation,
  waitForRetry = waitForPropagation,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await implementation(input);
    } catch (error) {
      if (
        attempt === maximumPolicyAttempts ||
        !(error instanceof Error) ||
        !transientFailures.has(error.message)
      ) {
        throw error;
      }
      await waitForRetry();
    }
  }
}
