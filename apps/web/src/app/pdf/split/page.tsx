import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const toolId = "pdf.split" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools.split;

export const metadata = createToolMetadata(catalogTool);

export default function SplitPdfPage() {
  return <PdfEditingToolPage tool={tool} toolId={toolId} />;
}
