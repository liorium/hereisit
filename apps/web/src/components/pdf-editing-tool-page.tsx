import type { PdfEditingIntent, PdfToolConfig } from "../lib/site";
import { PdfToolPage } from "./pdf-tool-page";
import { PdfWorkbench } from "./pdf-workbench";

type PdfEditingToolConfig = PdfToolConfig & {
  intent: PdfEditingIntent;
  intentClass: "editing";
};

export function PdfEditingToolPage({ tool }: { tool: PdfEditingToolConfig }) {
  return (
    <PdfToolPage tool={tool} workbench={<PdfWorkbench key={tool.intent} intent={tool.intent} />} />
  );
}
