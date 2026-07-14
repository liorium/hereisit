import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageToolPage } from "../../../components/image-tool-page";
import { ImageWorkbench } from "../../../components/image-workbench";
import { createToolMetadata } from "../../../lib/metadata";
import { imageTools } from "../../../lib/site";

const toolId = "image.convert" satisfies AvailableToolId;
const catalogTool = getAvailableToolById(toolId);
const tool = imageTools.convert;

export const metadata = createToolMetadata(catalogTool);

export default function ConvertImagePage() {
  return (
    <ImageToolPage
      tool={tool}
      toolId={toolId}
      imageWorkbench={<ImageWorkbench intent={tool.intent} toolId={toolId} />}
    />
  );
}
