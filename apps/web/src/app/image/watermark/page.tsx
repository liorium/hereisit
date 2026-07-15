import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageWatermarkWorkbench } from "../../../components/image-watermark-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "image.watermark" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function WatermarkImagePage() {
  return <ToolDetailPage toolId={toolId} workbench={<ImageWatermarkWorkbench toolId={toolId} />} />;
}
