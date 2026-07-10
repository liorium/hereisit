import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV !== "production";
const scriptPolicy = isDevelopment
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const connectPolicy = isDevelopment ? "connect-src 'self' ws: wss:" : "connect-src 'self'";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  scriptPolicy,
  connectPolicy,
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@hereisit/browser-runtime",
    "@hereisit/image-tool",
    "@hereisit/tool-contracts",
    "@hereisit/tool-registry",
  ],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
