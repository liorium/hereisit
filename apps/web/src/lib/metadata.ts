import type { AvailableToolEntry } from "@hereisit/tool-registry/catalog";
import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "./site-identity";

export function createToolMetadata(tool: AvailableToolEntry): Metadata {
  const canonical = new URL(tool.route, SITE_URL).toString();
  const socialTitle = `${tool.name} | ${SITE_NAME}`;

  return {
    title: tool.name,
    description: tool.shortDescription,
    alternates: { canonical },
    openGraph: {
      title: socialTitle,
      description: tool.shortDescription,
      url: canonical,
      siteName: SITE_NAME,
      type: "website",
      locale: "ko_KR",
    },
    twitter: {
      card: "summary",
      title: socialTitle,
      description: tool.shortDescription,
    },
  };
}
