const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (offset + signature.length > bytes.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function hasPdfSignature(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  const lastOffset = bytes.length - PDF_SIGNATURE.length;
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    if (hasSignature(bytes, PDF_SIGNATURE, offset)) return true;
  }
  return false;
}

export type PdfImageKind = "jpeg" | "png";

export function detectPdfImageKind(buffer: ArrayBuffer): PdfImageKind | undefined {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, PNG_SIGNATURE.length));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (hasSignature(bytes, PNG_SIGNATURE)) return "png";
  return undefined;
}
