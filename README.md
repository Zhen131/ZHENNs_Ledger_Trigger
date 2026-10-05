# Ledger Trigger

Ledger Trigger is a course project: on-chain limit orders to buy ETH with USDC. A user places an order that says "when ETH costs this much or less, spend this much USDC on it and send the ETH to this address". Placing the order moves no money. When the price falls to the target, a small program on the user's computer, the keeper, asks the contract to fill the order; the contract then checks the price, the caller and the money itself, takes the USDC from the user's wallet, swaps it for ETH and sends the ETH to the address in the order. The contract is written in Solidity, and the tests, the keeper and the scripts in TypeScript, with Hardhat 3 and viem. The tests run on a local Hardhat chain and need no network and no key.

## What the system guarantees

The contract `LedgerTrigger` promises five things. [docs/contract-spec.md](docs/contract-spec.md) explains each one, and how the code keeps it.

1. **Three functions change state: place, fill and cancel an order.** Placing moves no money. Only a fill takes USDC from the owner's wallet, swaps it for ETH and sends the ETH to the recipient. The owner can cancel an open order at any time, expired or not.
2. **Three roles: owner, executor and recipient. There is no admin.** Only the owner can cancel an order. Only the owner and the executor named in that order can fill it. Nobody can pause the contract, upgrade it, change its settings or take money out of it.
3. **Every fill gives two hard guarantees: the price paid is never above the target price, and the ETH received is never less than the price feed's price gives, minus the allowed slippage.** Both minimums are whole numbers rounded down, so each can fall short of the exact value by less than one wei, the smallest unit of ETH; that remainder is not counted.
4. **An order is stored as `Open`, `Filled` or `Cancelled`. `Expired` is never stored; it is worked out from the time.** `Filled` and `Cancelled` are final. An expired order can no longer be filled; its owner can only cancel it, which frees its slot.
5. **The contract keeps no money.** Its USDC and ETH balances are the same before and after every fill.

## Where it stands

- Everything in this repository is built and runs on a local Hardhat chain: the contracts and their tests, the keeper, a demo of six scenarios, and the deployment and operation scripts. `npm run check` runs every check.
- **Nothing has been deployed to a public network yet.** The scripts can deploy to the Sepolia test network, and [docs/testnet-guide.md](docs/testnet-guide.md) gives the steps, but that needs a wallet with test ETH and a node service, and it has not been done.
- No license has been chosen yet.

## What is where

| Path                          | What it holds                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/LedgerTrigger.sol` | The order contract                                                                                                                                             |
| `contracts/interfaces/`       | `IPriceFeed` (the two Chainlink price feed functions the contract reads) and `ISwapVenue` (swap USDC for ETH)                                                  |
| `contracts/mocks/`            | Stand-ins for local use: `MockUSDC`, a test token anyone can mint; `MockPriceFeed`, whose price anyone can set; `MockSwapVenue`, which swaps at the feed price |
| `contracts/hostile/`          | Four misbehaving contracts used only by the tests, such as a recipient that calls back into `fillOrder`                                                        |
| `test/`                       | The tests, in TypeScript, run by Node's test runner with viem                                                                                                  |
| `keeper/`                     | The keeper                                                                                                                                                     |
| `scripts/`                    | The checks, the demo, the deployment and operation scripts, the confirmation gate and the network guard                                                        |
| `scripts/cli/`                | The entry points that the `npm run` commands start                                                                                                             |
| `docs/`                       | The contract specification, the test matrix and the Sepolia guide                                                                                              |
| `hardhat.config.ts`           | Hardhat's configuration: the Solidity version, the network guard and the `sepolia` network                                                                     |

## Documents

- [docs/contract-spec.md](docs/contract-spec.md): what the contract guarantees and how: roles and permissions, functions, data structures, security rules, the state machine and the test scenarios, then the steps of a fill, the parts around the contract and the design choices.
- [docs/test-matrix.md](docs/test-matrix.md): which tests cover each of the 26 test scenarios, and other important tests.
- [docs/testnet-guide.md](docs/testnet-guide.md): how to deploy on the Sepolia test network, place an order and let the keeper fill it.

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

The `npm run` commands below turn Hardhat's telemetry off by themselves. Before running Hardhat directly (`npx hardhat ...`), turn it off in that terminal first:

```sh
export HARDHAT_DISABLE_TELEMETRY=true
```

## Run the checks

```sh
npm run check
```

This runs seven steps in order and stops at the first one that fails, naming it:

1. `format`: Prettier checks the formatting of Solidity, TypeScript, JSON and Markdown files.
2. `lint`: Solhint checks the contracts, including that every contract, function, event and public value has its documentation comment; warnings count as failures.
3. `compile`: Hardhat compiles the contracts with the pinned Solidity version (0.8.34).
4. `types`: the TypeScript compiler type-checks the configuration, the scripts, the keeper and the tests.
5. `test`: Hardhat runs every test in `test/`; contract tests get a fresh in-process chain each time. Two guards keep the tests on Hardhat's local chain (chain ID 31337). First, `npx hardhat test` and `npm run check` stop before any test runs when another network is selected (`scripts/testNetworkGuard.ts`). Second, a network guard (`scripts/networkGuard.ts`, which `hardhat.config.ts` loads as a Hardhat network hook) sees every request that goes through one of Hardhat's network connections, however the code was started (`npx hardhat test`, `npm run check`, `node --test`, `node <file>`, `npx hardhat run <file>`, with `--network` or the `HARDHAT_NETWORK` environment variable). On a connection to any other chain it lets plain reads through and refuses every request that would write, such as sending a transaction, deploying or signing, with an error that says why. The one exception is a connection that a deployment or operation script has opened by passing its confirmation gate (see "The confirmation gate" below). The guard covers exactly that: requests that would write, sent through Hardhat's connections, to a chain that is not local. It does not see programs that talk to a node without Hardhat, such as the keeper.
6. `scenarios`: `scripts/scenarios.ts` checks that each of the 26 test scenarios, S01 to S26, has at least one test whose own title starts with its number, and that [docs/test-matrix.md](docs/test-matrix.md) matches the tests: a row for each scenario, every title it names is a real test in the file it names, and every scenario test is listed. Run `node scripts/scenarios.ts --list` to see which tests cover which scenario.
7. `hygiene`: `scripts/hygiene.ts` scans the repository files and commit history for things that must never be committed, such as key material, files whose names start with `.env`, or forbidden contract patterns.

The very first run downloads the Solidity compiler once. After that the checks need no network access, and Hardhat runs with telemetry disabled.

To fix formatting automatically:

```sh
npm run format
```

## Run the demo

```sh
npm run demo
```

The demo starts a fresh Hardhat chain inside the process, deploys the four contracts and plays six of the test scenarios, two that must succeed and four that must be rejected:

| ID  | Scenario                      | Expected                                                                                                |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| S01 | Normal fill, by the keeper    | `Open -> Filled`; the ETH goes to the recipient, not to the caller                                      |
| S03 | The owner cancels             | `Open -> Cancelled`                                                                                     |
| S04 | A stranger fills              | rejected with `NotOrderOwnerOrExecutor`                                                                 |
| S06 | The price is above the target | rejected with `PriceAboveTarget`; the order stays `Open`                                                |
| S07 | The same order filled twice   | the first fill succeeds; the second is rejected with `OrderNotOpen`                                     |
| S15 | The allowance is too small    | rejected with `InsufficientAllowance`; the order stays `Open`; it fills once the allowance is topped up |

In S01 the keeper's own round does the fill (`runOnce` from `keeper/`); the other five call the contract directly. For each scenario the demo prints what it did, what was expected and what actually happened, read from the chain: statuses from `statusOf`, the name of the error a rejected call reverted with, and balance changes. Then it prints a summary table. It exits with 0 when all six pass and with 1 otherwise. It needs no network and no key, and it refuses to run on any chain other than Hardhat's local chain.
