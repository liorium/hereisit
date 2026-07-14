import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import type { PdfToolConfig } from "../lib/site";
import { isPdfEditingIntent, type PdfEditingIntent } from "../lib/tool-implementations";
import { PdfToolPage } from "./pdf-tool-page";
import { PdfWorkbench } from "./pdf-workbench";

type PdfEditingToolConfig = PdfToolConfig & {
  intent: PdfEditingIntent;
  intentClass: "editing";
};

export function PdfEditingToolPage({
  tool,
  toolId,
}: {
  tool: PdfEditingToolConfig;
  toolId: AvailableToolId;
}) {
  if (!isPdfEditingIntent(tool.intent)) {
    throw new Error(`PdfEditingToolPage requires an editing intent: ${tool.intent}`);
  }
  return (
    <PdfToolPage
      tool={tool}
      toolId={toolId}
      workbench={<PdfWorkbench key={tool.intent} intent={tool.intent} toolId={toolId} />}
    />
  );
}
