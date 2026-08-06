import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <strong>HereIsIt</strong>
        <p>필요한 작업, 여기 있어요.</p>
      </div>
      <div className="site-footer-meta">
        <p>각 도구에서 파일 처리 위치와 보관 방식을 작업 전에 확인할 수 있습니다.</p>
        <Link href="/privacy" prefetch={false}>
          개인정보 보호
        </Link>
      </div>
    </footer>
  );
}
