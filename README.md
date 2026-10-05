# Ledger Trigger

Ledger Trigger is a course project that aims to provide on-chain limit orders: a user places an order to buy ETH with USDC once the price reaches a target, an off-chain keeper submits the fill when it does, and the contract itself checks the price. The tests run on a local Hardhat chain and need no network and no key. The keeper needs a node URL and a private key, which it takes from environment variables; neither is ever stored in this repository.

## Status

Work in progress. What exists today:

- a Hardhat 3 project with TypeScript tests (Node test runner and viem);
- `MockUSDC`, a 6-decimal test token that anyone can mint to themselves, with its tests;
- two interfaces the order contract uses: `IPriceFeed` (the two Chainlink price feed functions it reads) and `ISwapVenue` (swap USDC for ETH);
- `MockPriceFeed`, a price feed whose price and update time anyone can set, and `MockSwapVenue`, which swaps USDC for ETH at the feed price minus a fee fixed at deployment, both with their tests;
- `LedgerTrigger`, the order contract, with its tests. Anyone can place an order (`createOrder`), only its owner can cancel it (`cancelOrder`), and anyone can read an order, its status and each owner's open orders. Placing and cancelling move no tokens and no ETH. An order whose expiry has passed is reported as `Expired` but keeps its owner's open-order slot until cancelled. Its seven deployment parameters can never change;
- filling an order (`fillOrder`): only the order's owner or the executor named in it can fill it, and only while it is open, not expired, the price feed reports a fresh price at or below the target, and the owner's USDC balance and allowance cover the order. The fill takes the order amount from the owner, swaps it for ETH at the swap venue and sends all of that ETH to the order's recipient. It is rejected unless the swap brings in at least a minimum of ETH that keeps the price paid at or below the target and within the allowed slippage of the feed price, counted by the contract's own balances. The contract keeps no USDC and no ETH, and accepts ETH from the swap venue only;
- `canFill`, which anyone can call to learn whether an order can be filled right now and, if not, the first reason why;
- four hostile contracts in `contracts/hostile/`, used only by the tests: a recipient that calls back into `fillOrder`, an order owner and recipient that calls `cancelOrder` while it is being paid, a recipient that refuses ETH, and a swap venue that short-changes;
- tests for each of the order contract's 26 test scenarios (a normal fill, a second fill of the same order, a price that is too old, and so on), numbered S01 to S26 at the start of the test titles;
- the keeper in `keeper/` (below), which fills the orders that name its account as executor once they can be filled, with its tests;
- a demo that plays six of the scenarios on a fresh local chain and prints a table of the results (below);
- deployment and operation scripts for a local chain, ready for the Sepolia test network, which every script that sends transactions reaches only through one confirmation gate (below), with a step-by-step guide for Sepolia in `docs/testnet-guide.md`;
- one command that runs every repository check (below).

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
4. `types`: the TypeScript compiler type-checks the config, the scripts, the keeper and the tests.
5. `test`: Hardhat runs every test in `test/`; contract tests get a fresh local chain each time.
6. `scenarios`: `scripts/scenarios.ts` checks that each of the 26 scenarios, S01 to S26, has at least one test whose own title starts with its number. Run `node scripts/scenarios.ts --list` to see which tests cover which scenario.
7. `hygiene`: `scripts/hygiene.ts` scans the repository files and commit history for things that must never be committed, such as key material, files whose names start with `.env`, or forbidden contract patterns.

The very first run downloads the Solidity compiler once. After that the checks need no network access, and Hardhat runs with telemetry disabled.

To fix formatting automatically:

```sh
npm run format
```

## Run the keeper

The keeper fills the orders that name its account as executor, once they can be filled. It is only a trigger: the contract itself checks the price, the caller and the money. Each round it reads the contract's `OrderCreated` events for its account, and for each open order asks `canFill`, simulates the fill, compares the estimated fee with a cap, and only then sends `fillOrder`. An order that cannot be filled yet, or that someone else filled or cancelled first, is skipped and logged. It stores nothing between rounds.

Build the contracts first: the keeper reads the contract interfaces from Hardhat's build output (`npm run check` builds them too).

```sh
npx hardhat build
```

The keeper takes its settings from environment variables only, and never prints the private key or the node URL:

| Variable                  | Required | Meaning                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEPER_RPC_URL`          | yes      | URL of the node's JSON-RPC endpoint (`http` or `https`, without a user name or password before the host). Node services often put an access key in it, so treat it as a secret. The keeper talks to this node only: it does not follow a contract's request to fetch data from a web address (CCIP-read). |
| `KEEPER_PRIVATE_KEY`      | yes      | Private key of the executor account the keeper sends fills from and pays gas with: 64 hex digits, with or without a leading `0x`.                                                                                                                                                                         |
| `KEEPER_CONTRACT_ADDRESS` | yes      | Address of the deployed `LedgerTrigger` contract.                                                                                                                                                                                                                                                         |
| `KEEPER_FROM_BLOCK`       | yes      | First block to read `OrderCreated` events from, such as the block the contract was deployed in.                                                                                                                                                                                                           |
| `KEEPER_MAX_FEE_WEI`      | yes      | Largest fee, in wei, the keeper may pay for one fill: the estimated gas times the highest gas price the transaction is sent with. A dearer fill is skipped.                                                                                                                                               |
| `KEEPER_INTERVAL_SECONDS` | no       | Seconds to wait between two rounds when the keeper keeps running.                                                                                                                                                                                                                                         |
| `KEEPER_MAX_BLOCK_RANGE`  | no       | Most blocks read in one event request; many node services limit this span.                                                                                                                                                                                                                                |

The defaults of the two optional variables are set in `keeper/config.ts`. Do not keep these variables in a file inside the repository: `.gitignore` ignores every file whose name starts with `.env`, and the hygiene scan fails on one that is committed anyway.

Start it in one of two modes:

```sh
npm run keeper -- --once   # run one round, then exit
npm run keeper             # keep running: a round, a pause, another round, until stopped
```

It logs one line per event to standard output: the time, the order ID, what it did and why. Before its first round it gets ready: it checks the settings, reads the contract interfaces, asks the node for its chain ID and checks that there is contract code at the address. In `--once` mode it exits with code 1 when getting ready fails or when anything in the round was an error, such as a node that could not be reached or that reported an error that is not a contract revert; a skipped order is not an error. While it keeps running, every error, getting ready included, is logged and the next round runs as usual.

## Run the demo

```sh
npm run demo
```

The demo starts a fresh Hardhat chain inside the process, deploys the four contracts and plays six of the order contract's test scenarios, two that must succeed and four that must be rejected:

| ID  | Scenario                      | Expected                                                                                                |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| S01 | Normal fill, by the keeper    | `Open -> Filled`; the ETH goes to the recipient, not to the caller                                      |
| S03 | The owner cancels             | `Open -> Cancelled`                                                                                     |
| S04 | A stranger fills              | rejected with `NotOrderOwnerOrExecutor`                                                                 |
| S06 | The price is above the target | rejected with `PriceAboveTarget`; the order stays `Open`                                                |
| S07 | The same order filled twice   | the first fill succeeds; the second is rejected with `OrderNotOpen`                                     |
| S15 | The allowance is too small    | rejected with `InsufficientAllowance`; the order stays `Open`; it fills once the allowance is topped up |

In S01 the keeper's own round does the fill (`runOnce` from `keeper/`); the other five call the contract directly. For each scenario the demo prints what it did, what was expected and what actually happened, read from the chain: statuses from `statusOf`, the name of the error a rejected call reverted with, and balance changes. Then it prints a summary table. It exits with 0 when all six pass and with 1 otherwise. It needs no network and no key, and it refuses to run on any chain other than Hardhat's local chain.

## Deploy and operate on a local chain

Every script below is a Hardhat script: it runs on the network given with `--network` (`localhost` is the node started by `npx hardhat node`; without `--network` it runs on a fresh in-process chain that is gone when the script ends). Settings come from environment variables only, so nothing in the repository has to be edited. No script prints a private key or a node URL. Each one uses the network's first account: with `npx hardhat node`, Hardhat test account #0.

Start a local node in one terminal and leave it running:

```sh
npx hardhat node
```

In a second terminal:

```sh
npm run deploy:mocks -- --network localhost        # deploy the four contracts
export TRIGGER_CONTRACT_ADDRESS=<LedgerTrigger address it printed>
export TRIGGER_ORDER_USDC=100 TRIGGER_TARGET_PRICE_USD=1900 TRIGGER_EXPIRY_MINUTES=60
export TRIGGER_RECIPIENT_ADDRESS=<an address> TRIGGER_EXECUTOR_ADDRESS=<the keeper's address>
npm run place-order -- --network localhost         # approve and place an order
export TRIGGER_ORDER_ID=1
npm run order-status -- --network localhost        # Open; canFill: PriceAboveTarget
export TRIGGER_PRICE_USD=1900
npm run set-price -- --network localhost           # move the mock price to the target
```

Then run the keeper once against `http://127.0.0.1:8545` with `KEEPER_FROM_BLOCK` set to the block the deployment printed (see "Run the keeper"), and `npm run order-status -- --network localhost` shows `Filled`.

| Command                   | What it does                                                                                                                                                                                                                                                                    | Sends transactions |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `npm run deploy:mocks`    | Deploys `MockUSDC`, `MockPriceFeed`, `MockSwapVenue` (stocked with ETH) and `LedgerTrigger`, and mints mock USDC to the deploying account. Prints every address, the seven parameters read back from the chain with their units, and the block `LedgerTrigger` was deployed in. | yes                |
| `npm run deploy:external` | For a test network: checks the existing USDC token and price feed given by address (contract code, decimals, latest price) before sending anything, then deploys `MockSwapVenue` and `LedgerTrigger` only. Prints the same.                                                     | yes                |
| `npm run place-order`     | Sets the account's USDC allowance for `LedgerTrigger` to its open-order total after this order (`openOrderTotal`), then places the order.                                                                                                                                       | yes                |
| `npm run cancel-order`    | Cancels an order. Only its owner can.                                                                                                                                                                                                                                           | yes                |
| `npm run fund-venue`      | Sends ETH to the swap venue of `LedgerTrigger`, which pays fills out of it.                                                                                                                                                                                                     | yes                |
| `npm run order-status`    | Prints an order, its status now (`statusOf`) and whether it can be filled now (`canFill`) with the reason.                                                                                                                                                                      | no                 |
| `npm run set-price`       | Sets the mock price feed. Hardhat's local chain only.                                                                                                                                                                                                                           | yes                |

### Settings

Amounts are written as people write them (`100`, `12.5`) and turned into whole numbers with the decimals read from the contracts.

| Variable                         | Used by                        | Meaning                                                            | Unit                     | Default             |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------ | ------------------------ | ------------------- |
| `TRIGGER_USDC_ADDRESS`           | `deploy:external`              | The existing USDC token                                            | address                  | required            |
| `TRIGGER_PRICE_FEED_ADDRESS`     | `deploy:external`              | The existing ETH / USD price feed                                  | address                  | required            |
| `TRIGGER_MAX_ORDER_USDC`         | both deploys                   | Largest order (`maxOrderAmount`)                                   | USDC                     | `500`               |
| `TRIGGER_MAX_OPEN_ORDERS`        | both deploys                   | Open orders one owner may have (`maxOpenOrdersPerOwner`)           | whole number             | `5`                 |
| `TRIGGER_MAX_PRICE_AGE_SECONDS`  | both deploys                   | Oldest price that still counts (`maxPriceAge`)                     | seconds                  | `4500` (75 minutes) |
| `TRIGGER_MAX_SLIPPAGE_BPS`       | both deploys                   | Allowed slippage (`maxSlippageBps`)                                | basis points (100 = 1 %) | `100`               |
| `TRIGGER_VENUE_FEE_BPS`          | both deploys                   | Fee of the mock swap venue                                         | basis points             | `0`                 |
| `TRIGGER_MOCK_PRICE_USD`         | `deploy:mocks`                 | First price of the mock feed (8 decimals)                          | USD                      | `2000`              |
| `TRIGGER_MOCK_VENUE_ETH`         | `deploy:mocks`                 | ETH stocked in the mock swap venue                                 | ETH                      | `10`                |
| `TRIGGER_MOCK_DEPLOYER_USDC`     | `deploy:mocks`                 | Mock USDC minted to the deploying account                          | USDC                     | `1000`              |
| `TRIGGER_CONTRACT_ADDRESS`       | every operation                | The deployed `LedgerTrigger`                                       | address                  | required            |
| `TRIGGER_ORDER_USDC`             | `place-order`                  | USDC to spend                                                      | USDC                     | required            |
| `TRIGGER_TARGET_PRICE_USD`       | `place-order`                  | Highest ETH price accepted                                         | USD                      | required            |
| `TRIGGER_EXPIRY_MINUTES`         | `place-order`                  | Validity, counted from the time of the latest block                | whole minutes            | required            |
| `TRIGGER_RECIPIENT_ADDRESS`      | `place-order`                  | Who receives the ETH                                               | address                  | required            |
| `TRIGGER_EXECUTOR_ADDRESS`       | `place-order`                  | Who may fill the order besides its owner, such as the keeper       | address                  | required            |
| `TRIGGER_ORDER_ID`               | `cancel-order`, `order-status` | The order                                                          | whole number             | required            |
| `TRIGGER_FUND_ETH`               | `fund-venue`                   | ETH to send                                                        | ETH                      | required            |
| `TRIGGER_PRICE_USD`              | `set-price`                    | New mock price                                                     | USD                      | required            |
| `TRIGGER_CONFIRM_PUBLIC_NETWORK` | every script that sends        | Confirmation for a chain that is not Hardhat's local chain (below) | the exact sentence       | not set             |

### The confirmation gate

Every script that sends transactions (both deploys, `place-order`, `cancel-order`, `fund-venue`, `set-price` and the demo) first asks the node for its chain ID. On Hardhat's local chain (chain ID 31337) it goes ahead. On any other chain it sends nothing and exits with 1, unless `TRIGGER_CONFIRM_PUBLIC_NETWORK` holds exactly this sentence:

```text
I am sending real transactions to a public network
```

Even then, only the two deploys, `place-order`, `cancel-order` and `fund-venue` go ahead. The demo and `set-price` never run on another chain. The keeper does not pass through this gate: it is a separate program that runs on whichever node its own settings name.

## Sepolia test network

The configuration has a `sepolia` network. Its node URL and private key are Hardhat configuration variables, `TRIGGER_SEPOLIA_RPC_URL` and `TRIGGER_SEPOLIA_PRIVATE_KEY`, read from environment variables of those names or from Hardhat's encrypted keystore; no value is written in the repository. With its chain ID set to 11155111, Hardhat refuses a node that serves another chain. Follow `docs/testnet-guide.md` to deploy and run the demo on Sepolia: which wallets you need, where the keys go and where they never go, each command, and what you should see.
