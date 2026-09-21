import {
  IMAGE_OPTIMIZE_CONTRACT_ID,
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_FILES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
} from "@hereisit/tool-contracts/image-optimize";

export interface ProcessingManifest {
  toolId: "image.compress";
  contractId: "image.optimize@1";
  accepts: readonly ["image/jpeg", "image/png", "image/webp"];
  emits: "same-format";
  locations: readonly ["server-native", "browser"];
  limits: {
    maxFiles: 20;
    maxBytesPerFile: 31_457_280;
    maxPixelsPerFile: 40_000_000;
    maxConcurrentPerAnonymousSession: 1;
  };
  resourceClass: "image-standard-v1";
  retention: {
    uploadDeadlineSeconds: 600;
    resultDeadlineSeconds: 1800;
    sweepSeconds: 300;
    resultDeletionSloSeconds: 2100;
    lifecycleExpirationDays: 1;
    hardMaximum: false;
  };
  verifier: "image.optimize@1";
  safeFallback: "browser.same-format";
  rolloutFlag: "image-compress-server";
}

export const imageCompressionProcessingManifest = Object.freeze({
  toolId: "image.compress",
  contractId: IMAGE_OPTIMIZE_CONTRACT_ID,
  accepts: Object.freeze(["image/jpeg", "image/png", "image/webp"] as const),
  emits: "same-format",
  locations: Object.freeze(["server-native", "browser"] as const),
  limits: Object.freeze({
    maxFiles: IMAGE_OPTIMIZE_MAX_FILES,
    maxBytesPerFile:
      IMAGE_OPTIMIZE_MAX_FILE_BYTES as ProcessingManifest["limits"]["maxBytesPerFile"],
    maxPixelsPerFile: IMAGE_OPTIMIZE_MAX_PIXELS,
    maxConcurrentPerAnonymousSession: 1,
  }),
  resourceClass: "image-standard-v1",
  retention: Object.freeze({
    uploadDeadlineSeconds: 600,
    resultDeadlineSeconds: 1800,
    sweepSeconds: 300,
    resultDeletionSloSeconds: 2100,
    lifecycleExpirationDays: 1,
    hardMaximum: false,
  }),
  verifier: IMAGE_OPTIMIZE_CONTRACT_ID,
  safeFallback: "browser.same-format",
  rolloutFlag: "image-compress-server",
} as const satisfies ProcessingManifest);
