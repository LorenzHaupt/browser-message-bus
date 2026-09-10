import { InvalidConfigurationError } from "../core/errors.js";
import type {
  BusConnector,
  BusEnvelope,
  BusTransport,
  ConnectorContext,
  ConnectorResult
} from "../core/types.js";
import type { IframeBridgeOptions } from "./types.js";
import { windowBridge } from "./window-bridge.js";

/**
 * Komfort-Connector für Host → iframe. Intern verwendet er dieselbe Window-Bridge und startet im connect-Modus.
 * Zusätzlich beobachtet er das iframe-Element selbst, damit ein Entfernen aus dem DOM die Connection zuverlässig beendet.
 */
export function iframeBridge(options: IframeBridgeOptions): BusConnector {
  const targetWindow = options.iframe.contentWindow;
  if (!targetWindow) {
    throw new InvalidConfigurationError("The iframe does not have a contentWindow yet.");
  }

  const delegate = windowBridge({
    targetWindow,
    mode: "connect",
    origin: options.origin,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.allowedTopics ? { allowedTopics: options.allowedTopics } : {}),
    ...(options.allowedExtensions ? { allowedExtensions: options.allowedExtensions } : {}),
    ...(options.localWindow ? { localWindow: options.localWindow } : {})
  });

  return new IframeBridgeConnector(options.iframe, delegate);
}

/**
 * Ergänzt die generische Window-Bridge nur um den Lifecycle des konkreten iframe-Elements.
 * Messaging und Handshake bleiben vollständig Aufgabe der Window-Bridge.
 */
class IframeBridgeConnector implements BusConnector {
  readonly kind: string;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly delegate: BusConnector
  ) {
    this.kind = delegate.kind;
  }

  async connect(context: ConnectorContext): Promise<ConnectorResult> {
    const result = await this.delegate.connect(context);

    return {
      remote: result.remote,
      transport: new IframeLifecycleTransport(this.iframe, result.transport)
    };
  }
}

/**
 * Dünner Decorator um einen bestehenden Transport. Er verändert keine Nachrichten,
 * sondern beendet die Connection, sobald das zugehörige iframe aus dem Dokument entfernt wurde.
 */
class IframeLifecycleTransport implements BusTransport {
  readonly id: string;
  readonly kind: string;

  private observer: MutationObserver | undefined;
  private notifyDetached: (() => void) | undefined;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly delegate: BusTransport
  ) {
    this.id = delegate.id;
    this.kind = delegate.kind;
  }

  start(
    receive: (envelope: BusEnvelope) => void,
    remoteClose: () => void
  ): void | Promise<void> {
    const onRemoteClose = (): void => {
      this.stopObserving();
      remoteClose();
    };

    this.notifyDetached = onRemoteClose;
    const startResult = this.delegate.start(receive, onRemoteClose);

    if (startResult instanceof Promise) {
      return startResult.then(
        () => this.startObserving(),
        error => {
          this.stopObserving();
          throw error;
        }
      );
    }

    this.startObserving();
  }

  send(envelope: BusEnvelope): void {
    this.delegate.send(envelope);
  }

  close(notifyRemote = true): void | Promise<void> {
    this.stopObserving();
    return this.delegate.close(notifyRemote);
  }

  private startObserving(): void {
    const ownerWindow = this.iframe.ownerDocument.defaultView;
    const MutationObserverCtor = ownerWindow?.MutationObserver;
    const root = this.iframe.ownerDocument.documentElement;

    if (!MutationObserverCtor || !root) {
      return;
    }

    this.observer = new MutationObserverCtor(() => {
      if (!this.iframe.isConnected) {
        this.notifyDetached?.();
      }
    });

    this.observer.observe(root, {
      childList: true,
      subtree: true
    });

    // Das iframe kann zwischen Handshake und Transport-Start bereits entfernt worden sein.
    if (!this.iframe.isConnected) {
      this.notifyDetached?.();
    }
  }

  private stopObserving(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.notifyDetached = undefined;
  }
}
