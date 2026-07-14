import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWatermarkWorkbench } from "../../../components/image-watermark-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const toolId = "image.watermark" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = imageTools.watermark;

export const metadata = createToolMetadata(catalogTool);

export default function WatermarkImagePage() {
  return (
    <ImageToolPage
      tool={tool}
      toolId={toolId}
      imageWatermarkWorkbench={<ImageWatermarkWorkbench toolId={toolId} />}
    />
  );
}
