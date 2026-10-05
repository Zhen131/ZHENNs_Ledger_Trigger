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

## Deploy and operate on a local chain

The deployment and operation commands are Hardhat scripts: each runs on the network given with `--network`. `localhost` is a Hardhat node running on this computer; without `--network`, a script runs on a fresh in-process chain that is gone when the script ends. Settings come from environment variables only, so nothing in the repository has to be edited. No script prints a private key or a node URL. Each one sends from the network's first account: on a Hardhat node, test account #0.

This walk-through deploys everything on a local node, places an order, moves the mock price to the target and lets the keeper fill the order.

**1. Start a local node.** Open a second terminal window in the repository folder, start a Hardhat node there and leave it running:

```sh
export HARDHAT_DISABLE_TELEMETRY=true
npx hardhat node
```

It prints twenty test accounts, each with its address and private key. These accounts and keys are the same on every computer and are public: never send real funds to them. Here account #0 deploys and places the order, account #1 is the keeper's account (the executor), and account #2 receives the ETH.

**2. Deploy.** Back in the first terminal, in the repository folder:

```sh
export HARDHAT_DISABLE_TELEMETRY=true
npx hardhat build
npm run deploy:mocks -- --network localhost
```

It deploys the four contracts, mints mock USDC to account #0, and prints every address, the seven parameters read back from the chain, and the block `LedgerTrigger` was deployed in.

**3. Place an order** of 100 USDC with a target price of 1900 USD, valid for 60 minutes. Replace each part in angle brackets with the value from step 1 or 2:

```sh
export TRIGGER_CONTRACT_ADDRESS=<LedgerTrigger address printed in step 2>
export TRIGGER_ORDER_USDC=100 TRIGGER_TARGET_PRICE_USD=1900 TRIGGER_EXPIRY_MINUTES=60
export TRIGGER_RECIPIENT_ADDRESS=<address of account 2> TRIGGER_EXECUTOR_ADDRESS=<address of account 1>
npm run place-order -- --network localhost
export TRIGGER_ORDER_ID=1
npm run order-status -- --network localhost
```

`place-order` sets the USDC allowance first, then places the order. `order-status` shows the order as `Open`, and `canFill` reports `PriceAboveTarget`: the mock price is still 2000 USD.

**4. Move the mock price to the target:**

```sh
export TRIGGER_PRICE_USD=1900
npm run set-price -- --network localhost
```

**5. Let the keeper fill it**, in a single round (`--once`). It sends the fill from account #1; "Run the keeper" below explains each variable.

```sh
export KEEPER_RPC_URL=http://127.0.0.1:8545
export KEEPER_PRIVATE_KEY=<private key of account 1>
export KEEPER_CONTRACT_ADDRESS=$TRIGGER_CONTRACT_ADDRESS
export KEEPER_FROM_BLOCK=<block number printed in step 2>
export KEEPER_MAX_FEE_WEI=5000000000000000
npm run keeper -- --once
npm run order-status -- --network localhost
```

The keeper logs `action=filled` for order 1, and `order-status` now shows it as `Filled`. Stop the node with Ctrl+C when you are done; everything on it is gone.

### Commands

| Command                   | What it does                                                                                                                                                                                                                                                                                                | Sends transactions |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `npm run deploy:mocks`    | Deploys `MockUSDC`, `MockPriceFeed`, `MockSwapVenue` (stocked with ETH) and `LedgerTrigger`, and mints mock USDC to the deploying account. Hardhat's local chain only. Prints every address, the seven parameters read back from the chain with their units, and the block `LedgerTrigger` was deployed in. | yes                |
| `npm run deploy:external` | For a test network: checks the existing USDC token and price feed given by address (contract code, decimals, latest price) before sending anything, then deploys `MockSwapVenue` and `LedgerTrigger` only. Prints the same.                                                                                 | yes                |
| `npm run place-order`     | Sets the account's USDC allowance for `LedgerTrigger` to its open-order total after this order (`openOrderTotal`), then places the order.                                                                                                                                                                   | yes                |
| `npm run cancel-order`    | Cancels an order. Only its owner can.                                                                                                                                                                                                                                                                       | yes                |
| `npm run fund-venue`      | Sends ETH to the swap venue of `LedgerTrigger`, which pays fills out of it.                                                                                                                                                                                                                                 | yes                |
| `npm run order-status`    | Prints an order, its status now (`statusOf`) and whether it can be filled now (`canFill`) with the reason.                                                                                                                                                                                                  | no                 |
| `npm run set-price`       | Sets the mock price feed. Hardhat's local chain only.                                                                                                                                                                                                                                                       | yes                |

### Settings

Amounts are written as people write them (`100`, `12.5`) and turned into whole numbers with the decimals read from the contracts. The deployment defaults are the contract's default limits; any of them can be set to another value at deployment, and none can change afterwards.

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

Even then, only `deploy:external`, `place-order`, `cancel-order` and `fund-venue` go ahead. The demo, `deploy:mocks` and `set-price` never run on another chain.

When the gate lets a script send on a chain that is not local, it opens the one Hardhat network connection the script uses: it sends a single-use token over that connection, and the network guard (see "Run the checks", step 5) answers it, checks that the connection's own node serves the chain the gate decided on, and from then on lets requests that write through on that connection only. Any other connection, even one to the same chain, stays closed. Deciding alone (`passSendGate`) opens nothing, so a stand-in client that only reports a chain ID cannot open anything, and no environment variable or setting can.

So what the gate and the guard stop is a request that would write, sent through one of Hardhat's network connections to a chain that is not local, on a connection the gate has not opened. They do not make every mistake impossible: with the confirmation sentence set, the four scripts above do send, to whichever chain the selected network serves, and a program that does not use Hardhat's network connections is not covered at all. The keeper is such a program: it does not pass through the gate or the guard, and sends to whichever node its own settings name.

## Run the keeper

The keeper fills the orders that name its account as executor, once they can be filled. It is only a trigger: the contract itself checks the price, the caller and the money. Each round it reads the contract's `OrderCreated` events for its account, and for each open order asks `canFill`, simulates the fill, compares the estimated fee with a cap, and only then sends `fillOrder`. An order that cannot be filled yet, or that someone else filled or cancelled first, is skipped and logged. It stores nothing between rounds.

Build the contracts first: the keeper reads the contract interfaces from Hardhat's build output (`npm run check` builds them too).

```sh
export HARDHAT_DISABLE_TELEMETRY=true
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

## Sepolia test network

The configuration has a `sepolia` network. Its node URL and private key are Hardhat configuration variables, `TRIGGER_SEPOLIA_RPC_URL` and `TRIGGER_SEPOLIA_PRIVATE_KEY`, read from environment variables of those names or from Hardhat's encrypted keystore; no value is written in the repository. With its chain ID set to 11155111, Hardhat refuses a node that serves another chain. Follow [docs/testnet-guide.md](docs/testnet-guide.md) to deploy on Sepolia with `deploy:external`, place an order and let the keeper fill it: which wallets you need, where the keys go and where they never go, each command, and what you should see. `npm run demo` is not part of it: the demo runs on Hardhat's local chain only.

## Not in this version

- Selling ETH, leverage, and any token other than USDC and ETH.
- Running unattended around the clock: orders are filled only while the keeper runs on the user's computer.
- Third-party automation services that fill orders on the user's behalf.
- Real money: the project is meant for a local chain and a test network.
- A tip for whoever fills an order: the keeper is the user's own program and pays its own gas.
- Filling one order in several parts.
- Orders that wake up only after the price first crosses another level, such as "once ETH has gone above 1700 USD, place a buy order at 1500 USD".
- Recurring purchases and a web page: optional, possibly later.
