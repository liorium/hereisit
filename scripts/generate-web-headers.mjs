import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repositoryRoot, "apps/web/public/_headers");

function normalizeOrigin(value, allowLocal) {
  if (value === null || value === undefined || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("processing API origin is invalid");
  }
  const localHttp =
    allowLocal &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("processing API origin is invalid");
  }
  return url.origin;
}

export function generateHeaders({ processingApiOrigin, allowLocalProcessingOrigins = false }) {
  const origin = normalizeOrigin(processingApiOrigin, allowLocalProcessingOrigins);
  const connectSource = origin === null ? "'self'" : `'self' ${origin}`;
  return `/*
  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; script-src 'self' 'unsafe-inline'; connect-src ${connectSource}; manifest-src 'self'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable

/pdfjs/6.1.200/*
  Cache-Control: public, max-age=31536000, immutable
`;
}

export async function writeGeneratedHeaders(environment = process.env) {
  const contents = generateHeaders({
    processingApiOrigin: environment.NEXT_PUBLIC_PROCESSING_API_ORIGIN ?? null,
    allowLocalProcessingOrigins: environment.ALLOW_LOCAL_PROCESSING_ORIGINS === "1",
  });
  await writeFile(outputPath, contents, "utf8");
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await writeGeneratedHeaders();
}
