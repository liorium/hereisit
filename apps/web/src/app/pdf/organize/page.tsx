import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const toolId = "pdf.organize" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools.organize;

export const metadata = createToolMetadata(catalogTool);

export default function OrganizePdfPage() {
  return <PdfEditingToolPage tool={tool} toolId={toolId} />;
}
