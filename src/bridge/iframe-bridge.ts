import { InvalidConfigurationError } from "../core/errors.js";
import type { BusConnector } from "../core/types.js";
import type { IframeBridgeOptions } from "./types.js";
import { windowBridge } from "./window-bridge.js";

/**
 * Komfort-Connector für Host → iframe. Intern verwendet er dieselbe Window-Bridge und startet im connect-Modus.
 */
export function iframeBridge(options: IframeBridgeOptions): BusConnector {
  const targetWindow = options.iframe.contentWindow;
  if (!targetWindow) {
    throw new InvalidConfigurationError("The iframe does not have a contentWindow yet.");
  }

  return windowBridge({
    targetWindow,
    mode: "connect",
    origin: options.origin,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.allowedTopics ? { allowedTopics: options.allowedTopics } : {}),
    ...(options.allowedExtensions ? { allowedExtensions: options.allowedExtensions } : {}),
    ...(options.localWindow ? { localWindow: options.localWindow } : {})
  });
}
