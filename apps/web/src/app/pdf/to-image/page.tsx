import { PdfToImageWorkbench } from "../../../components/pdf-to-image-workbench";
import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools["to-image"];

export const metadata = createToolMetadata(tool);

export default function PdfToImagePage() {
  return <PdfToolPage tool={tool} workbench={<PdfToImageWorkbench />} />;
}
