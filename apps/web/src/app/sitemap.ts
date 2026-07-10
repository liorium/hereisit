import type { MetadataRoute } from "next";

export const dynamic = "force-static";

import { imageToolList, SITE_URL } from "../lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL("/", SITE_URL).toString(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...imageToolList.map((tool) => ({
      url: new URL(tool.path, SITE_URL).toString(),
      changeFrequency: "weekly" as const,
      priority: 0.9,
    })),
  ];
}
