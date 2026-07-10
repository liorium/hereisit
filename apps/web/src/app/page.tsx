import { ImageWorkbench } from "../components/image-workbench";

const features = [
  {
    number: "01",
    title: "업로드를 기다리지 않아요",
    body: "이미지는 브라우저 안에서 처리됩니다. 작은 작업은 서버 왕복 없이 바로 시작해요.",
  },
  {
    number: "02",
    title: "한 번만 열고 끝내요",
    body: "크기 조절, 자르기, 형식 변환, 압축을 하나의 작업으로 묶어 다시 인코딩하지 않아요.",
  },
  {
    number: "03",
    title: "원본은 그대로 남아요",
    body: "작업 결과는 새 파일로 만들어지고, 위치·촬영 정보 같은 메타데이터는 포함하지 않아요.",
  },
];

export default function HomePage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="HereItIs 홈">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span>HereItIs</span>
        </a>
        <div className="privacy-pill">
          <span className="privacy-dot" aria-hidden="true" />내 기기에서만 처리
        </div>
      </header>

      <section id="top" className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">FAST · PRIVATE · LOCAL</p>
          <h1>
            이미지 작업,
            <br />
            <span>여기서 끝.</span>
          </h1>
          <p className="hero-description">
            압축·크기 조절·형식 변환을 한 번에.
            <br className="desktop-break" /> 파일은 기기 밖으로 나가지 않아요.
          </p>
        </div>
        <aside className="hero-note" aria-label="제품 원칙">
          <span className="hero-note-index">01</span>
          <p>빠른 도구는 설명보다 먼저 반응해야 하니까.</p>
          <div className="hero-note-line" />
        </aside>
      </section>

      <ImageWorkbench />

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

      <footer className="site-footer">
        <div>
          <strong>HereItIs</strong>
          <p>필요한 작업, 여기 있어요.</p>
        </div>
        <p>브라우저를 닫으면 작업 파일도 함께 사라집니다.</p>
      </footer>
    </main>
  );
}
