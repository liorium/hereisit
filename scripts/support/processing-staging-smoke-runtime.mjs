const transientPolicyFailure = "processing staging smoke failed [maintainer-policy-execution]";

export async function runProcessingStagingBrowserSmoke(input, implementation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await implementation(input);
    } catch (error) {
      if (attempt === 3 || !(error instanceof Error) || error.message !== transientPolicyFailure) {
        throw error;
      }
    }
  }
}
