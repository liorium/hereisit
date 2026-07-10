import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  transpilePackages: [
    "@hereisit/browser-runtime",
    "@hereisit/image-tool",
    "@hereisit/tool-contracts",
    "@hereisit/tool-registry",
  ],
  poweredByHeader: false,
};

export default nextConfig;
