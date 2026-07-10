import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "HereItIs — 이미지 작업, 여기서 끝",
    template: "%s | HereItIs",
  },
  description: "이미지 압축, 크기 조절, 형식 변환을 업로드 없이 내 기기에서 빠르게 처리하세요.",
  applicationName: "HereItIs",
  robots: { index: true, follow: true },
  openGraph: {
    title: "HereItIs — 이미지 작업, 여기서 끝",
    description: "파일은 기기 밖으로 나가지 않아요. 여러 이미지를 한 번에 빠르게 처리하세요.",
    type: "website",
    locale: "ko_KR",
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
