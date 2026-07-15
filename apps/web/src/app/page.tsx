import { HomeDiscovery } from "../components/home-discovery";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";

export default function HomePage() {
  return (
    <main>
      <SiteHeader />
      <HomeDiscovery />
      <SiteFooter />
    </main>
  );
}
