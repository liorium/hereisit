import { categoryNavigation } from "../lib/site";

export function SiteHeader({ activePath }: { activePath?: string }) {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="HereIsIt 홈">
        <span className="brand-mark" aria-hidden="true">
          H
        </span>
        <span>HereIsIt</span>
      </a>
      <div className="site-header-actions">
        <nav className="site-nav" aria-label="주요 도구">
          {categoryNavigation.map((category) => (
            <a
              className="site-nav-link"
              href={category.path}
              aria-current={activePath === category.path ? "page" : undefined}
              data-active={activePath?.startsWith(category.prefix) ? "true" : undefined}
              key={category.path}
            >
              {category.label}
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
