import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("pdf.split");
const tool = pdfTools.split;

export const metadata = createToolMetadata(catalogTool);

export default function SplitPdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
