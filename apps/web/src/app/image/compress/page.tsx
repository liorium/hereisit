import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageCompressWorkbench } from "../../../components/image-compress-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "image.compress" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function CompressImagePage() {
  return <ToolDetailPage toolId={toolId} workbench={<ImageCompressWorkbench toolId={toolId} />} />;
}
