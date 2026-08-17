import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import localKnowledgeTools from "./local/index.js";
import honchoMemory from "./remote/index.js";

export default function piHoncho(pi: ExtensionAPI): void {
	honchoMemory(pi);
	localKnowledgeTools(pi);
}
