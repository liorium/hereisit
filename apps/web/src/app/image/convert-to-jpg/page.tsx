import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageExtraWorkbench } from "../../../components/image-extra-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "image.convert-to-jpg" satisfies AvailableToolId;
export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function ConvertToJpgPage() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<ImageExtraWorkbench intent="convert-to-jpg" toolId={toolId} />}
    />
  );
}
