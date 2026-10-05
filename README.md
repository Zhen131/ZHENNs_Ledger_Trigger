# Ledger Trigger

Ledger Trigger is a course project that aims to provide on-chain limit orders: a user places an order to buy ETH with USDC once the price reaches a target, an off-chain keeper submits the fill when it does, and the contract itself checks the price. Today everything runs on a local Hardhat chain; nothing in this repository talks to a public network or needs a key.

## Status

Early skeleton. What exists today:

- a Hardhat 3 project with TypeScript tests (Node test runner and viem);
- `MockUSDC`, a 6-decimal test token that anyone can mint to themselves, with its tests;
- two interfaces the order contract will use: `IPriceFeed` (the two Chainlink price feed functions it reads) and `ISwapVenue` (swap USDC for ETH);
- `MockPriceFeed`, a price feed whose price and update time anyone can set, and `MockSwapVenue`, which swaps USDC for ETH at the feed price minus a fee fixed at deployment, both with their tests;
- one command that runs every repository check (below).

The order contract, the keeper and the demo are not written yet.

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

This runs six steps in order and stops at the first one that fails, naming it:

1. `format`: Prettier checks the formatting of Solidity, TypeScript, JSON and Markdown files.
2. `lint`: Solhint checks the contracts; warnings count as failures.
3. `compile`: Hardhat compiles the contracts with the pinned Solidity version (0.8.34).
4. `types`: the TypeScript compiler type-checks the config, scripts and tests.
5. `test`: Hardhat runs every test in `test/`; contract tests get a fresh local chain each time.
6. `hygiene`: `scripts/hygiene.ts` scans the repository files and commit history for things that must never be committed, such as key material or forbidden contract patterns.

The very first run downloads the Solidity compiler once. After that the checks need no network access, and Hardhat runs with telemetry disabled.

To fix formatting automatically:

```sh
npm run format
```
