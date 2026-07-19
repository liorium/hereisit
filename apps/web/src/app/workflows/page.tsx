import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

export const metadata: Metadata = {
  title: "워크플로",
  robots: { index: false, follow: true },
  alternates: { canonical: "/workflows" },
};

const workflowExamples = [
  {
    title: "웹용 이미지 준비",
    description: "크기를 맞춘 뒤 용량을 줄이고 필요한 형식으로 바꾸는 순서를 준비하고 있어요.",
    tools: [
      ["이미지 크기 조절", "/image/resize"],
      ["이미지 용량 줄이기", "/image/compress"],
      ["이미지 형식 변환", "/image/convert"],
    ],
  },
  {
    title: "PDF 묶음 정리",
    description: "PDF를 합치고 페이지를 정리한 뒤 표시를 더하는 순서를 준비하고 있어요.",
    tools: [
      ["PDF 합치기", "/pdf/merge"],
      ["PDF 페이지 정리", "/pdf/organize"],
      ["PDF 워터마크 넣기", "/pdf/watermark"],
    ],
  },
  {
    title: "문서와 이미지 오가기",
    description: "PDF 페이지를 이미지로 꺼내 편집한 뒤 다시 PDF로 묶는 순서를 준비하고 있어요.",
    tools: [
      ["PDF를 JPG·PNG로 변환", "/pdf/to-image"],
      ["이미지에 워터마크 넣기", "/image/watermark"],
      ["이미지를 PDF로 변환", "/pdf/image-to-pdf"],
    ],
  },
] as const;

export default function WorkflowsPage() {
  return (
    <main>
      <SiteHeader activePath="/workflows" />
      <section aria-labelledby="workflows-title">
        <section className="tool-hero">
          <p className="eyebrow">PREPARATION ONLY</p>
          <div className="tool-hero-copy">
            <h1 id="workflows-title">워크플로</h1>
            <p>
              현재는 각 단계에서 파일을 직접 내려받고 다음 도구에서 다시 선택해야 해요. 이 페이지는
              준비할 작업 순서와 사용할 수 있는 개별 도구만 안내합니다.
            </p>
            <p className="tool-summary">
              이 명시적인 로컬 연결을 더 안전하고 편리하게 만드는 기능을 앞으로 제공할 예정입니다.
              지금은 어떤 연결 작업도 시작하지 않아요.
            </p>
          </div>
        </section>

        <section aria-labelledby="workflow-examples-title" className="principles-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">FUTURE RECIPES</p>
              <h2 id="workflow-examples-title">준비 중인 작업 순서</h2>
            </div>
          </div>
          <div className="feature-grid">
            {workflowExamples.map((example, index) => (
              <article className="feature-card" data-testid="workflow-example" key={example.title}>
                <span className="feature-number">
                  <span>준비 중</span>
                  <span aria-hidden="true"> · {String(index + 1).padStart(2, "0")}</span>
                </span>
                <h3>{example.title}</h3>
                <p>{example.description}</p>
                <nav aria-label={`${example.title}에서 사용할 수 있는 도구`} className="site-nav">
                  {example.tools.map(([label, href]) => (
                    <Link className="site-nav-link" href={href} key={href} prefetch={false}>
                      {label}
                    </Link>
                  ))}
                </nav>
              </article>
            ))}
          </div>
        </section>
      </section>
      <SiteFooter />
    </main>
  );
}
