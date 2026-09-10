#!/usr/bin/env bash
set -euo pipefail

# Ergänzt die Dokumentation und erklärende Kommentare für den aktuellen
# Browser-Message-Bus-Projektstand. Die Programmlogik wird nicht verändert.

ROOT="$(pwd)"

if [[ ! -f "$ROOT/package.json" || ! -f "$ROOT/src/core/message-bus.ts" ]]; then
  echo "Fehler: Dieses Skript muss im Wurzelverzeichnis des Browser-Message-Bus-Projekts ausgeführt werden." >&2
  echo "Erwartet werden mindestens package.json und src/core/message-bus.ts." >&2
  exit 1
fi

if ! grep -q '"@lorenz/browser-message-bus"' "$ROOT/package.json"; then
  echo "Warnung: Der erwartete Paketname @lorenz/browser-message-bus wurde nicht gefunden." >&2
  echo "Das Skript wird trotzdem fortgesetzt, solange die erwartete Projektstruktur vorhanden ist." >&2
fi

mkdir -p "$ROOT/docs"

cat > "$ROOT/README.md" <<'EOF'
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

Das Persistent Log ist kein manipulationssicheres Auditlog und wird von der Bibliothek nicht verschlüsselt. Es sollte nur Daten enthalten, die für browserseitige Speicherung geeignet sind.

## Zustellungsmodell

Der Bus gibt bewusst keine stärkeren Garantien vor, als Browser-Transporte zuverlässig leisten können:

- lokale Zustellung und `BroadcastChannel` sind standardmäßig aktiv;
- jede Nachricht erhält eine `messageId`;
- dieselbe `messageId` wird von einer laufenden Instanz höchstens einmal verarbeitet;
- Bridges können Nachrichten zwischen Bus-Segmenten weiterleiten;
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

- [Architektur](docs/ARCHITEKTUR.md) – Aufbau, Routing, Bridges, Extensions und Sicherheitsgrenzen
- [Tests](docs/TESTS.md) – Testaufbau, Testszenarien und E2E-Umgebung

## Lizenz

MIT. Siehe [LICENSE](LICENSE).
EOF

cat > "$ROOT/docs/ARCHITEKTUR.md" <<'EOF'
# Architektur

Dieses Dokument beschreibt nicht nur, welche Klassen es gibt, sondern vor allem, warum der Browser Message Bus so aufgebaut ist. Die öffentliche API soll klein bleiben, während die intern schwierigeren Themen – Routing, Deduplizierung, Cross-Origin-Bridges und optionale Erweiterungen – voneinander getrennt sind.

## Zielbild

Der Bus soll für eine Anwendung im Normalfall so aussehen:

```ts
const bus = createMessageBus<Messages>({ channel: "workspace" });

bus.subscribe("document.open", payload => {
  // Nachricht verarbeiten
});

bus.publish("document.open", { id: "4711" });
```

Dafür ist kein explizites `start()` nötig. Der `BroadcastChannel` wird beim Erzeugen des Busses eingerichtet und der Bus ist danach direkt verwendbar.

Zusätzliche Fähigkeiten bleiben sichtbar und explizit:

```ts
bus.use(presence());
bus.use(requestReply<Requests>());
await bus.connect(iframeBridge(...));
```

`use()` erweitert die Semantik des Busses. `connect()` erweitert dagegen seine Kommunikationsreichweite.

## Überblick

```text
Anwendung
   │
   │ publish / subscribe / use / connect
   ▼
MessageBus Core
   │
   ├── lokale Zustellung
   ├── Routing und Targeting
   ├── Deduplizierung
   ├── Subscriber-Queues
   ├── Observer für Extensions
   │
   ├── BroadcastChannelTransport ─── gleicher Origin
   │
   └── MessagePortTransport ─────── explizite Bridge
                                      │
                                      └── Window / iframe / Popup
```

Der Core kennt nur das abstrakte `BusTransport`-Interface. Dadurch muss Routing nicht wissen, ob eine Nachricht gerade über `BroadcastChannel` oder über eine Bridge angekommen ist.

## Öffentliche Nachrichten

Die Anwendung definiert ihre Topics über eine TypeScript-Message-Map:

```ts
interface Messages {
  "customer.selected": {
    customerId: string;
  };

  "viewer.close": undefined;
}
```

Damit sind Topic und Payload beim Aufruf von `publish()` und `subscribe()` gekoppelt. Die Typisierung ist eine Compile-Time-Hilfe; sie ersetzt keine Runtime-Validierung von Daten aus nicht vertrauenswürdigen Quellen.

Topics sind absichtlich einfache, exakte Strings. Ein Name wie `viewer.document.open` kann als Konvention verwendet werden, der Core interpretiert die Punkte aber nicht als Hierarchie.

## Envelope

Intern wird jede Nachricht in einem Envelope transportiert. Dieser enthält neben Topic und Payload technische Informationen:

```text
namespace
protocolVersion
id / messageId
topic
payload
source
optional target
timestamp
hop
system
```

Die Anwendung arbeitet normalerweise nicht direkt mit diesem Envelope. Subscriber erhalten stattdessen die fachliche Payload und einen kleinen `MessageContext`.

Der feste Namespace und die Protokollversion sorgen dafür, dass fremde oder inkompatible Daten auf Transportebene nicht versehentlich als Bus-Nachrichten behandelt werden.

## Identität und Targeting

Jede laufende Bus-Instanz hat eine `instanceId`. Wenn keine vorgegeben wird, entsteht sie über `crypto.randomUUID()`.

Optional kann eine `appId` angegeben werden. Sie beschreibt eher die Art der Anwendung als eine konkrete Laufzeitinstanz:

```text
appId = viewer
   ├── instanceId = A
   ├── instanceId = B
   └── instanceId = C
```

Ohne `target` wird eine Nachricht an alle passenden Bus-Teilnehmer gesendet. Ein Target kann eine konkrete `instanceId`, eine `appId` oder beides enthalten. Sind beide Werte vorhanden, müssen beide passen.

Targeting ist eine Routing-Entscheidung im Message Bus. Es ist **keine Vertraulichkeits- oder Autorisierungsgrenze**. Insbesondere Teilnehmer desselben `BroadcastChannel` verwenden denselben Browser-Transport.

## Lokale Zustellung und Payload-Isolation

Ein Publish wird auch lokal zugestellt. Dabei erhält jeder Subscriber einen eigenen `structuredClone()` der Payload.

```text
                 Nachricht
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Snapshot A Snapshot B Snapshot C
          │          │          │
     Subscriber A Subscriber B Subscriber C
```

Dadurch kann ein Subscriber sein Payload-Objekt verändern, ohne die Daten eines anderen Subscribers zu beeinflussen. Observer von Extensions bekommen ebenfalls isolierte Snapshots.

Diese Entscheidung macht lokale Zustellung semantisch ähnlicher zu browserinternen Transporten, bei denen Daten ebenfalls über den Structured-Clone-Algorithmus übertragen werden.

## Subscriber-Queues

Jede Subscription besitzt eine eigene Promise-Kette. Damit gelten zwei wichtige Eigenschaften gleichzeitig:

1. Nachrichten für **denselben** Subscriber werden in FIFO-Reihenfolge verarbeitet.
2. Ein langsamer Subscriber blockiert **andere** Subscriber nicht.

```text
Subscriber A: M1 ───── wartet ───── M2
Subscriber B: M1 ─ M2 ─ M3
```

Fehler eines Handlers werden an `onError` gemeldet, reißen aber die Zustellung an andere Subscriber nicht ab.

## BroadcastChannel als Standardtransport

Beim Erzeugen eines Busses registriert der Core automatisch einen `BroadcastChannelTransport` für den konfigurierten `channel`.

Das eignet sich für mehrere Tabs, Fenster und Frames desselben Origins. Es gibt keine zusätzliche Discovery-Konfiguration und keinen Listener für `window.postMessage`, solange keine Bridge eingerichtet wird.

Der Channel-Name dient der logischen Gruppierung. Er ist kein Passwort und sollte nicht als Security Token betrachtet werden.

## Routing über mehrere Transporte

Eine Nachricht kann aus einem Transport eintreffen und über andere Transporte weitergeleitet werden. Genau dadurch funktioniert zum Beispiel diese Topologie:

```text
Cross-Origin iframe
       │
       │ MessagePort
       ▼
Host Tab A
       │
       │ BroadcastChannel
       ▼
Host Tab B
```

Beim Weiterleiten wird der eingehende Transport ausgelassen. Zusätzlich verhindern `messageId`, Deduplizierungs-Cache und Hop-Zähler Schleifen und Mehrfachverarbeitung.

## Deduplizierung und Hop-Limit

Jede neu erzeugte Nachricht erhält eine eindeutige ID. Eine Instanz merkt sich bereits gesehene IDs für eine begrenzte Zeit.

Kommt dieselbe Nachricht später über einen zweiten Weg erneut an, wird sie verworfen. Der Cache ist absichtlich begrenzt, damit er nicht unbegrenzt wächst.

Der `hop`-Wert ist ein zusätzlicher Schutz für zyklische Topologien. Sobald `maxHops` erreicht ist, wird die Nachricht nicht weitergeleitet.

Das ist Loop Prevention, keine Exactly-Once-Garantie. Nach Prozessende oder Ablauf des Deduplizierungsfensters gibt es keine dauerhafte Zustellhistorie im Core.

## Cross-Origin Bridges

Unterschiedliche Origins können keinen gemeinsamen `BroadcastChannel` verwenden. Eine Bridge verbindet deshalb zwei bekannte `Window`-Objekte explizit.

Der Handshake läuft vereinfacht so ab:

```text
Connect-Seite                         Accept-Seite
     │                                     │
     │ bridge:hello + nonce                │
     ├────────────────────────────────────►│
     │                                     │
     │ bridge:ready + acceptNonce          │
     │◄────────────────────────────────────┤
     │                                     │
     │ bridge:connect + MessagePort        │
     ├────────────────────────────────────►│
     │                                     │
     │ bridge:ack über MessagePort         │
     │◄════════════════════════════════════┤
     │                                     │
     │ ab jetzt normale Bus-Nachrichten    │
     ├════════════ MessagePort ═══════════►│
```

`window.postMessage()` wird also nur für die Aushandlung und Übertragung des `MessagePort` gebraucht. Danach läuft der Datenverkehr über den dedizierten Port.

### Sicherheitsprüfungen der Bridge

Eine Bridge akzeptiert nicht einfach beliebige `message`-Events. Geprüft werden unter anderem:

- exakter HTTP(S)-Origin; `"*"` und `"null"` werden nicht akzeptiert;
- exaktes `event.source`-Window;
- gemeinsamer Bus-`channel`;
- Namespace und Protokollversion;
- zufällige Nonces des Handshakes;
- Connection-ID;
- Struktur eingehender Envelopes.

Optional kann die Bridge mit `allowedTopics` und `allowedExtensions` begrenzt werden. Sobald eine solche Policy explizit gesetzt ist, gilt deny by default.

Die Bridge ersetzt trotzdem keine fachliche Authentifizierung oder Autorisierung. Ob ein Benutzer ein Dokument wirklich öffnen darf, muss weiterhin die Anwendung beziehungsweise das Backend entscheiden.

## Extensions

Extensions verwenden einen kleinen internen Kontext, statt direkt auf die komplette `BrowserMessageBus`-Klasse zugreifen zu müssen. Dadurch bleiben sie vom internen Aufbau des Core weitgehend entkoppelt.

Interne Extension-Topics liegen im reservierten Namensraum:

```text
@bmb/ext/<extension-id>/...
```

Anwendungscode darf keine öffentlichen Topics unter `@bmb/` veröffentlichen. So können interne Protokolle nicht versehentlich mit fachlichen Topics kollidieren.

### Presence

Presence verwendet interne Query-, Announce-, Heartbeat- und Bye-Nachrichten. Peers werden anhand ihrer `instanceId` geführt.

Da Browser Hintergrund-Tabs drosseln oder einfrieren können, ist Presence keine harte Verfügbarkeitsgarantie. Ein Peer gilt nach einem Timeout als verschwunden, kann sich später aber wieder ankündigen.

### Request/Reply

Request/Reply legt über dem normalen Bus ein kleines Korrelationsprotokoll. Jeder Request erhält eine `requestId`; Responses referenzieren genau diese ID.

Ein Timeout und optional ein `AbortSignal` verhindern, dass Promises unbegrenzt offen bleiben. Remote-Fehler werden serialisiert und auf der anfragenden Seite als `RemoteRequestError` rekonstruiert.

Wenn mehrere Handler einen ungezielten Request erhalten, gewinnt die erste passende Response. Für deterministisches Verhalten sollte eine konkrete Instanz als Target angegeben werden.

### Persistent Log

Das Persistent Log beobachtet ausschließlich öffentliche Nachrichten und schreibt ausgewählte Topics in IndexedDB.

Schreiboperationen laufen über eine Promise-Kette, damit die Reihenfolge der Store-Operationen kontrollierbar bleibt. Regelmäßiges Cleanup begrenzt Alter und Anzahl der Einträge.

Vor dem Speichern wird ein eigener Snapshot erzeugt. Ein später mutiertes Objekt aus einem Subscriber kann den protokollierten Datensatz deshalb nicht nachträglich verändern.

Der Log ist kein Auditlog. IndexedDB gehört zum Origin und kann auch von anderem Scriptcode desselben Origins gelesen oder verändert werden.

## Fehlerbehandlung

Der Bus versucht Fehler lokal zu isolieren. Ein Fehler in einem Subscriber, einer Extension oder einem Transport wird mit einem `MessageBusErrorContext` an den konfigurierten `onError`-Handler gemeldet.

Selbst ein fehlerhafter Error-Handler darf die Zustellung nicht unterbrechen; deshalb wird auch dessen Fehler abgefangen.

Fehler, die einen synchronen API-Aufruf grundsätzlich unmöglich machen – zum Beispiel ein ungültiges Topic oder eine nicht clonebare Payload – werden dagegen direkt geworfen.

## Lifecycle

`close()` ist idempotent. Beim Schließen werden Extensions in umgekehrter Installationsreihenfolge disposed, Connections und Transporte geschlossen sowie Subscriptions, Observer und Deduplizierungszustand freigegeben.

Eine bereits geschlossene Instanz akzeptiert keine neuen Publish-, Subscribe-, Use- oder Connect-Aufrufe mehr.

Ein möglicher späterer Ausbaupunkt ist die explizitere Beobachtung eines unerwarteten Bridge-Abbruchs, etwa über ein `connection.closed`-Promise. Automatisches Reconnect gehört bewusst nicht in den Core, weil die Anwendung entscheiden sollte, ob und wann eine neue Verbindung sinnvoll ist.

## Build- und Paketgrenzen

Der Build kompiliert ausschließlich `src/**/*.ts` nach `dist/` und erzeugt JavaScript, `.d.ts`-Dateien und Source Maps. Tests und Testkonfigurationen sind Entwicklungsbestandteile des Repositories und werden nicht in `dist/` kompiliert.

Über `package.json#exports` werden nur die vorgesehenen Einstiegspunkte veröffentlicht:

```text
@lorenz/browser-message-bus
@lorenz/browser-message-bus/bridge
@lorenz/browser-message-bus/presence
@lorenz/browser-message-bus/request-reply
@lorenz/browser-message-bus/persistent-log
```

Diese klare Exportfläche verhindert, dass Consumer versehentlich von internen Dateien wie `src/core/message-bus.ts` abhängig werden.

## Bewusste Nicht-Ziele

Die Bibliothek soll kein universelles Messaging-Framework werden. Deshalb gehören folgende Themen bewusst nicht in den Core:

- Backend-Kommunikation;
- Benutzer-Authentifizierung;
- dauerhaft garantierte Zustellung;
- Exactly-Once Delivery;
- verteilte Transaktionen;
- Service Registry;
- automatische Discovery von Bridges;
- komplexe ACL- oder Rollenmodelle;
- Framework-spezifische APIs.

Je kleiner diese Grenze bleibt, desto leichter lässt sich die zentrale Zusage der Bibliothek verstehen und testen: **verlässliche, typisierte Best-Effort-Kommunikation zwischen Browser-Kontexten mit expliziten Erweiterungen für die Fälle, die mehr brauchen.**
EOF

cat > "$ROOT/docs/TESTS.md" <<'EOF'
# Tests

Die Tests sollen nicht nur einzelne Funktionen abhaken. Sie sichern vor allem die Eigenschaften ab, auf die sich ein Consumer der Bibliothek verlassen können soll: Routing, Isolation, Bridge-Sicherheit, Lifecycle und das Verhalten der optionalen Extensions.

## Testebenen

Das Projekt verwendet zwei Testebenen:

1. **Vitest** für schnelle Unit- und Integrationstests in Node.
2. **Playwright** für Szenarien, bei denen echte Browser-APIs und echte Browser-Kontexte wichtig sind.

Der Typecheck und der Build gehören zusätzlich zum Release-Check, auch wenn sie keine klassischen Laufzeittests sind.

## Alle wichtigen Prüfungen ausführen

Abhängigkeiten installieren:

```bash
npm install
```

TypeScript prüfen:

```bash
npm run typecheck
```

Vitest ausführen:

```bash
npm test
```

Produktions-Build erzeugen:

```bash
npm run build
```

Für die E2E-Tests beim ersten Mal Chromium installieren:

```bash
npx playwright install chromium
```

Danach:

```bash
npm run test:e2e
```

Der komplette Prüflauf ist zusammengefasst in:

```bash
npm run test:all
```

## Vitest-Konfiguration

`vitest.config.ts` verwendet die Node-Umgebung. Das ist für die schnellen Tests sinnvoll, weil die verwendeten Browser-Primitiven entweder in der Runtime verfügbar sind oder gezielt durch Test-Harnesses beziehungsweise `fake-indexeddb` bereitgestellt werden.

Wichtige Einstellungen sind:

- `restoreMocks: true` – Mocks werden zwischen Tests zurückgesetzt;
- `clearMocks: true` – aufgezeichnete Aufrufe laufen nicht in den nächsten Test hinein;
- `testTimeout: 10_000` – asynchrone Kommunikationsfälle bekommen genug Zeit, ohne Hänger dauerhaft zu verdecken.

Die Vitest-Tests sollen möglichst schnell bleiben. Verhalten, das von echten Browser-Seiten, Frames oder IndexedDB abhängt, wird zusätzlich mit Playwright geprüft.

## Testszenarien im Core

`tests/core.test.ts` deckt den normalen API-Weg ab:

- lokale Zustellung ohne Zusatzkonfiguration;
- Kommunikation zwischen zwei Instanzen desselben Channels über `BroadcastChannel`;
- Isolation verschiedener Channels;
- Targeting per `instanceId`;
- Targeting per `appId`;
- Isolation langsamer Subscriber;
- Ablehnung reservierter Topics und leerer Targets;
- Fehler bei Payloads, die der Structured-Clone-Algorithmus nicht transportieren kann;
- idempotentes `close()` und Ablehnung weiterer Nutzung nach dem Schließen.

## Hardening-Tests

`tests/hardening.test.ts` prüft Eigenschaften, die im Alltag leicht übersehen werden:

- jeder lokale Subscriber erhält einen eigenen Payload-Snapshot;
- Observer verschiedener Extensions beeinflussen sich nicht durch Payload-Mutation;
- ein einzelner asynchroner Subscriber verarbeitet seine Nachrichten in FIFO-Reihenfolge;
- ein `AbortSignal` beendet eine Subscription zuverlässig.

Diese Tests sind wichtig, weil sie nicht nur das Ergebnis einer Nachricht prüfen, sondern die Isolations- und Reihenfolgegarantien des Core.

## Bridge-Tests

`tests/bridge.test.ts` verwendet einen kontrollierten Window-Harness. Damit kann der Handshake deterministisch getestet werden, ohne für jeden Edge Case einen echten Browser starten zu müssen.

Geprüft werden unter anderem:

- exakte Origin-Prüfung;
- Timeout bei falschem oder ausbleibendem Gegenüber;
- Handshake und Aufbau des `MessagePort`;
- Routing von einer Bridge in einen `BroadcastChannel` und weiter zu einer anderen Instanz;
- Deduplizierung, wenn dieselbe Nachricht über mehrere Wege auftaucht.

`tests/bridge-policy.test.ts` konzentriert sich auf die Allowlist-Semantik:

- erlaubte Anwendungstopics passieren die Bridge;
- nicht erlaubte Anwendungstopics werden verworfen;
- interne Extension-Nachrichten benötigen eine passende `allowedExtensions`-Freigabe;
- sobald eine Policy gesetzt ist, gilt deny by default.

## Presence

`tests/presence.test.ts` prüft Discovery sowie Join-/Leave-Verhalten. Dabei wird nicht angenommen, dass Presence eine harte Netzwerkgarantie ist; getestet wird das von der Extension definierte Best-Effort-Protokoll.

## Request/Reply

`tests/request-reply.test.ts` deckt die normale Request/Reply-Nutzung ab:

- gezielte Requests;
- erfolgreiche Antworten;
- Remote-Fehler;
- Timeout.

`tests/request-reply-hardening.test.ts` ergänzt die schwierigeren Lifecycle-Fälle:

- Abbruch über `AbortSignal`;
- mehrere mögliche Responder und First-Response-Wins;
- Schließen eines Busses während ein Handler noch arbeitet;
- ungültige Timeout-Konfiguration.

## Persistent Log und IndexedDB

`tests/persistent-log.test.ts` verwendet einen kleinen Memory-Store. Damit lässt sich die Extension-Logik unabhängig von IndexedDB schnell und deterministisch prüfen.

`tests/indexed-db-log.test.ts` verwendet `fake-indexeddb` und testet die echte `IndexedDbLogStore`-Implementierung. Geprüft werden Schreiben, Lesen und Löschen über denselben Codepfad, der auch im Browser verwendet wird.

Der echte Browserpfad wird zusätzlich in Playwright getestet.

## Echte Browser-E2E-Tests

Die Playwright-Suite liegt unter `tests/e2e/`.

Für die Tests werden zwei kleine HTTP-Server gestartet:

```text
http://127.0.0.1:4173
http://127.0.0.1:4174
```

Die unterschiedlichen Ports ergeben unterschiedliche Origins. Damit lässt sich ein echter Cross-Origin-Fall testen, ohne externe Infrastruktur zu benötigen.

### Zwei Tabs über BroadcastChannel

```text
Browser Context
   │
   ├── Tab A ─────┐
   │              │ BroadcastChannel
   └── Tab B ─────┘
```

Der Test stellt sicher, dass eine Nachricht zwischen zwei echten Seiten desselben Origins ankommt.

### Cross-Origin iframe

```text
Host auf :4173
      │
      │ iframe
      ▼
Child auf :4174
```

Beide Seiten erzeugen einen eigenen Bus. Der Child-Frame akzeptiert eine `windowBridge`, der Host verbindet sich mit `iframeBridge`. Danach werden Nachrichten in beide Richtungen über den ausgehandelten `MessagePort` gesendet.

Damit wird der Pfad mit echten `Window`-Objekten, echtem `postMessage`, echtem `MessageChannel` und echtem Origin-Vergleich geprüft.

### Echtes IndexedDB

Ein weiterer E2E-Test installiert das Persistent Log in einer Browserseite, schreibt eine Nachricht und liest sie anschließend wieder aus IndexedDB. Damit wird zusätzlich zum `fake-indexeddb`-Test bestätigt, dass die Browser-API tatsächlich mit der Extension zusammenspielt.

## Testartefakte

Playwright kann bei Testläufen Diagnoseartefakte erzeugen, zum Beispiel:

```text
test-results/
playwright-report/
blob-report/
```

Diese Ordner gehören nicht in Git. Sie sind lokale beziehungsweise CI-generierte Ergebnisse. In CI können sie bei fehlgeschlagenen Tests als Pipeline-Artefakte aufgehoben werden.

## Neue Tests hinzufügen

Ein neuer Test sollte möglichst die kleinste sinnvolle Ebene verwenden:

- reine Core-Logik → Vitest;
- Extension-Semantik → Vitest;
- IndexedDB-Store → Vitest mit `fake-indexeddb`;
- Browser-Lifecycle, Tabs, echte Frames oder echte Origin-Grenzen → Playwright.

E2E-Tests sollten nicht für Dinge verwendet werden, die sich zuverlässig in Vitest prüfen lassen. Dadurch bleibt die Suite schnell und Fehler lassen sich leichter lokalisieren.

## Empfohlener CI-Ablauf

Für Pull Requests und Releases sollte mindestens Folgendes automatisch laufen:

```text
npm ci
  │
  ├── npm run typecheck
  ├── npm test
  ├── npm run build
  └── npm run test:e2e
```

Vor einem npm-Release ist zusätzlich `npm pack --dry-run` sinnvoll. Damit lässt sich kontrollieren, dass nur die vorgesehenen Dateien im Paket landen.
EOF

# Playwright-/Testausgaben sollen nicht versehentlich im Repository landen.
python3 - <<'PY'
from pathlib import Path

path = Path('.gitignore')
text = path.read_text(encoding='utf-8') if path.exists() else ''
entries = [
    'test-results/',
    'playwright-report/',
    'blob-report/',
]
missing = [entry for entry in entries if entry not in text.splitlines()]
if missing:
    if text and not text.endswith('\n'):
        text += '\n'
    if text and not text.endswith('\n\n'):
        text += '\n'
    text += '# Generierte Playwright-Artefakte\n' + '\n'.join(missing) + '\n'
    path.write_text(text, encoding='utf-8')
PY

# Fügt erklärende Kommentare idempotent ein. Die Ersetzungen verändern keine
# ausführbare Anweisung, sondern setzen ausschließlich Kommentarblöcke davor.
python3 - <<'PY'
from pathlib import Path

patches: list[tuple[str, str, str]] = [
    (
        'src/index.ts',
        'export function createMessageBus<M extends MessageMap>(',
        '''/**\n * Erzeugt eine sofort einsatzbereite Bus-Instanz.\n * Der konfigurierte BroadcastChannel wird direkt eingerichtet; ein separates start() ist nicht nötig.\n */'''
    ),
    (
        'src/core/types.ts',
        'export type MessageMap = object;',
        '''/**\n * Beschreibt die fachlichen Topics einer Anwendung und die jeweils dazugehörige Payload.\n * Die konkrete Message-Map wird vom Consumer als generischer Typparameter angegeben.\n */'''
    ),
    (
        'src/core/types.ts',
        'export interface BusIdentity {',
        '''/** Identität genau einer laufenden Bus-Instanz. appId gruppiert optional mehrere Instanzen derselben Anwendung. */'''
    ),
    (
        'src/core/types.ts',
        'export interface MessageTarget {',
        '''/**\n * Optionales Routing-Ziel einer Nachricht. Sind instanceId und appId gesetzt, müssen beide zur Empfängerinstanz passen.\n * Das Target ist keine Security- oder Vertraulichkeitsgrenze.\n */'''
    ),
    (
        'src/core/types.ts',
        'export interface MessageContext {',
        '''/** Technische Metadaten, die ein Subscriber zusätzlich zur fachlichen Payload erhält. */'''
    ),
    (
        'src/core/types.ts',
        'export interface MessageBusOptions {',
        '''/** Konfiguration des Core. Nur channel ist für den normalen Betrieb erforderlich. */'''
    ),
    (
        'src/core/types.ts',
        'export interface BusConnection {',
        '''/** Repräsentiert eine explizit aufgebaute zusätzliche Verbindung, zum Beispiel zu einem iframe oder Popup. */'''
    ),
    (
        'src/core/types.ts',
        'export interface MessageBusExtension<TApi> {',
        '''/**\n * Erweiterung mit eigener API. Extensions nutzen nur den schmalen ExtensionContext und bleiben dadurch vom Core entkoppelt.\n */'''
    ),
    (
        'src/core/types.ts',
        'export interface BusTransport {',
        '''/**\n * Interne Transport-Abstraktion. Der Core routet Envelopes unabhängig davon, ob sie über BroadcastChannel oder MessagePort laufen.\n */'''
    ),
    (
        'src/core/types.ts',
        'export interface BusEnvelope {',
        '''/**\n * Internes Transportformat einer Nachricht. Anwendungscode arbeitet normalerweise nur mit Payload und MessageContext.\n */'''
    ),
    (
        'src/core/types.ts',
        'export interface MessageBus<M extends MessageMap> {',
        '''/** Öffentliche, bewusst kleine API des Message Bus. */'''
    ),
    (
        'src/core/message-bus.ts',
        'class ConnectionImpl implements BusConnection {',
        '''/** Hält den sichtbaren Lifecycle einer mit connect() aufgebauten Transportverbindung. */'''
    ),
    (
        'src/core/message-bus.ts',
        'export class BrowserMessageBus<M extends MessageMap> implements MessageBus<M> {',
        '''/**\n * Zentrale Routing-Instanz. Sie verbindet lokale Zustellung, Transporte und Extensions,\n * ohne transport- oder framework-spezifische Details in die öffentliche API zu ziehen.\n */'''
    ),
    (
        'src/core/message-bus.ts',
        '  constructor(options: MessageBusOptions) {',
        '''  /** Validiert die Identität und startet den standardmäßigen BroadcastChannel-Transport. */'''
    ),
    (
        'src/core/message-bus.ts',
        '  publish<K extends TopicOf<M>>(',
        '''  /** Veröffentlicht eine fachliche Nachricht und gibt ihre eindeutige messageId zurück. */'''
    ),
    (
        'src/core/message-bus.ts',
        '  subscribe<K extends TopicOf<M>>(',
        '''  /** Registriert einen Subscriber. Ein optionales AbortSignal kann die Subscription automatisch beenden. */'''
    ),
    (
        'src/core/message-bus.ts',
        '  use<TApi>(extension: MessageBusExtension<TApi>): TApi {',
        '''  /** Installiert eine optionale semantische Erweiterung in einem reservierten internen Topic-Namensraum. */'''
    ),
    (
        'src/core/message-bus.ts',
        '  async connect(connector: BusConnector): Promise<BusConnection> {',
        '''  /** Baut über einen Connector einen zusätzlichen Transportweg auf, ohne die normale Bus-API zu verändern. */'''
    ),
    (
        'src/core/message-bus.ts',
        '  async close(): Promise<void> {\n    if (this.isClosed) {',
        '''  /**\n   * Schließt den Bus idempotent. Extensions werden zuerst disposed, danach Connections, Transporte und lokaler Zustand.\n   */'''
    ),
    (
        'src/core/message-bus.ts',
        '  private publishEnvelope(',
        '''  /**\n   * Gemeinsamer Publish-Pfad für öffentliche und interne Extension-Nachrichten.\n   * Die Payload wird vor der ersten Zustellung geklont, damit nur transportierbare Daten in den Bus gelangen.\n   */'''
    ),
    (
        'src/core/message-bus.ts',
        '  private receive(value: BusEnvelope, incomingTransportId: string): void {',
        '''  /**\n   * Verarbeitet eingehende Envelopes genau einmal pro laufender Instanz und leitet sie bei Bedarf an andere Transporte weiter.\n   */'''
    ),
    (
        'src/core/message-bus.ts',
        '  private deliverLocally(envelope: BusEnvelope): void {',
        '''  /**\n   * Stellt lokal zu. Jeder Subscriber bekommt einen eigenen Snapshot und eine eigene FIFO-Promise-Kette,\n   * sodass Mutation und langsame Handler andere Subscriptions nicht beeinflussen.\n   */'''
    ),
    (
        'src/core/message-bus.ts',
        '  private forward(envelope: BusEnvelope, excludeTransportId?: string): void {',
        '''  /** Leitet eine Nachricht an alle Transporte außer demjenigen weiter, über den sie gerade angekommen ist. */'''
    ),
    (
        'src/core/message-bus.ts',
        '  private observe(envelope: BusEnvelope): void {',
        '''  /** Liefert öffentliche Nachrichten als isolierte Snapshots an Observer-Extensions wie das Persistent Log. */'''
    ),
    (
        'src/core/envelope.ts',
        'export function isBusEnvelope(value: unknown): value is BusEnvelope {',
        '''/**\n * Runtime-Grenze für Daten aus Transporten. Geprüft wird das technische Envelope, nicht die fachliche Form der Payload.\n */'''
    ),
    (
        'src/core/deduplication.ts',
        'export class DeduplicationCache {',
        '''/**\n * Merkt sich kürzlich gesehene messageIds. Der begrenzte Cache verhindert Mehrfachverarbeitung über mehrere Routen,\n * ohne dauerhaft mit der Laufzeit des Prozesses zu wachsen.\n */'''
    ),
    (
        'src/core/utils.ts',
        'export function cloneForTransport<T>(value: T): T {',
        '''/**\n * Nutzt denselben Structured-Clone-Mechanismus, auf dem auch die Browser-Transporte basieren.\n * Nicht transportierbare Werte werden früh und mit einem domänenspezifischen Fehler abgelehnt.\n */'''
    ),
    (
        'src/core/utils.ts',
        'export function matchesTarget(',
        '''/** Prüft ausschließlich die Routing-Semantik eines Targets; eine Autorisierungsentscheidung ist das nicht. */'''
    ),
    (
        'src/transports/broadcast-channel-transport.ts',
        'export class BroadcastChannelTransport implements BusTransport {',
        '''/**\n * Standardtransport für Browser-Kontexte desselben Origins. Der Core registriert genau einen Transport pro channel.\n */'''
    ),
    (
        'src/transports/message-port-transport.ts',
        'export class MessagePortTransport implements BusTransport {',
        '''/**\n * Dedizierter Transport einer expliziten Window-/iframe-Bridge. Nach dem Handshake läuft der normale Verkehr nur noch über diesen Port.\n */'''
    ),
    (
        'src/transports/message-port-transport.ts',
        '  private isAllowed(envelope: BusEnvelope): boolean {',
        '''  /**\n   * Ohne explizite Policy darf der komplette Bus-Verkehr passieren. Sobald eine Allowlist gesetzt ist, gilt deny by default.\n   */'''
    ),
    (
        'src/bridge/types.ts',
        'export interface BridgeTopicPolicy {',
        '''/** Optionale Allowlist für den Datenverkehr über genau diese Bridge. */'''
    ),
    (
        'src/bridge/iframe-bridge.ts',
        'export function iframeBridge(options: IframeBridgeOptions): BusConnector {',
        '''/**\n * Komfort-Connector für Host → iframe. Intern verwendet er dieselbe Window-Bridge und startet im connect-Modus.\n */'''
    ),
    (
        'src/bridge/window-bridge.ts',
        'class WindowBridgeConnector implements BusConnector {',
        '''/** Baut eine explizite Beziehung zu genau einem bekannten Window und einem exakten Origin auf. */'''
    ),
    (
        'src/bridge/window-bridge.ts',
        'export function windowBridge(options: WindowBridgeOptions): BusConnector {',
        '''/** Erzeugt den generischen Connector für iframe-, Popup- oder andere bekannte Window-Beziehungen. */'''
    ),
    (
        'src/bridge/window-bridge.ts',
        'async function connectToWindow(',
        '''/**\n * Aktive Seite des Handshakes: hello → ready → connect. Der MessagePort wird erst nach erfolgreicher Gegenprüfung übernommen.\n */'''
    ),
    (
        'src/bridge/window-bridge.ts',
        'async function acceptFromWindow(',
        '''/**\n * Passive Seite des Handshakes. Nur Nachrichten vom erwarteten Window, Origin und channel können eine Verbindung aufbauen.\n */'''
    ),
    (
        'src/bridge/window-bridge.ts',
        'function normalizeOrigin(origin: string): string {',
        '''/** Erzwingt einen exakten HTTP(S)-Origin; Wildcards, opaque Origins und URLs mit Pfad werden absichtlich abgelehnt. */'''
    ),
    (
        'src/bridge/protocol.ts',
        'export type BridgeHandshakeMessage =',
        '''/** Technische Nachrichten, die ausschließlich zum Aufbau des dedizierten MessagePort verwendet werden. */'''
    ),
    (
        'src/extensions/presence.ts',
        'export function presence(',
        '''/**\n * Installiert Best-Effort-Presence. Heartbeats helfen beim Erkennen verschwundener Peers, sind aber keine harte Verfügbarkeitsgarantie.\n */'''
    ),
    (
        'src/extensions/request-reply.ts',
        'export function requestReply<R extends ValidRequestMap<R>>(',
        '''/**\n * Legt ein korreliertes Request/Reply-Protokoll über normale interne Bus-Nachrichten.\n * Timeouts und AbortSignal verhindern dauerhaft offene Requests.\n */'''
    ),
    (
        'src/extensions/persistent-log.ts',
        'export function persistentLog(',
        '''/** Erstellt die IndexedDB-basierte Persistent-Log-Extension mit den produktiven Standardwerten. */'''
    ),
    (
        'src/extensions/persistent-log.ts',
        'export function createPersistentLogExtension(',
        '''/**\n * Separater Factory-Einstieg, damit die Extension in Tests mit einem kontrollierten LogStore betrieben werden kann.\n */'''
    ),
    (
        'src/extensions/indexed-db-log-store.ts',
        'export class IndexedDbLogStore implements LogStore {',
        '''/**\n * IndexedDB-Implementierung des LogStore. Indizes auf timestamp und [topic, timestamp] halten die üblichen Lesewege effizient.\n */'''
    ),
]

for relative_path, needle, comment in patches:
    path = Path(relative_path)
    if not path.exists():
        raise SystemExit(f'Fehler: erwartete Datei fehlt: {relative_path}')

    text = path.read_text(encoding='utf-8')
    if comment in text:
        continue
    if needle not in text:
        raise SystemExit(
            f'Fehler: Der aktuelle Stand von {relative_path} passt nicht zum erwarteten Projekt. '
            f'Ein Kommentar konnte nicht sicher vor "{needle}" eingefügt werden.'
        )
    text = text.replace(needle, comment + '\n' + needle, 1)
    path.write_text(text, encoding='utf-8')

# Die drei E2E-Tests bekommen kurze Szenario-Kommentare, weil hier der Aufbau
# mit echten Browser-Kontexten wichtiger ist als die einzelne Assertion.
e2e = Path('tests/e2e/browser.e2e.ts')
if e2e.exists():
    text = e2e.read_text(encoding='utf-8')
    e2e_patches = [
        (
            'test("communicates between two real same-origin tabs through BroadcastChannel"',
            '// E2E: Zwei echte Seiten desselben Origins kommunizieren über den nativen BroadcastChannel.\n'
        ),
        (
            'test("bridges a real cross-origin iframe with an explicit MessagePort connection"',
            '// E2E: Unterschiedliche Ports erzeugen zwei Origins; der Handshake muss einen echten MessagePort übertragen.\n'
        ),
        (
            'test("persists and reads a message with real browser IndexedDB"',
            '// E2E: Dieser Test verwendet die IndexedDB-Implementierung des Browsers statt fake-indexeddb.\n'
        ),
    ]
    for needle, comment in e2e_patches:
        if comment.strip() not in text and needle in text:
            text = text.replace(needle, comment + needle, 1)
    e2e.write_text(text, encoding='utf-8')
PY

echo
echo "Dokumentation und Kommentare wurden ergänzt."
echo
echo "Neu/aktualisiert:"
echo "  README.md"
echo "  docs/ARCHITEKTUR.md"
echo "  docs/TESTS.md"
echo "  .gitignore (Playwright-Artefakte)"
echo "  zentrale Dateien unter src/ (nur Kommentare/JSDoc)"
echo "  tests/e2e/browser.e2e.ts (Szenario-Kommentare)"
echo
echo "Die Programmlogik und package.json wurden nicht verändert."
echo
echo "Empfohlene Prüfung danach:"
echo "  npm run typecheck"
echo "  npm test"
echo "  npm run build"
echo "  npm run test:e2e"
