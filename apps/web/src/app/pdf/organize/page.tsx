import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("pdf.organize");
const tool = pdfTools.organize;

export const metadata = createToolMetadata(catalogTool);

export default function OrganizePdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
