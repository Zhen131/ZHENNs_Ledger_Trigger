# Ledger Trigger

Ledger Trigger is a course project that aims to provide on-chain limit orders: a user places an order to buy ETH with USDC once the price reaches a target, an off-chain keeper submits the fill when it does, and the contract itself checks the price. Today everything runs on a local Hardhat chain; nothing in this repository talks to a public network or needs a key.

## Status

Work in progress. What exists today:

- a Hardhat 3 project with TypeScript tests (Node test runner and viem);
- `MockUSDC`, a 6-decimal test token that anyone can mint to themselves, with its tests;
- two interfaces the order contract uses: `IPriceFeed` (the two Chainlink price feed functions it reads) and `ISwapVenue` (swap USDC for ETH);
- `MockPriceFeed`, a price feed whose price and update time anyone can set, and `MockSwapVenue`, which swaps USDC for ETH at the feed price minus a fee fixed at deployment, both with their tests;
- `LedgerTrigger`, the order contract, with its tests. Anyone can place an order (`createOrder`), only its owner can cancel it (`cancelOrder`), and anyone can read an order, its status and each owner's open orders. Placing and cancelling move no tokens and no ETH. An order whose expiry has passed is reported as `Expired` but keeps its owner's open-order slot until cancelled. Its seven deployment parameters can never change;
- filling an order (`fillOrder`): only the order's owner or the executor named in it can fill it, and only while it is open, not expired, the price feed reports a fresh price at or below the target, and the owner's USDC balance and allowance cover the order. The fill takes the order amount from the owner, swaps it for ETH at the swap venue and sends all of that ETH to the order's recipient. It is rejected unless the swap brings in at least a minimum of ETH that keeps the price paid at or below the target and within the allowed slippage of the feed price, counted by the contract's own balances. The contract keeps no USDC and no ETH, and accepts ETH from the swap venue only;
- `canFill`, which anyone can call to learn whether an order can be filled right now and, if not, the first reason why;
- three hostile contracts in `contracts/hostile/`, used only by the tests: a recipient that calls back into `fillOrder`, a recipient that refuses ETH, and a swap venue that short-changes;
- tests for each of the order contract's 26 test scenarios (a normal fill, a second fill of the same order, a price that is too old, and so on), numbered S01 to S26 at the start of the test titles;
- one command that runs every repository check (below).

The keeper and the demo are not written yet.

## Requirements

- Node.js 22.18 or newer, which can run TypeScript files directly. Only Node.js 25.9 has been tested.
- npm (comes with Node.js).
- Git.

## Set up from scratch

```sh
git clone <repository-url> ledger-trigger
cd ledger-trigger
npm ci
```

`npm ci` installs the exact package versions recorded in `package-lock.json`.

## Run the checks

```sh
npm run check
```

This runs seven steps in order and stops at the first one that fails, naming it:

1. `format`: Prettier checks the formatting of Solidity, TypeScript, JSON and Markdown files.
2. `lint`: Solhint checks the contracts; warnings count as failures.
3. `compile`: Hardhat compiles the contracts with the pinned Solidity version (0.8.34).
4. `types`: the TypeScript compiler type-checks the config, scripts and tests.
5. `test`: Hardhat runs every test in `test/`; contract tests get a fresh local chain each time.
6. `scenarios`: `scripts/scenarios.ts` checks that each of the 26 scenarios, S01 to S26, has at least one test whose own title starts with its number. Run `node scripts/scenarios.ts --list` to see which tests cover which scenario.
7. `hygiene`: `scripts/hygiene.ts` scans the repository files and commit history for things that must never be committed, such as key material or forbidden contract patterns.

The very first run downloads the Solidity compiler once. After that the checks need no network access, and Hardhat runs with telemetry disabled.

To fix formatting automatically:

```sh
npm run format
```
