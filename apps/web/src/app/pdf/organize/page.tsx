import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfOrganizeWorkbench } from "../../../components/pdf-organize-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "pdf.organize" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function OrganizePdfPage() {
  return <ToolDetailPage toolId={toolId} workbench={<PdfOrganizeWorkbench toolId={toolId} />} />;
}
