/** Optionale Allowlist für den Datenverkehr über genau diese Bridge. */
export interface BridgeTopicPolicy {
  /** Public application topics allowed across this bridge. */
  readonly allowedTopics?: readonly string[];

  /** Extension ids whose internal messages may cross this bridge. */
  readonly allowedExtensions?: readonly string[];
}

export interface WindowBridgeBaseOptions extends BridgeTopicPolicy {
  readonly origin: string;
  readonly timeoutMs?: number;
}

export interface WindowBridgeOptions extends WindowBridgeBaseOptions {
  readonly targetWindow: Window;
  readonly mode: "connect" | "accept";
  readonly localWindow?: Window;
}

export interface IframeBridgeOptions extends WindowBridgeBaseOptions {
  readonly iframe: HTMLIFrameElement;
  readonly localWindow?: Window;
}
