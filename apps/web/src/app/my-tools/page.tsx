import type { Metadata } from "next";
import { MyTools } from "../../components/my-tools";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

export const metadata: Metadata = {
  title: "내 도구",
  robots: { index: false, follow: true },
  alternates: { canonical: "/my-tools" },
};

export default function MyToolsPage() {
  return (
    <main>
      <SiteHeader activePath="/my-tools" />
      <MyTools />
      <SiteFooter />
    </main>
  );
}
