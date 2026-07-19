import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalize,
  parseCliArguments,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const strategicClasses = new Set(["screenshot-text", "ui", "code", "logo", "flat-graphic"]);
const defects = new Set(["none", "text", "edge", "banding", "color", "alpha", "blocking", "other"]);

function sideFor(seed, corpusId) {
  return Number.parseInt(
    createHash("sha256").update(`${seed}:${corpusId}`).digest("hex").slice(0, 2),
    16,
  ) %
    2 ===
    0
    ? "left"
    : "right";
}

export function createHumanReviewAssignments({ manifest, seed }) {
  assertSha256(seed, "presentation seed");
  const eligible = manifest.entries.filter((entry) => strategicClasses.has(entry.expected.class));
  if (eligible.length < 20)
    throw new TypeError("at least 20 authorized strategic fixtures are required");
  return eligible.slice(0, 20).map((entry) => ({
    corpusId: entry.id,
    presentationSeed: seed,
    hereisitSide: sideFor(seed, entry.id),
    zoomLevels: [1, 4],
  }));
}

export function recordHumanReview({ assignments, decisions, reviewerIdHash }) {
  assertSha256(reviewerIdHash, "reviewerIdHash");
  if (!Array.isArray(assignments) || assignments.length < 20 || !Array.isArray(decisions))
    throw new TypeError("complete assignments and decisions are required");
  const decisionById = new Map(decisions.map((decision) => [decision.corpusId, decision]));
  return canonicalize(
    assignments.map((assignment) => {
      const decision = assertObject(
        decisionById.get(assignment.corpusId),
        `decision ${assignment.corpusId}`,
      );
      assertExactKeys(
        decision,
        ["corpusId", "preference", "severeDefect", "defect"],
        `decision ${assignment.corpusId}`,
      );
      if (
        !["hereisit", "baseline", "tie"].includes(decision.preference) ||
        typeof decision.severeDefect !== "boolean" ||
        !defects.has(decision.defect)
      )
        throw new TypeError(`invalid decision ${assignment.corpusId}`);
      if (decision.severeDefect && decision.defect === "none")
        throw new TypeError("a severe defect must be classified");
      return {
        corpusId: assignment.corpusId,
        reviewerIdHash,
        presentationSeed: assignment.presentationSeed,
        hereisitSide: assignment.hereisitSide,
        preference: decision.preference,
        severeDefect: decision.severeDefect,
        defect: decision.defect,
      };
    }),
  );
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (args.mode === "prepare") {
    assertExactKeys(args, ["mode", "manifest", "seed", "output"], "prepare arguments");
    const assignments = createHumanReviewAssignments({
      manifest: JSON.parse(await readFile(args.manifest, "utf8")),
      seed: args.seed,
    });
    const hash = await writeCanonicalJsonAtomic(args.output, assignments);
    process.stdout.write(`${hash}\n`);
    return;
  }
  if (args.mode === "record") {
    assertExactKeys(
      args,
      ["mode", "assignments", "decisions", "reviewer-id-hash", "output"],
      "record arguments",
    );
    const records = recordHumanReview({
      assignments: JSON.parse(await readFile(args.assignments, "utf8")),
      decisions: JSON.parse(await readFile(args.decisions, "utf8")),
      reviewerIdHash: args["reviewer-id-hash"],
    });
    const hash = await writeCanonicalJsonAtomic(args.output, records);
    process.stdout.write(`${hash}\n`);
    return;
  }
  throw new TypeError("mode must be prepare or record; this tool performs no network upload");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
