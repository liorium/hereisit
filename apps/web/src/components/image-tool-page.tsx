import type { ReactNode } from "react";
import { type ImageToolConfig, type ImageToolIntent, relatedImageTools } from "../lib/site";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

type ImageToolConfigFor<Intent extends ImageToolIntent> = Omit<
  ImageToolConfig,
  "intent" | "path"
> & {
  intent: Intent;
  path: `/image/${Intent}`;
};

type ImageToolPageProps =
  | {
      tool: ImageToolConfigFor<"watermark">;
      imageWorkbench?: never;
      imageWatermarkWorkbench: ReactNode;
    }
  | {
      tool: ImageToolConfigFor<Exclude<ImageToolIntent, "watermark">>;
      imageWorkbench: ReactNode;
      imageWatermarkWorkbench?: never;
    };

export function ImageToolPage(props: ImageToolPageProps) {
  const { tool } = props;
  const relatedTools = relatedImageTools(tool.intent);
  const workbench =
    tool.intent === "watermark" ? props.imageWatermarkWorkbench : props.imageWorkbench;

  return (
    <main>
      <SiteHeader activePath={tool.path} />

      <section className="tool-hero" aria-labelledby="tool-title">
        <p className="eyebrow">{tool.eyebrow}</p>
        <div className="tool-hero-copy">
          <h1 id="tool-title">{tool.title}</h1>
          <p>{tool.description}</p>
          <p className="tool-summary">{tool.defaultSummary}</p>
          {tool.heicNote ? <p className="tool-note">{tool.heicNote}</p> : null}
        </div>
      </section>

      {workbench}

      <section className="principles-section tool-steps" aria-labelledby="steps-title">
        <div className="section-heading">
          <p className="eyebrow">3 STEPS</p>
          <h2 id="steps-title">선택하고, 처리하고, 저장하세요.</h2>
        </div>
        <div className="feature-grid">
          {tool.steps.map((step, index) => (
            <article className="feature-card" key={step.title}>
              <span className="feature-number">{String(index + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="related-tools-section" aria-labelledby="related-tools-title">
        <div className="section-heading">
          <p className="eyebrow">RELATED TOOLS</p>
          <h2 id="related-tools-title">다른 이미지 작업도 바로 이어서.</h2>
        </div>
        <div className="related-tools-grid">
          {relatedTools.map((related) => (
            <a className="related-tool-card" href={related.path} key={related.path}>
              <span>{related.navLabel}</span>
              <strong>{related.title}</strong>
              <p>{related.defaultSummary}</p>
            </a>
          ))}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
