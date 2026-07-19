import { z } from "zod";

export const engineBuildInfoSchema = z
  .object({
    protocol: z.literal(1),
    engineBuildId: z.string().min(1),
    codecs: z
      .object({
        jpeg: z.string().min(1),
        png: z.string().min(1),
        webp: z.string().min(1),
        transform: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type EngineBuildInfo = z.infer<typeof engineBuildInfoSchema>;
