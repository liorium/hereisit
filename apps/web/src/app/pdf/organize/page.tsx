import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfWorkbench } from "../../../components/pdf-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";
import { getToolImplementation } from "../../../lib/tool-implementations";

const toolId = "pdf.organize" satisfies AvailableToolId;
const implementation = getToolImplementation(toolId);

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function OrganizePdfPage() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<PdfWorkbench intent={implementation.intent} toolId={toolId} />}
    />
  );
}
