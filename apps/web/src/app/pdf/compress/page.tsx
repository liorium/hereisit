import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfCompressWorkbench } from "../../../components/pdf-compress-workbench";
import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const toolId = "pdf.compress-scanned" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = pdfTools.compress;

export const metadata = createToolMetadata(catalogTool);

export default function PdfCompressPage() {
  return (
    <PdfToolPage tool={tool} toolId={toolId} workbench={<PdfCompressWorkbench toolId={toolId} />} />
  );
}
