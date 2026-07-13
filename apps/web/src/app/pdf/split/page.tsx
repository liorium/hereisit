import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools.split;

export const metadata = createToolMetadata(tool);

export default function SplitPdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
