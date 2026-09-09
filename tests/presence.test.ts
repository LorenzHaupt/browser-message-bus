import { describe, expect, it, vi } from "vitest";
import { createMessageBus } from "../src/index.js";
import { presence } from "../src/presence.js";
import { uniqueChannel, waitFor } from "./helpers.js";

interface Messages {
  noop: undefined;
}

describe("presence extension", () => {
  it("discovers peers and reports leave", async () => {
    const channel = uniqueChannel();
    const a = createMessageBus<Messages>({ channel, appId: "editor" });
    const b = createMessageBus<Messages>({ channel, appId: "viewer" });
    const presenceA = a.use(presence({ heartbeatMs: 20, peerTimeoutMs: 150 }));
    b.use(presence({ heartbeatMs: 20, peerTimeoutMs: 150 }));
    const left = vi.fn();
    presenceA.onLeave(left);

    await waitFor(() => presenceA.peers().some(peer => peer.instanceId === b.instanceId));
    expect(presenceA.peers()).toContainEqual(
      expect.objectContaining({ instanceId: b.instanceId, appId: "viewer" })
    );

    await b.close();
    await waitFor(() => !presenceA.peers().some(peer => peer.instanceId === b.instanceId), 1_000);
    expect(left).toHaveBeenCalledWith(expect.objectContaining({ instanceId: b.instanceId }));

    await a.close();
  });
});
