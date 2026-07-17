import { ImageWorkbench } from "../components/image-workbench";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { imageToolList, pdfToolList } from "../lib/site";

const features = [
  {
    number: "01",
    title: "처리 방식을 먼저 알려드려요",
    body: "도구마다 기기 내 처리와 서버 처리 여부, 파일 보관 방식을 시작 전에 보여드려요.",
  },
  {
    number: "02",
    title: "한 번만 열고 끝내요",
    body: "작업별 전용 화면에서 필요한 설정만 고르고 결과를 바로 확인해요.",
  },
  {
    number: "03",
    title: "원본은 그대로 남아요",
    body: "작업 결과는 새 파일로 만들어지고, 선택한 원본 파일은 바뀌지 않아요.",
  },
];

export default function HomePage() {
  return (
    <main>
      <SiteHeader />

      <section id="top" className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">FAST · PRIVATE · CLEAR</p>
          <h1>
            파일 작업,
            <br />
            <span>여기서 끝.</span>
          </h1>
          <p className="hero-description">
            이미지와 PDF, 필요한 작업을 빠르게.
            <br className="desktop-break" /> 도구별 처리 방식을 먼저 확인하세요.
          </p>
        </div>
        <aside className="hero-note" aria-label="제품 원칙">
          <span className="hero-note-index">01</span>
          <p>빠른 도구는 설명보다 먼저 반응해야 하니까.</p>
          <div className="hero-note-line" />
        </aside>
      </section>

      <ImageWorkbench />

      <section className="home-tools-section" aria-labelledby="home-tools-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">IMAGE TOOLS</p>
            <h2 id="home-tools-title">필요한 작업으로 바로 가세요.</h2>
          </div>
        </div>
        <div className="home-tools-grid">
          {imageToolList.map((tool, index) => (
            <a className="home-tool-card" href={tool.path} key={tool.path}>
              <span className="feature-number">{String(index + 1).padStart(2, "0")}</span>
              <strong>{tool.title}</strong>
              <p>{tool.description}</p>
              <em aria-hidden="true">바로 시작 →</em>
            </a>
          ))}
        </div>
      </section>

      <section
        id="pdf-tools"
        className="home-tools-section home-tools-section-secondary"
        aria-labelledby="pdf-tools-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">PDF TOOLS</p>
            <h2 id="pdf-tools-title">PDF 작업도 기기 안에서.</h2>
          </div>
        </div>
        <div className="home-tools-grid">
          {pdfToolList.map((tool, index) => (
            <a className="home-tool-card" href={tool.path} key={tool.path}>
              <span className="feature-number">{String(index + 1).padStart(2, "0")}</span>
              <strong>{tool.title}</strong>
              <p>{tool.description}</p>
              <em aria-hidden="true">바로 시작 →</em>
            </a>
          ))}
        </div>
      </section>

      <section className="principles-section" aria-labelledby="principles-title">
        <div className="section-heading">
          <p className="eyebrow">HOW IT WORKS</p>
          <h2 id="principles-title">빠른 데는 이유가 있어요.</h2>
        </div>
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <span className="feature-number">{feature.number}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
