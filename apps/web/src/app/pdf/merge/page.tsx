import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools.merge;

export const metadata = createToolMetadata(tool);

export default function MergePdfPage() {
  return <PdfToolPage tool={tool} />;
}
