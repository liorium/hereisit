import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageExtraWorkbench } from "../../../components/image-extra-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "image.html-to-image" satisfies AvailableToolId;
export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function HtmlToImagePage() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<ImageExtraWorkbench intent="html-to-image" toolId={toolId} />}
    />
  );
}
