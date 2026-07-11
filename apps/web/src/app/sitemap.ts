import type { MetadataRoute } from "next";

export const dynamic = "force-static";

import { SITE_URL, toolList } from "../lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL("/", SITE_URL).toString(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...toolList.map((tool) => ({
      url: new URL(tool.path, SITE_URL).toString(),
      changeFrequency: "weekly" as const,
      priority: 0.9,
    })),
  ];
}
