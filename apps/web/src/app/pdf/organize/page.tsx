import { PdfToolPage } from "../../../components/pdf-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools.organize;

export const metadata = createToolMetadata(tool);

export default function OrganizePdfPage() {
  return <PdfToolPage tool={tool} />;
}
