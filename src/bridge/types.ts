export interface BridgeTopicPolicy {
  readonly allowedTopics?: readonly string[];
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
