import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const toolId = "pdf.watermark" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools.watermark;

export const metadata = createToolMetadata(catalogTool);

export default function WatermarkPdfPage() {
  return <PdfEditingToolPage tool={tool} toolId={toolId} />;
}
