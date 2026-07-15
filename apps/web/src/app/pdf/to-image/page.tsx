import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfToImageWorkbench } from "../../../components/pdf-to-image-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "pdf.to-image" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function PdfToImagePage() {
  return <ToolDetailPage toolId={toolId} workbench={<PdfToImageWorkbench toolId={toolId} />} />;
}
