// The page talks to one node only: a node on this computer. These rules
// decide which node URLs count as "on this computer" (a loopback address).

/** The node the page reads from unless the address bar names another. */
export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";

/** The only host names accepted: the three ways of writing this computer. */
export const LOOPBACK_HOSTS: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "[::1]",
];

/**
 * True when `text` is an http or https URL whose host is exactly one of
 * LOOPBACK_HOSTS, with no user name or password before the host.
 */
export function isLoopbackUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return LOOPBACK_HOSTS.includes(url.hostname);
}

export type RpcChoice =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly message: string };

/**
 * The node URL to use, from the query string of the page's address (for
 * example `?rpc=http://localhost:8545`): DEFAULT_RPC_URL when `rpc` is not
 * given, the given URL when it is a loopback URL, and a refusal otherwise.
 */
export function rpcUrlFrom(search: string): RpcChoice {
  const given = new URLSearchParams(search).get("rpc");
  if (given === null || given.trim() === "") {
    return { ok: true, url: DEFAULT_RPC_URL };
  }
  const url = given.trim();
  if (isLoopbackUrl(url)) return { ok: true, url };
  return {
    ok: false,
    message:
      "The rpc setting in the address bar is not a node on this computer. Only 127.0.0.1, localhost and [::1] are accepted.",
  };
}
