import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";
import { ToolCatalogBrowser } from "../../components/tool-catalog-browser";
import styles from "../../components/tool-catalog-browser.module.css";

const fallbackCardKeys = ["first", "second", "third"] as const;

export const metadata: Metadata = {
  title: "모든 도구",
  description: "HereIsIt에서 지금 사용할 수 있는 파일 도구를 검색하고 분야별로 찾아보세요.",
  alternates: { canonical: "/tools" },
};

function CatalogFallback() {
  return (
    <section aria-label="도구 목록 불러오는 중" className={styles.fallback}>
      <h1>모든 도구</h1>
      <div className={styles.fallbackCards}>
        {fallbackCardKeys.map((key) => (
          <div aria-hidden="true" className={styles.fallbackCard} key={key} />
        ))}
      </div>
    </section>
  );
}

export default function ToolsPage() {
  return (
    <main>
      <SiteHeader activePath="/tools" />
      <Suspense fallback={<CatalogFallback />}>
        <ToolCatalogBrowser />
      </Suspense>
      <SiteFooter />
    </main>
  );
}
