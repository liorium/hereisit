import { ImageToolPage } from "../../../components/image-tool-page";
import { createImageToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const tool = imageTools.convert;

export const metadata = createImageToolMetadata(tool);

export default function ConvertImagePage() {
  return <ImageToolPage tool={tool} />;
}
