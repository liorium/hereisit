import { imageToolList } from "../lib/site";

export function SiteHeader({ activePath }: { activePath?: string }) {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="HereItIs 홈">
        <span className="brand-mark" aria-hidden="true">
          H
        </span>
        <span>HereItIs</span>
      </a>
      <div className="site-header-actions">
        <nav className="site-nav" aria-label="이미지 도구">
          {imageToolList.map((tool) => (
            <a
              className="site-nav-link"
              href={tool.path}
              aria-label={tool.title}
              aria-current={activePath === tool.path ? "page" : undefined}
              key={tool.path}
            >
              {tool.navLabel}
            </a>
          ))}
        </nav>
        <div className="privacy-pill">
          <span className="privacy-dot" aria-hidden="true" />내 기기에서만 처리
        </div>
      </div>
    </header>
  );
}
