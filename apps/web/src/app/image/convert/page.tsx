import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageWorkbench } from "../../../components/image-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";
import { getToolImplementation } from "../../../lib/tool-implementations";

const toolId = "image.convert" satisfies AvailableToolId;
const implementation = getToolImplementation(toolId);

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function ConvertImagePage() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<ImageWorkbench intent={implementation.intent} toolId={toolId} />}
    />
  );
}
