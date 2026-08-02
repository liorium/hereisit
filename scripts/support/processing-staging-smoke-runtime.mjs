const transientPolicyFailure = "processing staging smoke failed [maintainer-policy-execution]";

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
      if (attempt === 3 || !(error instanceof Error) || error.message !== transientPolicyFailure) {
        throw error;
      }
      await waitForRetry();
    }
  }
}
