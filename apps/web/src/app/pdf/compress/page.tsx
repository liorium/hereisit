import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfCompressWorkbench } from "../../../components/pdf-compress-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "pdf.compress-scanned" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function PdfCompressPage() {
  return <ToolDetailPage toolId={toolId} workbench={<PdfCompressWorkbench toolId={toolId} />} />;
}
