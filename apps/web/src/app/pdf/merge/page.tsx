import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const toolId = "pdf.merge" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools.merge;

export const metadata = createToolMetadata(catalogTool);

export default function MergePdfPage() {
  return <PdfEditingToolPage tool={tool} toolId={toolId} />;
}
