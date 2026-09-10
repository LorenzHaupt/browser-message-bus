# Browser Message Bus

Der Browser Message Bus ist eine kleine, typisierte Bibliothek für die Kommunikation zwischen Browser-Kontexten. Sie deckt den einfachen Fall – Nachrichten zwischen Komponenten oder Tabs – genauso ab wie explizite Verbindungen zu Popups oder Cross-Origin-iframes.

Die Grundidee ist bewusst schlicht: Eine Anwendung erstellt einen Bus für einen `channel`, abonniert Topics und veröffentlicht Nachrichten. Alles Weitere ist optional.

## Wofür ist die Bibliothek gedacht?

Typische Anwendungsfälle sind:

- Kommunikation zwischen mehreren Tabs oder Fenstern derselben Anwendung;
- Austausch zwischen Host-Anwendung und eingebettetem iframe;
- Kommunikation zwischen Microfrontends;
- gezielte Nachrichten an eine bestimmte laufende Instanz;
- Request/Reply zwischen Browser-Anwendungen;
- Erkennung anderer Bus-Teilnehmer über Presence;
- optionales lokales Mitschreiben ausgewählter Nachrichten in IndexedDB.

Der Message Bus ersetzt keine Backend-API, keinen WebSocket zum Server und keinen dauerhaften Message Broker wie Kafka oder RabbitMQ.

## Grundprinzipien

- **Einfacher Standardfall:** Nur `channel` ist erforderlich.
- **BroadcastChannel als Standard:** Tabs und Fenster desselben Origins können ohne weitere Konfiguration miteinander kommunizieren.
- **Framework-unabhängig:** Die Bibliothek hängt weder von Angular noch von React oder einem anderen UI-Framework ab.
- **Typisierte Topics und Payloads:** Eine TypeScript-Message-Map beschreibt, welche Daten zu welchem Topic gehören.
- **Exakte Topics:** Der Core kennt bewusst keine Wildcards und keine Topic-Hierarchie.
- **Explizite Bridges:** Cross-Origin-Kommunikation wird nur eingerichtet, wenn beide Seiten sie bewusst konfigurieren.
- **Optionale Erweiterungen:** Presence, Request/Reply und Persistent Log werden nur installiert, wenn eine Anwendung sie braucht.
- **Best-Effort Delivery:** Der Bus ist eine Browser-Kommunikationsschicht, kein dauerhaftes Queue-System.

## Installation

Wenn das Paket veröffentlicht ist, kann es wie eine normale npm-Bibliothek installiert werden:

```bash
npm install @lorenz/browser-message-bus
```

Für die Entwicklung dieses Repositories:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Die echten Browser-E2E-Tests benötigen zusätzlich Playwright und einen installierten Browser:

```bash
npx playwright install chromium
npm run test:e2e
```

## Schnellstart

```ts
import { createMessageBus } from "@lorenz/browser-message-bus";

interface Messages {
  "document.open": {
    id: string;
    title: string;
  };

  "viewer.close": undefined;
}

const bus = createMessageBus<Messages>({
  channel: "workspace",
  appId: "viewer"
});

const unsubscribe = bus.subscribe("document.open", (payload, context) => {
  console.log(payload.id);
  console.log(context.source.instanceId);
});

bus.publish("document.open", {
  id: "4711",
  title: "Vertrag"
});

unsubscribe();
await bus.close();
```

Jede laufende Bus-Instanz erhält automatisch eine eindeutige `instanceId`. Eine optionale `appId` kann mehrere Instanzen derselben Anwendung kennzeichnen.

## Nachrichten gezielt zustellen

Ohne `target` ist eine Nachricht ein Broadcast:

```ts
bus.publish("viewer.close");
```

Alle Instanzen einer Anwendung lassen sich über `appId` adressieren:

```ts
bus.publish("viewer.close", undefined, {
  target: { appId: "viewer" }
});
```

Eine konkrete laufende Instanz wird über ihre `instanceId` angesprochen:

```ts
bus.publish("viewer.close", undefined, {
  target: { instanceId: viewerInstanceId }
});
```

Eine fremde `instanceId` kann zum Beispiel aus `context.source.instanceId`, aus einem Bridge-Handshake oder über die optionale Presence-Erweiterung bekannt werden.

**Wichtig:** Targeting ist Routing und keine Zugriffskontrolle. Teilnehmer desselben `BroadcastChannel` teilen sich denselben Transport. Der Channel-Name ist kein Geheimnis und keine Security Boundary.

## Presence

Presence ist optional und zeigt, welche anderen Bus-Instanzen aktuell gesehen werden:

```ts
import { presence } from "@lorenz/browser-message-bus/presence";

const peers = bus.use(presence());

console.log(peers.peers());

peers.onJoin(peer => {
  console.log("Teilnehmer hinzugekommen", peer);
});

peers.onLeave(peer => {
  console.log("Teilnehmer nicht mehr erreichbar", peer);
});
```

Presence arbeitet mit Announce-, Query- und Heartbeat-Nachrichten. Da Browser Hintergrund-Tabs drosseln können, ist die Erkennung bewusst als Best-Effort-Funktion zu verstehen.

## Request/Reply

Für Aufrufe mit Antwort gibt es die optionale Request/Reply-Erweiterung:

```ts
import { requestReply } from "@lorenz/browser-message-bus/request-reply";

interface Requests {
  "settings.get": {
    request: { userId: string };
    response: { theme: "light" | "dark" };
  };
}

const rpc = bus.use(requestReply<Requests>());

rpc.handle("settings.get", async request => {
  return { theme: "dark" };
});

const settings = await rpc.request(
  "settings.get",
  { userId: "123" },
  { target: { instanceId: anotherInstanceId } }
);
```

Erreicht ein ungezielter Request mehrere Handler, gewinnt die erste gültige Antwort. Wenn genau eine Instanz antworten soll, sollte der Request deshalb gezielt gesendet werden.

## Cross-Origin Bridge

`BroadcastChannel` kann nicht über unterschiedliche Origins hinweg kommunizieren. Dafür gibt es explizite Bridges.

Host mit iframe:

```ts
import { iframeBridge } from "@lorenz/browser-message-bus/bridge";

const connection = await bus.connect(
  iframeBridge({
    iframe: document.querySelector("iframe")!,
    origin: "https://viewer.example.com"
  })
);

console.log(connection.remote.instanceId);

// Wird erfüllt, wenn die Verbindung lokal oder von der Gegenseite geschlossen wird.
await connection.closed;
```

Im iframe:

```ts
import { windowBridge } from "@lorenz/browser-message-bus/bridge";

await bus.connect(
  windowBridge({
    targetWindow: window.parent,
    origin: "https://host.example.com",
    mode: "accept"
  })
);
```

`window.postMessage()` wird nur für den Handshake verwendet. Danach läuft der normale Nachrichtenaustausch über einen dedizierten `MessagePort`.

Eine Bridge kann zusätzlich eingeschränkt werden:

```ts
iframeBridge({
  iframe,
  origin: "https://viewer.example.com",
  allowedTopics: ["document.open", "viewer.close"],
  allowedExtensions: ["request-reply"]
});
```

Sobald mindestens eine Allowlist gesetzt ist, gilt für diese Bridge **deny by default**. Nicht freigegebene Anwendungstopics oder Extension-Nachrichten werden nicht übertragen.

## Persistent Log

Ausgewählte öffentliche Nachrichten können optional in IndexedDB protokolliert werden:

```ts
import { persistentLog } from "@lorenz/browser-message-bus/persistent-log";

const log = bus.use(
  persistentLog({
    topics: ["document.open"],
    maxAgeMs: 7 * 24 * 60 * 60_000,
    maxEntries: 10_000
  })
);

await log.ready();

const entries = await log.read({
  topic: "document.open",
  order: "desc",
  limit: 100
});
```

Das Persistent Log speichert nur öffentliche Nachrichten, die der jeweiligen Bus-Instanz fachlich zugestellt wurden. Eine Nachricht, die gezielt an eine andere `instanceId` adressiert ist, landet deshalb nicht im lokalen Log. Der Log ist kein manipulationssicheres Auditlog und wird von der Bibliothek nicht verschlüsselt. Er sollte nur Daten enthalten, die für browserseitige Speicherung geeignet sind.

## Zustellungsmodell

Der Bus gibt bewusst keine stärkeren Garantien vor, als Browser-Transporte zuverlässig leisten können:

- lokale Zustellung und `BroadcastChannel` sind standardmäßig aktiv;
- jede Nachricht erhält eine `messageId`;
- dieselbe `messageId` wird von einer laufenden Instanz höchstens einmal verarbeitet;
- Bridges können Nachrichten zwischen Bus-Segmenten weiterleiten;
- erreicht eine Nachricht ihre konkrete `instanceId`, endet die Weiterleitung dort; Broadcasts und `appId`-Targets können weiterhin mehrere Segmente erreichen;
- ein Hop-Limit verhindert Endlosschleifen bei zyklischen Topologien;
- Subscriber sind voneinander isoliert und erhalten eigene Payload-Snapshots;
- ein langsamer oder fehlerhafter Subscriber blockiert andere Subscriber nicht;
- innerhalb eines einzelnen Subscribers bleibt die FIFO-Reihenfolge erhalten;
- es gibt keine Exactly-Once-Garantie, keine Offline-Queue und keine automatische Wiederholung verlorener Nachrichten;
- es gibt keine globale Reihenfolge über mehrere Sender und Transportwege hinweg.

## Bewusst nicht Bestandteil der Bibliothek

Nicht vorgesehen sind unter anderem:

- Wildcard-Topics und komplexe Topic-Hierarchien;
- automatische Bridge-Erkennung;
- Authentifizierung oder Benutzerautorisierung;
- ein Rollen- oder ACL-System;
- dauerhafte Queue-/Broker-Semantik;
- Exactly-Once Delivery;
- Leader Election oder Distributed Transactions;
- Framework-spezifische Abhängigkeiten.

Diese Begrenzung ist Absicht: Der Message Bus soll eine kleine, verständliche Kommunikationsschicht für Browser-Anwendungen bleiben.

## Weitere Dokumentation

- [Architektur](ARCHITEKTUR.md) – Aufbau, Routing, Bridges, Extensions und Sicherheitsgrenzen

## Lizenz

MIT. Siehe [LICENSE](LICENSE).
