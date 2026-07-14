import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfCompressWorkbench } from "../../../components/pdf-compress-workbench";
import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("pdf.compress-scanned");
const tool = pdfTools.compress;

export const metadata = createToolMetadata(catalogTool);

export default function PdfCompressPage() {
  return <PdfToolPage tool={tool} workbench={<PdfCompressWorkbench />} />;
}
