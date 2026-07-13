import { PdfCompressWorkbench } from "../../../components/pdf-compress-workbench";
import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools.compress;

export const metadata = createToolMetadata(tool);

export default function PdfCompressPage() {
  return <PdfToolPage tool={tool} workbench={<PdfCompressWorkbench />} />;
}
