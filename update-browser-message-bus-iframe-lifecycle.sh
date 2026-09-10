#!/usr/bin/env bash
set -euo pipefail

VERIFY=false
case "${1:-}" in
  "") ;;
  --verify) VERIFY=true ;;
  -h|--help)
    cat <<'HELP'
Korrigiert den iframe-Lifecycle des Browser Message Bus.

Änderung:
  - iframeBridge erkennt deterministisch, wenn das verbundene iframe aus dem DOM entfernt wird.
  - connection.closed wird dadurch auf der Host-Seite zuverlässig erfüllt.
  - Kein Heartbeat, kein Polling und kein automatisches Reconnect.
  - Messaging- und Handshake-Logik bleiben unverändert.

Aufruf im Projektwurzelverzeichnis:
  bash update-browser-message-bus-iframe-lifecycle.sh
  bash update-browser-message-bus-iframe-lifecycle.sh --verify

--verify führt anschließend Typecheck, Vitest, Build und Browser-E2E aus.
HELP
    exit 0
    ;;
  *)
    echo "Unbekannte Option: $1" >&2
    echo "Nutze --help für Hilfe." >&2
    exit 2
    ;;
esac

if [[ ! -f package.json || ! -f src/bridge/iframe-bridge.ts || ! -f src/bridge/window-bridge.ts ]]; then
  echo "Fehler: Das Skript muss im Root des browser-message-bus-Projekts ausgeführt werden." >&2
  exit 1
fi

if ! grep -q '"@lorenz/browser-message-bus"' package.json; then
  echo "Fehler: package.json sieht nicht wie das erwartete Browser-Message-Bus-Projekt aus." >&2
  exit 1
fi

echo "Korrigiere iframe-Lifecycle ..."

cat > src/bridge/iframe-bridge.ts <<'EOF'
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
EOF

# Die Dokumentation wird nur punktuell präzisiert. Fehlt eine der Dateien, bleibt der Code-Patch trotzdem nutzbar.
node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function updateFile(path, updater) {
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = updater(before);
  if (after !== before) writeFileSync(path, after);
}

updateFile("README.md", text => {
  const anchor = "`window.postMessage()` wird nur für den Handshake verwendet. Danach läuft der normale Nachrichtenaustausch über einen dedizierten `MessagePort`.";
  const addition = "\n\nBei `iframeBridge()` beobachtet der Host zusätzlich das konkrete iframe-Element. Wird es aus dem DOM entfernt, wird die zugehörige Connection beendet und `connection.closed` zuverlässig erfüllt. Dafür ist weder Polling noch ein Heartbeat nötig. Unerwartete Browser- oder Prozessabbrüche außerhalb dieses kontrollierbaren iframe-Lifecycles bleiben wie bei Browser-Messaging generell Best-Effort.";
  if (text.includes("Bei `iframeBridge()` beobachtet der Host zusätzlich")) return text;
  return text.includes(anchor) ? text.replace(anchor, anchor + addition) : text;
});

updateFile("ARCHITEKTUR.md", text => {
  const oldText = "Eine `BusConnection` stellt neben `connected` ein `closed`-Promise bereit. Es wird erfüllt, wenn die Verbindung lokal geschlossen wird oder der entfernte `MessagePort` entkoppelt wird. Dadurch kann eine Anwendung beispielsweise auf das Schließen oder Navigieren eines Viewer-Fensters reagieren.";
  const newText = "Eine `BusConnection` stellt neben `connected` ein `closed`-Promise bereit. Es wird erfüllt, wenn die Verbindung lokal oder von der Gegenseite geschlossen wird. `iframeBridge()` beobachtet zusätzlich das konkrete iframe-Element: Wird es aus dem DOM entfernt, beendet der Host die Connection deterministisch. Native `MessagePort`-Close-Signale bleiben eine zusätzliche Best-Effort-Erkennung für andere Abbruchfälle.";
  if (text.includes(newText)) return text;
  return text.includes(oldText) ? text.replace(oldText, newText) : text;
});
NODE

echo "Korrektur abgeschlossen. Geändert wurde die iframe-Lifecycle-Behandlung; die öffentliche API bleibt unverändert."

if [[ "$VERIFY" == true ]]; then
  if [[ ! -d node_modules ]]; then
    echo "Fehler: node_modules fehlt. Bitte zuerst npm install bzw. npm ci ausführen." >&2
    exit 1
  fi

  npm run typecheck
  npm test
  npm run build
  npm run test:e2e
  echo "Typecheck, Vitest, Build und Browser-E2E erfolgreich."
else
  cat <<'NEXT'

Empfohlene Prüfung:
  npm run typecheck
  npm test
  npm run build
  npm run test:e2e

Der zuvor fehlschlagende Cross-Origin-E2E-Test sollte jetzt beim Entfernen des iframes ohne Timeout abschließen.
NEXT
fi
