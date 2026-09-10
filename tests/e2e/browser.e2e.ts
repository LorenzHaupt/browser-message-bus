import { expect, test } from "@playwright/test";

// E2E: Zwei echte Seiten desselben Origins kommunizieren über den nativen BroadcastChannel.
test("communicates between two real same-origin tabs through BroadcastChannel", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto("http://127.0.0.1:4173/tests/e2e/fixtures/host.html"),
    second.goto("http://127.0.0.1:4173/tests/e2e/fixtures/host.html")
  ]);

  const channel = `e2e-${Date.now()}-${Math.random()}`;
  await first.waitForFunction(() => Boolean((window as any).BMB));
  await second.waitForFunction(() => Boolean((window as any).BMB));

  await first.evaluate(channelName => {
    const { createMessageBus } = (window as any).BMB;
    (window as any).bus = createMessageBus({ channel: channelName, instanceId: "first" });
    (window as any).received = [];
    (window as any).bus.subscribe("ping", (payload: unknown) => (window as any).received.push(payload));
  }, channel);

  await second.evaluate(channelName => {
    const { createMessageBus } = (window as any).BMB;
    (window as any).bus = createMessageBus({ channel: channelName, instanceId: "second" });
    (window as any).bus.publish("ping", { value: 42 });
  }, channel);

  await expect.poll(() => first.evaluate(() => (window as any).received.length)).toBe(1);
  expect(await first.evaluate(() => (window as any).received[0])).toEqual({ value: 42 });
});

// E2E: Unterschiedliche Ports erzeugen zwei Origins; der Handshake muss einen echten MessagePort übertragen.
test("bridges a real cross-origin iframe with an explicit MessagePort connection", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/tests/e2e/fixtures/host.html");
  await page.waitForFunction(() => Boolean((window as any).BMB));

  const child = page.frames().find(frame => frame.url().startsWith("http://127.0.0.1:4174/"));
  if (!child) throw new Error("Child frame not found");
  await child.waitForFunction(() => Boolean((window as any).BMB));

  const channel = `bridge-${Date.now()}-${Math.random()}`;

  await page.evaluate(channelName => {
    const { createMessageBus } = (window as any).BMB;
    (window as any).hostBus = createMessageBus({ channel: channelName, appId: "host", instanceId: "host" });
    (window as any).hostReceived = [];
    (window as any).hostBus.subscribe("pong", (payload: unknown) => (window as any).hostReceived.push(payload));
  }, channel);

  await child.evaluate(channelName => {
    const { createMessageBus } = (window as any).BMB;
    (window as any).childBus = createMessageBus({ channel: channelName, appId: "child", instanceId: "child" });
    (window as any).childReceived = [];
    (window as any).childBus.subscribe("ping", (payload: unknown) => (window as any).childReceived.push(payload));
  }, channel);

  const accepting = child.evaluate(async () => {
    const { windowBridge } = (window as any).BMB;
    (window as any).childConnection = await (window as any).childBus.connect(
      windowBridge({
        targetWindow: window.parent,
        origin: "http://127.0.0.1:4173",
        mode: "accept"
      })
    );
    return (window as any).childConnection.remote.instanceId;
  });

  const hostRemote = await page.evaluate(async () => {
    const { iframeBridge } = (window as any).BMB;
    const iframe = document.getElementById("child") as HTMLIFrameElement;
    (window as any).hostConnection = await (window as any).hostBus.connect(
      iframeBridge({
        iframe,
        origin: "http://127.0.0.1:4174"
      })
    );
    return (window as any).hostConnection.remote.instanceId;
  });

  expect(hostRemote).toBe("child");
  expect(await accepting).toBe("host");

  await page.evaluate(() => {
    (window as any).hostBus.publish("ping", { value: "from-host" }, { target: { instanceId: "child" } });
  });
  await expect.poll(() => child.evaluate(() => (window as any).childReceived.length)).toBe(1);

  await child.evaluate(() => {
    (window as any).childBus.publish("pong", { value: "from-child" }, { target: { instanceId: "host" } });
  });
  await expect.poll(() => page.evaluate(() => (window as any).hostReceived.length)).toBe(1);
});

// E2E: Dieser Test verwendet die IndexedDB-Implementierung des Browsers statt fake-indexeddb.
test("persists and reads a message with real browser IndexedDB", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/tests/e2e/fixtures/host.html");
  await page.waitForFunction(() => Boolean((window as any).BMB));

  const result = await page.evaluate(async () => {
    const { createMessageBus, persistentLog } = (window as any).BMB;
    const id = `${Date.now()}-${Math.random()}`;
    const bus = createMessageBus({ channel: `log-${id}` });
    const log = bus.use(persistentLog({ databaseName: `log-db-${id}`, maxEntries: 10, maxAgeMs: 60_000 }));
    await log.ready();
    bus.publish("event", { value: 99 });
    await log.flush();
    const entries = await log.read({ topic: "event" });
    await bus.close();
    return entries.map((entry: any) => entry.payload);
  });

  expect(result).toEqual([{ value: 99 }]);
});
