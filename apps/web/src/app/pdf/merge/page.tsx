import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools.merge;

export const metadata = createToolMetadata(tool);

export default function MergePdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
