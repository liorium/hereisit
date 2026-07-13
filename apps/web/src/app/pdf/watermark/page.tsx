import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools.watermark;

export const metadata = createToolMetadata(tool);

export default function WatermarkPdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
