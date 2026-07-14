import { getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWorkbench } from "../../../components/image-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const catalogTool = getAvailableToolById("image.compress");
const tool = imageTools.compress;

export const metadata = createToolMetadata(catalogTool);

export default function CompressImagePage() {
  return <ImageToolPage tool={tool} imageWorkbench={<ImageWorkbench intent={tool.intent} />} />;
}
