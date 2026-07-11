import type { Metadata } from "next";
import { type ImageToolConfig, type PdfToolConfig, SITE_NAME, SITE_URL } from "./site";

export function createToolMetadata(tool: ImageToolConfig | PdfToolConfig): Metadata {
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

export const createImageToolMetadata = createToolMetadata;
