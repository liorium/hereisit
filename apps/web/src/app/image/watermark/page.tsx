import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWatermarkWorkbench } from "../../../components/image-watermark-workbench";
import { createImageToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const tool = imageTools.watermark;

export const metadata = createImageToolMetadata(tool);

export default function WatermarkImagePage() {
  return <ImageToolPage tool={tool} imageWatermarkWorkbench={<ImageWatermarkWorkbench />} />;
}
