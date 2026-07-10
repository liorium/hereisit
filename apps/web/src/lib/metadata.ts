import type { Metadata } from "next";
import { type ImageToolConfig, SITE_NAME, SITE_URL } from "./site";

export function createImageToolMetadata(tool: ImageToolConfig): Metadata {
  const canonical = new URL(tool.path, SITE_URL).toString();
  const socialTitle = `${tool.title} | ${SITE_NAME}`;

  return {
    title: tool.title,
    description: tool.description,
    alternates: { canonical },
    openGraph: {
      title: socialTitle,
      description: tool.description,
      url: canonical,
      siteName: SITE_NAME,
      type: "website",
      locale: "ko_KR",
    },
    twitter: {
      card: "summary",
      title: socialTitle,
      description: tool.description,
    },
  };
}
