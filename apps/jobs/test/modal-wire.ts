import { once } from "node:events";
import { createServer, type ServerHttp2Session } from "node:http2";
import { ModalClient } from "modal";

/** Send scrubbed protobuf bytes through the pinned SDK's real response decoders. */
export async function serveModalWire(
  bodyFor: (method: string) => string | undefined,
) {
  const server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => undefined);
    stream.on("end", () => {
      const method = String(headers[":path"]).split("/").at(-1)!;
      const body =
        method === "AuthTokenGet"
          ? Buffer.concat([
              Buffer.from([10, 7]),
              Buffer.from("fixture"),
            ]).toString("base64")
          : bodyFor(method);
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.once("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": body === undefined ? "12" : "0" }),
      );
      if (body === undefined) {
        stream.end();
        return;
      }
      const message = Buffer.from(body, "base64");
      const prefix = Buffer.alloc(5);
      prefix.writeUInt32BE(message.length, 1);
      stream.end(Buffer.concat([prefix, message]));
    });
    stream.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing Modal fixture server address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const previous = process.env.MODAL_SERVER_URL;
  const previousConfig = process.env.MODAL_CONFIG_PATH;
  let client: ModalClient;
  try {
    process.env.MODAL_SERVER_URL = endpoint;
    process.env.MODAL_CONFIG_PATH = "/dev/null";
    client = new ModalClient({
      environment: "main",
      tokenId: "fixture",
      tokenSecret: "offline",
      timeoutMs: 3000,
      maxRetries: 0,
      logLevel: "error",
    });
    if (client.profile.serverUrl !== endpoint) {
      client.close();
      throw new Error("Modal fixture must use the loopback server");
    }
  } catch (error) {
    server.close();
    throw error;
  } finally {
    if (previous === undefined) delete process.env.MODAL_SERVER_URL;
    else process.env.MODAL_SERVER_URL = previous;
    if (previousConfig === undefined) delete process.env.MODAL_CONFIG_PATH;
    else process.env.MODAL_CONFIG_PATH = previousConfig;
  }
  return {
    api: client.cpClient,
    async close() {
      client.close();
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
