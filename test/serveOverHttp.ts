// Serves a test chain's JSON-RPC over HTTP on 127.0.0.1, so that a keeper
// started as a separate process can reach the in-process Hardhat chain by URL.
// It listens on a free local port only while a test needs it. This file holds
// no tests.

import { createServer } from "node:http";

type Request = (args: {
  readonly method: string;
  readonly params?: unknown;
}) => Promise<unknown>;

type Call = {
  readonly id?: unknown;
  readonly method: string;
  readonly params?: unknown;
};

/** The JSON-RPC error fields of a thrown error, as far as they can be found. */
function rpcError(error: unknown) {
  let code = -32603;
  let data: unknown;
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if ("code" in current && typeof current.code === "number") {
      code = current.code;
    }
    if (data === undefined && "data" in current) data = current.data;
    current = current.cause;
  }
  return { code, message: "request failed", data };
}

/**
 * Serves `request` over HTTP. Returns the URL with `path` added to it (for
 * example a made-up key, as a node service URL would carry) and a function
 * that stops the server.
 */
export async function serveOverHttp(request: Request, path = "") {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const answer = async (call: Call) => {
        try {
          const result = await request({
            method: call.method,
            params: call.params,
          });
          return { jsonrpc: "2.0", id: call.id, result };
        } catch (error) {
          return { jsonrpc: "2.0", id: call.id, error: rpcError(error) };
        }
      };
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        Call | Call[];
      void (
        Array.isArray(body) ? Promise.all(body.map(answer)) : answer(body)
      ).then((reply) => {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(reply));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server reported no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
