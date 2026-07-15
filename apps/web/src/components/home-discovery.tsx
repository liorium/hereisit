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
          <p>파일은 기기 밖으로 나가지 않아요. 파일로 시작하거나 필요한 도구를 검색하세요.</p>
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
