import { ImageToolPage } from "../../../components/image-tool-page";
import { createImageToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const tool = imageTools.resize;

export const metadata = createImageToolMetadata(tool);

export default function ResizeImagePage() {
  return <ImageToolPage tool={tool} />;
}
