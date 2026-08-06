import { availableToolEntries } from "@hereisit/tool-registry/catalog";
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

import { SITE_URL } from "../lib/site-identity";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL("/", SITE_URL).toString(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: new URL("/tools", SITE_URL).toString(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: new URL("/privacy", SITE_URL).toString(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
    ...availableToolEntries.map((tool) => ({
      url: new URL(tool.route, SITE_URL).toString(),
      changeFrequency: "weekly" as const,
      priority: 0.9,
    })),
  ];
}
