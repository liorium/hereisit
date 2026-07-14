import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWorkbench } from "../../../components/image-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("image.resize");
const tool = imageTools.resize;

export const metadata = createToolMetadata(catalogTool);

export default function ResizeImagePage() {
  return <ImageToolPage tool={tool} imageWorkbench={<ImageWorkbench intent={tool.intent} />} />;
}
