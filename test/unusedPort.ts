// Finds a local TCP port that nothing listens on, for tests that need a node
// URL that cannot be reached. This file holds no tests.

import { createServer } from "node:net";

/** A port on 127.0.0.1 that was free a moment ago and is closed again. */
export function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("the server reported no port"));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}
