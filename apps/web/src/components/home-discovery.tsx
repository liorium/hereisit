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
          <p className="eyebrow">HEREISIT / 01</p>
          <h1 id="home-title">
            파일 작업, <span className={styles.closingPhrase}>여기서 끝.</span>
          </h1>
          <p>파일을 고르면 맞는 도구를 바로 찾아드려요. 처리 방식은 실행 전에 알려드립니다.</p>
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
