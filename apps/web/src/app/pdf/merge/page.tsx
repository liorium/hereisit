import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("pdf.merge");
const tool = pdfTools.merge;

export const metadata = createToolMetadata(catalogTool);

export default function MergePdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
