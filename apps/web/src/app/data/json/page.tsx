import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { JsonFormatWorkbench } from "../../../components/json-format-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "data.json-format" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function JsonFormatPage() {
  return <ToolDetailPage toolId={toolId} workbench={<JsonFormatWorkbench />} />;
}
