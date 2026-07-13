import { PdfEditingToolPage } from "../../../components/pdf-editing-tool-page";
import { createToolMetadata } from "../../../lib/metadata";
import { pdfTools } from "../../../lib/site";

const tool = pdfTools["image-to-pdf"];

export const metadata = createToolMetadata(tool);

export default function ImageToPdfPage() {
  return <PdfEditingToolPage tool={tool} />;
}
