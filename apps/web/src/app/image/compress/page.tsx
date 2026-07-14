import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWorkbench } from "../../../components/image-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const toolId = "image.compress" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = imageTools.compress;

export const metadata = createToolMetadata(catalogTool);

export default function CompressImagePage() {
  return (
    <ImageToolPage
      tool={tool}
      toolId={toolId}
      imageWorkbench={<ImageWorkbench intent={tool.intent} toolId={toolId} />}
    />
  );
}
