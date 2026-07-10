import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import {
  HOME_DESCRIPTION,
  HOME_OPEN_GRAPH_DESCRIPTION,
  HOME_TITLE,
  SITE_NAME,
  SITE_URL,
} from "../lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: HOME_TITLE,
    template: "%s | HereItIs",
  },
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    title: HOME_TITLE,
    description: HOME_OPEN_GRAPH_DESCRIPTION,
    url: "/",
    siteName: SITE_NAME,
    type: "website",
    locale: "ko_KR",
  },
  twitter: {
    card: "summary",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f7f2",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
