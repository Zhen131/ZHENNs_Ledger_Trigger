// Short forms of addresses and hashes, for display.

/** `0xf39F…2266`: the first 6 and the last 4 characters. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** `0x1a2b…9f0e`: the first 6 and the last 4 characters of a hash. */
export function shortHash(hash: string): string {
  return shortAddress(hash);
}

/** Whole seconds from `then` to `now` (both Unix seconds), never below 0. */
export function secondsBetween(then: bigint, now: bigint): bigint {
  return now > then ? now - then : 0n;
}
