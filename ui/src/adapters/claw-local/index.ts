import type { UIAdapterModule } from "../types";
import { parseClawStdoutLine } from "@paperclipai/adapter-claw-local/ui";
import { ClawLocalConfigFields } from "./config-fields";
import { buildClawLocalConfig } from "@paperclipai/adapter-claw-local/ui";

export const clawLocalUIAdapter: UIAdapterModule = {
  type: "claw_local",
  label: "Claw Code (local)",
  parseStdoutLine: parseClawStdoutLine,
  ConfigFields: ClawLocalConfigFields,
  buildAdapterConfig: buildClawLocalConfig,
};
