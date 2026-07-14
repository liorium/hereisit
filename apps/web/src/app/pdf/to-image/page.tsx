import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfToImageWorkbench } from "../../../components/pdf-to-image-workbench";
import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const toolId = "pdf.to-image" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools["to-image"];

export const metadata = createToolMetadata(catalogTool);

export default function PdfToImagePage() {
  return (
    <PdfToolPage tool={tool} toolId={toolId} workbench={<PdfToImageWorkbench toolId={toolId} />} />
  );
}
