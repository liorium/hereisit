import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfToImageWorkbench } from "../../../components/pdf-to-image-workbench";
import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("pdf.to-image");
const tool = pdfTools["to-image"];

export const metadata = createToolMetadata(catalogTool);

export default function PdfToImagePage() {
  return <PdfToolPage tool={tool} workbench={<PdfToImageWorkbench />} />;
}
