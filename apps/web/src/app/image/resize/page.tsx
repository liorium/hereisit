import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWorkbench } from "../../../components/image-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const toolId = "image.resize" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = imageTools.resize;

export const metadata = createToolMetadata(catalogTool);

export default function ResizeImagePage() {
  return (
    <ImageToolPage
      tool={tool}
      toolId={toolId}
      imageWorkbench={<ImageWorkbench intent={tool.intent} toolId={toolId} />}
    />
  );
}
