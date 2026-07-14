import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWatermarkWorkbench } from "../../../components/image-watermark-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("image.watermark");
const tool = imageTools.watermark;

export const metadata = createToolMetadata(catalogTool);

export default function WatermarkImagePage() {
  return <ImageToolPage tool={tool} imageWatermarkWorkbench={<ImageWatermarkWorkbench />} />;
}
