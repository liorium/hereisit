import type { Metadata } from "next";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "개인정보 보호",
  description: "HereIsIt의 파일 처리와 익명 통계 수집 방식을 확인하세요.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader activePath="/privacy" />
      <main className={styles.page}>
        <article>
          <p className={styles.eyebrow}>PRIVACY</p>
          <h1>개인정보 보호</h1>
          <p className={styles.lead}>파일 처리 위치와 삭제 방식은 도구 실행 전에 안내합니다.</p>

          <section>
            <h2>파일 처리</h2>
            <p>
              서버 처리가 필요한 도구는 실행 전에 업로드 사실을 명확히 알립니다. 그 밖의 도구는
              파일을 서버로 전송하지 않습니다.
            </p>
            <p>
              PDF 압축은 기본적으로 고성능 처리 서버에서 실행되며, 원하면 내 기기 처리를 선택할 수
              있습니다. 서버 결과는 브라우저에서 다시 확인한 뒤 다운로드할 수 있고, 서버의 입력과
              결과는 완료 후 자동으로 삭제됩니다.
            </p>
          </section>

          <section>
            <h2>수집하는 정보</h2>
            <p>
              Cloudflare를 통해 집계형 페이지 방문·성능 통계와 도구 처리 시작, 성공, 실패, 다운로드
              요청 이벤트를 수집합니다. 도구 ID, 이벤트, 대략적인 처리 시간 구간, 실패 분류, 실행
              환경, 배포 버전만 포함합니다.
            </p>
          </section>

          <section>
            <h2>수집하지 않는 정보</h2>
            <p>
              파일 내용·이름·형식·크기와 사용자 또는 네트워크 식별자는 수집하지 않습니다. 분석을
              위한 쿠키, 로컬 저장소, 세션 저장소도 사용하지 않습니다.
            </p>
          </section>

          <section>
            <h2>보관과 한계</h2>
            <p>
              도구 이벤트는 3개월, Web Analytics 통계는 6개월 동안 확인할 수 있습니다. 차단 도구나
              네트워크 상태로 일부 기록이 빠질 수 있습니다. 다운로드 기록은 요청을 뜻하며 기기에
              저장됐음을 확인하는 정보가 아닙니다.
            </p>
          </section>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
