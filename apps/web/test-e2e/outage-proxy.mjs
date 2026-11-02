// Loopback TCP forwarder in front of a storage fixture. The app talks to the
// fixture through it, so a provider outage is simulated by refusing traffic
// here without touching the shared fixture (Docker is disabled under local CI).
import {
  connect as tcpConnect,
  createServer as createTcpServer,
} from "node:net";

export async function startOutageProxy(targetUrl) {
  const target = new URL(targetUrl);
  const sockets = new Set();
  const state = { down: false };
  const server = createTcpServer((client) => {
    if (state.down) return client.destroy();
    const upstream = tcpConnect(Number(target.port), target.hostname);
    for (const sock of [client, upstream]) {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("error", () => sock.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    down() {
      state.down = true;
      for (const sock of sockets) sock.destroy();
    },
    up() {
      state.down = false;
    },
    stop() {
      for (const sock of sockets) sock.destroy();
      server.close();
    },
  };
}
