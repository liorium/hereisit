"use client";

import type { DiscoveryDomainId } from "@hereisit/tool-registry/catalog";
import { type ReactNode, useState } from "react";
import { useToolPreferences } from "../lib/use-tool-preferences";
import { CatalogSearch } from "./catalog-search";
import { DomainToolTabs } from "./domain-tool-tabs";
import styles from "./home-discovery.module.css";
import { HomeFileLauncher } from "./home-file-launcher";

export function HomeDiscovery(): ReactNode {
  const [selectedDomain, setSelectedDomain] = useState<DiscoveryDomainId>("all");
  const { recent } = useToolPreferences();

  return (
    <>
      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.heroCopy}>
          <p className="eyebrow">FAST · PRIVATE · LOCAL</p>
          <h1 id="home-title">
            파일 작업, <span className={styles.closingPhrase}>여기서 끝.</span>
          </h1>
          <p>
            파일 확인과 대부분의 작업은 기기에서 처리해요. 서버가 필요한 작업은 먼저 알리고 선택을
            받아요.
          </p>
        </div>
        <div className={styles.search}>
          <CatalogSearch idPrefix="home-hero" variant="hero" />
        </div>
      </section>

      <HomeFileLauncher />

      <DomainToolTabs
        onSelect={setSelectedDomain}
        recentToolIds={recent}
        selected={selectedDomain}
      />
    </>
  );
}
