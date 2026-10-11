// The three figures at the top: the ETH / USD price, my USDC (balance and
// allowance to the contract) and the recipient's ETH balance. A refresh only
// changes the text that changed, so nothing flickers or goes blank.

import { getAddress, isAddress, type Address } from "viem";

import { readPrice, readUsdc } from "./chain.ts";
import { byId, setText } from "./dom.ts";
import { formatAmount, formatFixed } from "./lib/amounts.ts";
import { secondsBetween, shortAddress } from "./lib/format.ts";
import type { Page } from "./page.ts";

const ETH_DECIMALS = 18;
const ETH_PLACES = 6;
const RISE_MS = 1500;

let lastEth: { readonly address: Address; readonly wei: bigint } | undefined;

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/** The recipient typed into the order form, if it is an address. */
export function formRecipient(): Address | undefined {
  const text = byId<HTMLInputElement>("order-recipient").value.trim();
  return isAddress(text, { strict: false }) ? getAddress(text) : undefined;
}

function rise(element: HTMLElement): void {
  element.classList.add("rise");
  window.setTimeout(() => element.classList.remove("rise"), RISE_MS);
}

/** Reads and shows the price. */
async function refreshPrice(page: Page): Promise<void> {
  const trigger = page.trigger;
  if (trigger === undefined) return;
  const { price, updatedAt } = await readPrice(page.reader, trigger);
  setText(byId("metric-price"), formatFixed(price, trigger.decimals.price, 2));
  setText(
    byId("metric-price-note"),
    `updated ${secondsBetween(updatedAt, nowSeconds())} s ago`,
  );
}

/** Reads and shows my USDC balance and allowance. */
async function refreshMyUsdc(page: Page): Promise<void> {
  const trigger = page.trigger;
  const me = page.session.account;
  if (trigger === undefined || me === undefined) {
    setText(byId("metric-usdc"), "—");
    setText(
      byId("metric-usdc-note"),
      page.wallet === undefined
        ? "No wallet found in this browser"
        : "Connect a wallet to see it",
    );
    return;
  }
  const { balance, allowance } = await readUsdc(page.reader, trigger, me);
  setText(byId("metric-usdc"), formatAmount(balance, trigger.decimals.usdc));
  setText(
    byId("metric-usdc-note"),
    `allowance to the contract ${formatAmount(allowance, trigger.decimals.usdc)}`,
  );
}

/** Reads and shows the recipient's ETH; marks a rise. */
async function refreshRecipient(page: Page): Promise<void> {
  const value = byId("metric-eth");
  const recipient = formRecipient();
  if (recipient === undefined) {
    lastEth = undefined;
    setText(value, "—");
    setText(byId("metric-eth-note"), "Enter a recipient in the order form");
    return;
  }
  const wei = await page.reader.getBalance({ address: recipient });
  if (lastEth?.address === recipient && wei > lastEth.wei) rise(value);
  lastEth = { address: recipient, wei };
  setText(value, formatFixed(wei, ETH_DECIMALS, ETH_PLACES));
  setText(byId("metric-eth-note"), shortAddress(recipient));
}

/** Refreshes all three figures; one that cannot be read keeps its old text. */
export async function refreshMetrics(page: Page): Promise<void> {
  await Promise.allSettled([
    refreshPrice(page),
    refreshMyUsdc(page),
    refreshRecipient(page),
  ]);
}

/** Clears my USDC, after the account changed. */
export function resetMyBalances(): void {
  setText(byId("metric-usdc"), "—");
}

/** Clears all three figures, while no contract is loaded. */
export function resetMetrics(): void {
  lastEth = undefined;
  setText(byId("metric-price"), "—");
  setText(byId("metric-price-note"), "Load the contract to read the price");
  resetMyBalances();
  setText(byId("metric-usdc-note"), "Load the contract to see it");
  setText(byId("metric-eth"), "—");
  setText(byId("metric-eth-note"), "Load the contract to see it");
}
