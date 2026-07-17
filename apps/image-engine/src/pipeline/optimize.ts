import { BoundedCommandError } from "../codecs/command";
import type { CodecCandidate } from "../codecs/jpeg";
import type { OptimizationCandidatePlan, OptimizationPlan } from "./plan";

export interface CandidateVerificationDecision {
  readonly accepted: boolean;
  readonly sizeTargetPassed: boolean;
  readonly qualityMarginPassed: boolean;
}

export type CandidateVerifier = (
  candidate: CodecCandidate,
  candidatePlan: OptimizationCandidatePlan,
  index: number,
) => Promise<CandidateVerificationDecision>;

export class OptimizationExecutionError extends Error {
  readonly code: "ENGINE_TIMEOUT";
  readonly retryable: boolean;
  readonly guidance: "TRY_BALANCED_PRESET";

  constructor(code: "ENGINE_TIMEOUT", retryable: boolean, guidance: "TRY_BALANCED_PRESET") {
    super("image optimization deadline exceeded");
    this.name = "OptimizationExecutionError";
    this.code = code;
    this.retryable = retryable;
    this.guidance = guidance;
  }
}

function smallest(candidates: readonly CodecCandidate[]): CodecCandidate {
  const selected = candidates.reduce((best, candidate) =>
    candidate.byteLength < best.byteLength ? candidate : best,
  );
  return selected;
}

export async function optimizeCandidates(input: {
  readonly plan: OptimizationPlan;
  readonly encode: (candidate: OptimizationCandidatePlan, index: number) => Promise<CodecCandidate>;
  readonly verify: CandidateVerifier;
  readonly signal: AbortSignal;
}): Promise<{ selected: CodecCandidate | null; testedCandidates: number }> {
  const accepted: CodecCandidate[] = [];
  let testedCandidates = 0;
  const plans = input.plan.candidates.slice(0, 3);
  for (let index = 0; index < plans.length; index += 1) {
    if (input.signal.aborted) throw new BoundedCommandError("aborted");
    const candidatePlan = plans[index] as OptimizationCandidatePlan;
    testedCandidates += 1;
    let candidate: CodecCandidate;
    try {
      candidate = await input.encode(candidatePlan, index);
    } catch (error) {
      if (error instanceof BoundedCommandError && error.reason === "timeout") {
        if (accepted.length > 0) {
          return { selected: smallest(accepted), testedCandidates };
        }
        throw new OptimizationExecutionError("ENGINE_TIMEOUT", false, "TRY_BALANCED_PRESET");
      }
      throw error;
    }
    const verification = await input.verify(candidate, candidatePlan, index);
    if (verification.accepted) accepted.push(candidate);
    if (
      verification.accepted &&
      verification.sizeTargetPassed &&
      verification.qualityMarginPassed
    ) {
      return { selected: smallest(accepted), testedCandidates };
    }
  }
  return {
    selected: accepted.length === 0 ? null : smallest(accepted),
    testedCandidates,
  };
}
