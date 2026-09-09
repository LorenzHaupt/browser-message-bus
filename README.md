# Browser Message Bus

A lightweight, typed browser message bus for communication within one browser context, across tabs/windows with `BroadcastChannel`, and across explicit cross-origin window relationships through optional bridges.

## Design principles

- **Convention over configuration:** `channel` is the only required option.
- **BroadcastChannel by default:** no bridge listeners, persistence, heartbeats or request/reply machinery unless explicitly enabled.
- **Framework independent:** plain TypeScript/JavaScript; Angular, React and other frameworks are consumers, not dependencies.
- **Typed topics and payloads:** application topics are defined by a TypeScript message map.
- **Exact topics only:** no wildcard/topic hierarchy in the core.
- **Explicit cross-origin bridges:** a bridge must be configured on both sides.
- **Safe defaults:** exact origins, exact `Window` source checks, random handshake nonces, protocol validation, reserved system topics and structured-clone validation.
- **Best-effort delivery:** this is a browser messaging layer, not a durable broker.

## Installation

```bash
npm install
npm run typecheck
npm test
npm run build

# optional real-browser E2E tests
npx playwright install chromium
npm run test:e2e
```

## Core usage

```ts
import { createMessageBus } from "@lorenz/browser-message-bus";

interface Messages {
  "document.open": {
    id: string;
    metadata: {
      title: string;
      tags: string[];
    };
  };
  "viewer.close": undefined;
}

const bus = createMessageBus<Messages>({
  channel: "workspace",
  appId: "viewer" // optional
});

const unsubscribe = bus.subscribe("document.open", (payload, context) => {
  console.log(payload.id);
  console.log(context.source.instanceId);
});

bus.publish("document.open", {
  id: "4711",
  metadata: {
    title: "Example",
    tags: ["demo"]
  }
});

unsubscribe();
await bus.close();
```

`instanceId` is generated automatically for every running bus instance. `appId` is optional and groups instances of the same application type.

## Targeting

Broadcast is the default:

```ts
bus.publish("viewer.close");
```

All instances with an `appId`:

```ts
bus.publish("viewer.close", undefined, {
  target: { appId: "viewer" }
});
```

Exactly one known instance:

```ts
bus.publish("viewer.close", undefined, {
  target: { instanceId: viewerInstanceId }
});
```

An instance ID becomes known through an incoming message (`context.source.instanceId`), a direct bridge handshake (`connection.remote.instanceId`) or the optional presence extension.

## Presence (optional)

```ts
import { presence } from "@lorenz/browser-message-bus/presence";

const peers = bus.use(presence());

console.log(peers.peers());

peers.onJoin(peer => console.log("joined", peer));
peers.onLeave(peer => console.log("left", peer));
```

Presence is deliberately not part of the default bus. It uses a small announce/query/heartbeat protocol and is best-effort because browsers may throttle background tabs.

## Request / reply (optional)

```ts
import { requestReply } from "@lorenz/browser-message-bus/request-reply";

interface Requests {
  "settings.get": {
    request: { userId: string };
    response: { theme: "light" | "dark" };
  };
}

const requests = bus.use(requestReply<Requests>());

requests.handle("settings.get", async request => {
  return { theme: "dark" };
});

const result = await requests.request(
  "settings.get",
  { userId: "123" },
  { target: { instanceId: anotherInstanceId } }
);
```

If a request can reach multiple handlers, the first valid response wins. For deterministic request/reply, target a concrete instance.

## Cross-origin bridge (optional and explicit)

`BroadcastChannel` is always the default transport. A bridge is only active when `connect()` is called.

Host with an iframe:

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

Inside the cross-origin iframe:

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

For a popup or another known `Window`, use `windowBridge()` with `mode: "connect"` on one side and `mode: "accept"` on the other.

The handshake uses `window.postMessage()` only to establish a dedicated `MessageChannel`. Normal traffic then uses the transferred `MessagePort`.

### Bridge security

The bridge:

- rejects `"*"` and opaque `"null"` origins;
- requires an exact HTTP(S) origin;
- checks both `event.origin` and the exact `event.source` window;
- treats `BroadcastChannel` as a transport, not an authentication boundary (a channel name is not a secret);
- checks channel and protocol version;
- uses random handshake nonces;
- validates transferred envelopes;
- can optionally restrict public topics with `allowedTopics`.

TypeScript types do **not** validate untrusted runtime payload shapes. Applications that treat cross-origin payloads as untrusted data should validate domain payloads at the application boundary (for example with their schema validator of choice).

## Persistent log (optional)

```ts
import { persistentLog } from "@lorenz/browser-message-bus/persistent-log";

const log = bus.use(
  persistentLog({
    topics: ["document.open"],
    maxAgeMs: 7 * 24 * 60 * 60_000,
    maxEntries: 10_000,
    requestPersistentStorage: true
  })
);

await log.ready();

const entries = await log.read({
  topic: "document.open",
  order: "desc",
  limit: 100
});

await log.flush();
```

The log is stored in IndexedDB. Records use `messageId` as their key, so the same message observed by multiple same-origin tabs is idempotent in a shared database.

The persistent log is **not an audit/security log** and is not encrypted by the library. Same-origin script with access to the page can also access IndexedDB. Persist only data appropriate for browser-side storage.

## Delivery semantics

- Local publish plus BroadcastChannel is active by default.
- Messages are broadcast unless `target` is set.
- A `messageId` is generated for every message.
- Duplicate message IDs are processed at most once by a running bus instance.
- Messages may be forwarded through explicit bridges; hop count prevents routing loops.
- There is no exactly-once, offline queue or automatic replay guarantee.
- A subscriber is isolated from other subscribers; a slow/throwing handler does not block another subscription.
- Browser transport ordering is preserved where the browser transport guarantees it; there is no global ordering across multiple senders/routes.

## What is intentionally not included

- wildcard/topic hierarchy;
- automatic bridge discovery;
- diagnostics/metrics framework;
- broker/queue semantics;
- leader election;
- distributed transactions;
- exactly-once delivery;
- framework dependencies.
