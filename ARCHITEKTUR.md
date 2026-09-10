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

Ist eine Nachricht an eine konkrete `instanceId` adressiert und erreicht genau diese Instanz, endet das Routing dort. Bei Broadcasts und reinen `appId`-Targets wird dagegen weitergeroutet, weil in anderen Bus-Segmenten weitere passende Empfänger existieren können.

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

Das Persistent Log beobachtet ausschließlich öffentliche Nachrichten, die der lokalen Bus-Instanz fachlich zugestellt wurden, und schreibt ausgewählte Topics in IndexedDB. Ein Target für eine andere `instanceId` wird daher nicht lokal protokolliert.

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

Eine `BusConnection` stellt neben `connected` ein `closed`-Promise bereit. Es wird erfüllt, wenn die Verbindung lokal geschlossen wird oder der entfernte `MessagePort` entkoppelt wird. Dadurch kann eine Anwendung beispielsweise auf das Schließen oder Navigieren eines Viewer-Fensters reagieren.

Ein automatisches Reconnect gehört bewusst nicht in den Core. Die Anwendung entscheidet selbst, ob und wann eine neue Verbindung sinnvoll ist. Damit bleibt der Lifecycle beobachtbar, ohne einen zusätzlichen Heartbeat- oder Reconnect-Mechanismus in die Bibliothek einzubauen.

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
