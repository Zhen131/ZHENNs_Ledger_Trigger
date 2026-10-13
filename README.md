# Ledger Trigger

Ledger Trigger is a course project: orders on the chain that buy ETH with USDC when the price is right. A user places an order that says, for example, "when ETH costs this much or less, spend this much USDC on it and send the ETH to this address". There are four kinds: a plain limit order; a dormant limit order, which sleeps until the price first rises to an activation price and is woken up; a `Dca` order (dollar-cost averaging), which buys a set amount once in every period; and a `Ladder` order, which buys tier by tier as the price falls. Placing an order moves no money. A small program on the user's computer, the keeper, wakes up dormant orders and asks the contract to fill orders once the price is right; the contract then checks the price, the caller and the money itself, takes only this fill's USDC from the user's wallet, swaps it for ETH and sends the ETH to the address in the order. Each fill also gets the user a receipt from a second contract: a token that records the fill and can never be transferred. The contracts are written in Solidity, and the tests, the keeper, the scripts and the web page in TypeScript, with Hardhat 3 and viem. The tests run on a local Hardhat chain and need no network and no key.

## What the system guarantees

The contracts `LedgerTrigger` and `FillReceipt` promise five things. [docs/contract-spec.md](docs/contract-spec.md) explains each one, and how the code keeps it.

1. **Seven functions change state: four that place an order (`createOrder`, `createDormantOrder`, `createDcaOrder`, `createLadderOrder`), `activateOrder`, `fillOrder` and `cancelOrder`.** Placing and activating move no money. Only a fill takes USDC from the owner's wallet, swaps it for ETH and sends the ETH to the recipient, and each fill takes only its own share: all of a limit order, one period of a `Dca` order, the next tier of a `Ladder` order. The owner can cancel an order that is not finished at any time, whether it is dormant, open or partly filled, expired or not; what it has already bought is not given back.
2. **Three roles: owner, executor and recipient. There is no admin.** Only the owner and the executor named in an order can activate it or fill it; only the owner can cancel it. The receipt contract has no admin either. Nobody can pause either contract, upgrade it, change its settings or take money out of it.
3. **Every fill gives two hard guarantees: the price paid is never above this fill's price cap, and the ETH received is never less than the price feed's price gives, minus the allowed slippage.** This fill's price cap is the target price of a limit order, the price cap of every period of a `Dca` order, and the price of the tier being bought of a `Ladder` order. Both minimums are whole numbers rounded down, so each can fall short of the exact value by less than one wei, the smallest unit of ETH; that remainder is not counted.
4. **An order is stored as `Dormant`, `Open`, `PartiallyFilled`, `Filled` or `Cancelled`. `Expired` is never stored; it is worked out from the time.** `Filled` and `Cancelled` are final. An expired order can no longer be activated or filled; its owner can only cancel it, which frees its slot and what it has left.
5. **The contracts keep no money, and each receipt stands for one fill.** The USDC and ETH balances of both contracts are the same before and after every fill. This is a promise about fills only: USDC that someone sends straight to a contract cannot be refused, because a token transfer does not ask the receiver, and it stays there for good, since nothing can take it out. Each receipt stands for exactly one fill, is issued to the owner of the order that was filled, and can never be transferred; nobody can be approved to transfer it either.

## Where it stands

- Everything in this repository is built and runs on a local Hardhat chain: the two contracts and their tests, the keeper, a demo of thirteen scenarios, the deployment and operation scripts, and a web page. `npm run check` runs every check.
- **Nothing has been deployed to a public network yet.** The scripts can deploy to the Sepolia test network, and [docs/testnet-guide.md](docs/testnet-guide.md) gives the steps, but that needs a wallet with test ETH and a node service, and it has not been done.
- The code is released under the MIT License (see "License" below).

## What is where

| Path                          | What it holds                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/LedgerTrigger.sol` | The order contract                                                                                                                                                                       |
| `contracts/FillReceipt.sol`   | The receipt contract: one ERC-721 token for each fill, issued to the order's owner, which can never be transferred                                                                       |
| `contracts/interfaces/`       | `IPriceFeed` (the two Chainlink price feed functions the order contract reads), `ISwapVenue` (swap USDC for ETH) and `IFillReceipt` (the receipt contract as the order contract sees it) |
| `contracts/mocks/`            | Stand-ins for local use: `MockUSDC`, a test token anyone can mint; `MockPriceFeed`, whose price anyone can set; `MockSwapVenue`, which swaps at the feed price                           |
| `contracts/hostile/`          | Five misbehaving contracts used only by the tests, such as a recipient that calls back into `fillOrder` and a receipt contract that refuses to issue receipts                            |
| `test/`                       | The tests, in TypeScript, run by Node's test runner with viem                                                                                                                            |
| `keeper/`                     | The keeper                                                                                                                                                                               |
| `scripts/`                    | The checks, the demo, the deployment and operation scripts, the confirmation gate and the network guard                                                                                  |
| `scripts/cli/`                | The entry points that the `npm run` commands start                                                                                                                                       |
| `web/`                        | The web page: its markup, styles and TypeScript, and a development page with a stand-in wallet; Vite builds it (`vite.config.ts`)                                                        |
| `docs/`                       | The project specification, the demo script and their screenshots (`docs/img/`), the contract specification, the test matrix and the Sepolia guide                                        |
| `hardhat.config.ts`           | Hardhat's configuration: the Solidity version and optimizer, the network guard and the `sepolia` network                                                                                 |

## Documents

- [docs/project-specification.md](docs/project-specification.md): the project for a first-time reader: the problem and the design, then roles, functions, data structures, security rules, the state machine, the test scenarios, where to look for each grading point, and how to run it.
- [docs/demo-script.md](docs/demo-script.md): a live demonstration planned for ten minutes on a local chain, with the web page and a terminal: what to do, what you should see and what to do if it goes wrong, step by step.
- [docs/contract-spec.md](docs/contract-spec.md): what the two contracts guarantee and how: roles and permissions, functions, data structures, security rules, the state machine and the test scenarios, then the steps of a fill and of an activation, the parts around the contracts and the design choices.
- [docs/test-matrix.md](docs/test-matrix.md): which tests cover each of the 60 test scenarios, and other important tests.
- [docs/testnet-guide.md](docs/testnet-guide.md): how to deploy on the Sepolia test network, place an order and let the keeper fill it.

## Requirements

- Node.js 22.18 or newer, which can run TypeScript files directly. Only Node.js 25.9 has been tested.
- npm (comes with Node.js).
- Git.

## Set up from scratch

```sh
git clone https://github.com/Zhen131/ZHENNs_Ledger_Trigger.git ledger-trigger
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

This runs nine steps in order and stops at the first one that fails, naming it:

1. `format`: Prettier checks the formatting of Solidity, TypeScript, JSON and Markdown files.
2. `lint`: Solhint checks the contracts, including that every contract, function, event and public value has its documentation comment; warnings count as failures.
3. `compile`: Hardhat compiles the contracts with the pinned Solidity version (0.8.34).
4. `types`: the TypeScript compiler type-checks the configuration (Hardhat's and Vite's), the scripts, the keeper and the tests, and through the tests the web page's logic.
5. `web-types`: the TypeScript compiler type-checks all of the web page (`web/`), with the browser's types.
6. `web-build`: Vite builds the web page into `web/dist/`. It reads the contract interfaces from the build output, so it runs after `compile`.
7. `test`: Hardhat runs every test in `test/`; contract tests get a fresh in-process chain each time. Two guards keep the tests from sending anything to another chain. First, `npx hardhat test` and `npm run check` stop before any test runs when the selected network is not Hardhat's local chain (chain ID 31337) (`scripts/testNetworkGuard.ts`). Second, a network guard (`scripts/networkGuard.ts`, which `hardhat.config.ts` loads as a Hardhat network hook) sees every request that goes through one of Hardhat's network connections, however the code was started (`npx hardhat test`, `npm run check`, `node --test`, `node <file>`, `npx hardhat run <file>`, with `--network` or the `HARDHAT_NETWORK` environment variable). It lets everything through on a connection to Hardhat's in-process chain, whatever chain ID that chain reports: that chain lives inside the running process, so nothing sent to it leaves the computer. On a connection to a node, such as `npx hardhat node` or a node service, it lets plain reads through, and a request that would write, such as sending a transaction, deploying or signing, only in two cases: the node serves Hardhat's local chain (chain ID 31337), or a deployment or operation script has opened that very connection by passing its confirmation gate (see "The confirmation gate" below). Any other request that would write is refused with an error that says why. So the guard covers exactly this: requests that would write, sent through Hardhat's connections to a node that serves another chain. It does not see programs that talk to a node without Hardhat, such as the keeper.
8. `scenarios`: `scripts/scenarios.ts` checks that each of the 60 test scenarios, S01 to S60, has at least one test whose own title starts with its number, and that [docs/test-matrix.md](docs/test-matrix.md) matches the tests: a row for each scenario, every title it names is a real test in the file it names, and every scenario test is listed. Run `node scripts/scenarios.ts --list` to see which tests cover which scenario.
9. `hygiene`: `scripts/hygiene.ts` scans the repository files and commit history for things that must never be committed, such as key material, files whose names start with `.env`, or forbidden contract patterns.

The very first run downloads the Solidity compiler once. After that the checks need no network access, and Hardhat runs with telemetry disabled.

To fix formatting automatically:

```sh
npm run format
```

## Run the demo

```sh
npm run demo
```

The demo starts a fresh Hardhat chain inside the process, deploys the five contracts (the three mock parts, `FillReceipt` and `LedgerTrigger`) and plays thirteen of the test scenarios: six about plain limit orders, then seven about dormant, `Dca` and `Ladder` orders and receipts. In S01, S03, S27, S37, S50 and S56 the calls must succeed; in S04, S06, S07, S15, S29, S38 and S57 a call must be rejected:

| ID  | Scenario                             | Expected                                                                                                                                                                        |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Normal fill                          | `Open -> Filled`; ETH to the recipient, not to the caller                                                                                                                       |
| S03 | Cancel                               | `Open -> Cancelled`                                                                                                                                                             |
| S04 | A stranger fills                     | transaction rejected: `NotOrderOwnerOrExecutor`                                                                                                                                 |
| S06 | Price above the target               | transaction rejected: `PriceAboveTarget`; order afterwards: `Open`                                                                                                              |
| S07 | The same order filled twice          | first fill: `Open -> Filled`; second fill rejected: `OrderNotOpen`                                                                                                              |
| S15 | Allowance too small                  | transaction rejected: `InsufficientAllowance`; order afterwards: `Open`; after topping up the allowance: `Open -> Filled`                                                       |
| S27 | Dormant order activated, then filled | placed `Dormant`, counted in the owner's open orders; `Dormant -> Open -> Filled`; `OrderActivated`: by the executor, at the feed price                                         |
| S29 | Fill while dormant                   | transaction rejected: `OrderNotOpen`, status `Dormant`; `canFill`: no, `Dormant`; order afterwards: `Dormant`                                                                   |
| S37 | Dca: the first period                | `Open -> PartiallyFilled`; `OrderFilled`: fill 1 of 2, one period's USDC; remaining and open total each down by one period; ETH to the recipient                                |
| S38 | Dca: the same period twice           | second fill in the same period rejected: `PeriodAlreadyFilled`; order afterwards: `PartiallyFilled`; one period later: `PartiallyFilled -> Filled`                              |
| S50 | Ladder: tiers filled in order        | first keeper round: `Open -> PartiallyFilled`, tiers 0 and 1 filled in order; tier 2 waits: `PriceAboveTarget`; second keeper round: `PartiallyFilled -> Filled`, tier 2 filled |
| S56 | Each fill issues a receipt           | `Open -> Filled`; the owner got one receipt; receipt matches `OrderFilled`                                                                                                      |
| S57 | A receipt cannot be transferred      | transfer rejected: `ReceiptNotTransferable`; receipt still held by the owner                                                                                                    |

In S01, S27 and S50 the keeper's own rounds (`runOnce` from `keeper/`) do the activation and the fills, and their log lines are printed; S37 places its order with the same code as `place-dca-order`, S50 with that of `place-ladder-order`, and S38 moves the chain's clock forward one period with that of `advance-time`; the other calls go to the contracts directly. For each scenario the demo prints what it did, what was expected and what actually happened, read from the chain: statuses from `statusOf`, the name of the error a rejected call reverted with, events, receipts and balance changes. Then it prints a summary table and, last, `13 of 13 scenarios PASS.` It exits with 0 when all thirteen pass and with 1 otherwise. It needs no network and no key, and it refuses to run on any chain other than Hardhat's local chain.

Run it without `--network`. With `--network localhost` it would deploy another set of contracts on that node and move the node's clock forward by a day, which changes what the web page and the keeper see there.

## Deploy and operate on a local chain

The deployment and operation commands are Hardhat scripts: each runs on the network given with `--network`. `localhost` is a Hardhat node running on this computer; without `--network`, a script runs on a fresh in-process chain that is gone when the script ends. Settings come from environment variables only, so nothing in the repository has to be edited. No script prints a private key or a node URL. Each one that sends a transaction sends it from the network's first account: on a Hardhat node, test account #0.

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

It deploys five contracts (`MockUSDC`, `MockPriceFeed`, `MockSwapVenue`, then `FillReceipt` and `LedgerTrigger`, bound to each other), mints mock USDC to account #0, and prints every address, the ten parameters read back from the chain, the address `FillReceipt` is bound to, and the block `LedgerTrigger` was deployed in.

**3. Place an order** of 100 USDC with a target price of 1900 USD, valid for 60 minutes. Replace each part in angle brackets with the value from step 1 or 2:

```sh
export TRIGGER_CONTRACT_ADDRESS=<LedgerTrigger address printed in step 2>
export TRIGGER_ORDER_USDC=100 TRIGGER_TARGET_PRICE_USD=1900 TRIGGER_EXPIRY_MINUTES=60
export TRIGGER_RECIPIENT_ADDRESS=<address of account 2> TRIGGER_EXECUTOR_ADDRESS=<address of account 1>
npm run place-order -- --network localhost
export TRIGGER_ORDER_ID=1
npm run order-status -- --network localhost
```

`place-order` sets the USDC allowance first, then places the order. `order-status` shows the order, kind `Limit`, as `Open`, and `can fill now` says `no, reason PriceAboveTarget`: the mock price is still 2000 USD.

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

The keeper logs `action=filled` for order 1, and `order-status` now shows it as `Filled`, with `fills done 1 of 1`. Stop the node with Ctrl+C when you are done; everything on it is gone.

**Other kinds of order.** `place-dca-order` and `place-ladder-order` place a `Dca` order and a `Ladder` order from the terminal, either of them dormant when `TRIGGER_ACTIVATION_PRICE_USD` is set; `advance-time` moves the local chain's clock to a later period; and the keeper wakes up dormant orders and fills each order as often as the contract lets it. Scenes 6 to 9 of [docs/demo-script.md](docs/demo-script.md) walk through them, with each command and what it prints.

### Commands

| Command                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Sends transactions |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `npm run deploy:mocks`       | Deploys `MockUSDC`, `MockPriceFeed`, `MockSwapVenue` (stocked with ETH), then `FillReceipt` bound to the address `LedgerTrigger` is about to get, then `LedgerTrigger`, and mints mock USDC to the deploying account. Hardhat's local chain only. Prints every address, the ten parameters read back from the chain with their units, the address `FillReceipt` is bound to, and the block `LedgerTrigger` was deployed in.                                                                                                                                                                                           | yes                |
| `npm run deploy:external`    | For a test network: checks the existing USDC token and price feed given by address (contract code, decimals, latest price) before sending anything, then deploys `MockSwapVenue`, `FillReceipt` and `LedgerTrigger` only. Prints the same.                                                                                                                                                                                                                                                                                                                                                                            | yes                |
| `npm run place-order`        | Places a limit order. First simulates it and stops with the contract's error, sending nothing, if the contract would reject it; then sets the account's USDC allowance for `LedgerTrigger` to its open-order total after this order (`openOrderTotal`), then places the order.                                                                                                                                                                                                                                                                                                                                        | yes                |
| `npm run place-dca-order`    | Places a `Dca` order, dormant if an activation price is given, in the same way: simulate, set the allowance to cover the order's whole budget too, place. Prints the order and its schedule.                                                                                                                                                                                                                                                                                                                                                                                                                          | yes                |
| `npm run place-ladder-order` | Places a `Ladder` order, dormant if an activation price is given, in the same way. Prints the order and its tiers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | yes                |
| `npm run cancel-order`       | Cancels an order. Only its owner can.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | yes                |
| `npm run fund-venue`         | Sends ETH to the swap venue of `LedgerTrigger`, which pays fills out of it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | yes                |
| `npm run order-status`       | Prints an order: its kind, owner, executor and recipient; its amount, what is left and its target price; its activation price; `fills done … of …`; when it was placed and when it expires; its stored status and its status now (`statusOf`); whether it can be filled now (`canFill`) with the reason; for a dormant order, whether it can be activated now (`canActivate`) with the reason; and the feed price. A `Dca` order adds its schedule (the amount per period, the period length, when period 0 begins and the next period a fill can buy), a `Ladder` order one line per tier, `filled` or `not filled`. | no                 |
| `npm run set-price`          | Sets the mock price feed. Hardhat's local chain only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | yes                |
| `npm run advance-time`       | Moves the local chain's clock forward: mines one block the given number of seconds after the latest one. Reads no contract. Hardhat's local chain only.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | yes                |

### Settings

Amounts are written as people write them (`100`, `12.5`) and turned into whole numbers with the decimals read from the contracts. The defaults below are the deployment scripts' own; the contract itself has none. `LedgerTrigger` takes ten parameters at deployment, and none of them can change afterwards: the six limits each have a variable below; `usdc` and `priceFeed` are new mock parts that `deploy:mocks` deploys, or the addresses that `deploy:external` requires; `swapVenue` is always a new `MockSwapVenue`; and `receipt` is always a new `FillReceipt` that the script deploys right before `LedgerTrigger`, bound to it.

| Variable                         | Used by                                 | Meaning                                                                                                                                                                                                                                                                                            | Unit                     | Default                      |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------- |
| `TRIGGER_USDC_ADDRESS`           | `deploy:external`                       | The existing USDC token                                                                                                                                                                                                                                                                            | address                  | required                     |
| `TRIGGER_PRICE_FEED_ADDRESS`     | `deploy:external`                       | The existing ETH / USD price feed                                                                                                                                                                                                                                                                  | address                  | required                     |
| `TRIGGER_MAX_ORDER_USDC`         | both deploys                            | Largest amount of one fill (`maxOrderAmount`): all of a limit order, one period of a `Dca` order, one tier of a `Ladder` order; the whole budget of a `Dca` or `Ladder` order may be more                                                                                                          | USDC                     | `500`                        |
| `TRIGGER_MAX_OPEN_ORDERS`        | both deploys                            | Unfinished orders one owner may have (`maxOpenOrdersPerOwner`)                                                                                                                                                                                                                                     | whole number             | `5`                          |
| `TRIGGER_MAX_PRICE_AGE_SECONDS`  | both deploys                            | Oldest price that still counts (`maxPriceAge`)                                                                                                                                                                                                                                                     | seconds                  | `4500` (75 minutes)          |
| `TRIGGER_MAX_SLIPPAGE_BPS`       | both deploys                            | Allowed slippage (`maxSlippageBps`)                                                                                                                                                                                                                                                                | basis points (100 = 1 %) | `100`                        |
| `TRIGGER_MAX_PERIODS_PER_ORDER`  | both deploys                            | Most periods of one `Dca` order (`maxPeriodsPerOrder`)                                                                                                                                                                                                                                             | whole number             | `52`                         |
| `TRIGGER_MAX_TIERS_PER_ORDER`    | both deploys                            | Most tiers of one `Ladder` order (`maxTiersPerOrder`)                                                                                                                                                                                                                                              | whole number             | `5`                          |
| `TRIGGER_VENUE_FEE_BPS`          | both deploys                            | Fee of the mock swap venue                                                                                                                                                                                                                                                                         | basis points             | `0`                          |
| `TRIGGER_MOCK_PRICE_USD`         | `deploy:mocks`                          | First price of the mock feed (8 decimals)                                                                                                                                                                                                                                                          | USD                      | `2000`                       |
| `TRIGGER_MOCK_VENUE_ETH`         | `deploy:mocks`                          | ETH stocked in the mock swap venue                                                                                                                                                                                                                                                                 | ETH                      | `10`                         |
| `TRIGGER_MOCK_DEPLOYER_USDC`     | `deploy:mocks`                          | Mock USDC minted to the deploying account                                                                                                                                                                                                                                                          | USDC                     | `1000`                       |
| `TRIGGER_CONTRACT_ADDRESS`       | every operation but `advance-time`      | The deployed `LedgerTrigger`                                                                                                                                                                                                                                                                       | address                  | required                     |
| `TRIGGER_ORDER_USDC`             | `place-order`                           | USDC to spend                                                                                                                                                                                                                                                                                      | USDC                     | required                     |
| `TRIGGER_TARGET_PRICE_USD`       | `place-order`, `place-dca-order`        | Highest ETH price accepted: the target price, or the price cap of every period                                                                                                                                                                                                                     | USD                      | required                     |
| `TRIGGER_EXPIRY_MINUTES`         | `place-order`, `place-ladder-order`     | Validity, counted from the time of the latest block                                                                                                                                                                                                                                                | whole minutes            | required                     |
| `TRIGGER_RECIPIENT_ADDRESS`      | the three `place-` scripts              | Who receives the ETH                                                                                                                                                                                                                                                                               | address                  | required                     |
| `TRIGGER_EXECUTOR_ADDRESS`       | the three `place-` scripts              | Who may activate and fill the order besides its owner, such as the keeper                                                                                                                                                                                                                          | address                  | required                     |
| `TRIGGER_USDC_PER_PERIOD`        | `place-dca-order`                       | USDC to spend in each period                                                                                                                                                                                                                                                                       | USDC                     | required                     |
| `TRIGGER_PERIOD_SECONDS`         | `place-dca-order`                       | Length of one period                                                                                                                                                                                                                                                                               | whole seconds            | required                     |
| `TRIGGER_PERIOD_COUNT`           | `place-dca-order`                       | Number of periods                                                                                                                                                                                                                                                                                  | whole number             | required                     |
| `TRIGGER_START_AT`               | `place-dca-order`                       | When period 0 begins. Not set, or 0: in the block that places the order. If you set it, leave a few minutes' margin, or leave it unset: a time between the latest block and the next one can pass the script's simulation and then be refused by the contract, leaving the raised allowance behind | Unix time, whole seconds | not set                      |
| `TRIGGER_ACTIVATION_PRICE_USD`   | `place-dca-order`, `place-ladder-order` | Activation price: the order is placed dormant and must be activated before it can be filled. For a `Ladder` order it must be above the price of tier 0                                                                                                                                             | USD                      | not set: no activation price |
| `TRIGGER_TIERS`                  | `place-ladder-order`                    | The tiers in the order they are filled, each `price:amount`, separated by commas, such as `2000:30,1900:40,1800:50`                                                                                                                                                                                | USD and USDC             | required                     |
| `TRIGGER_ORDER_ID`               | `cancel-order`, `order-status`          | The order                                                                                                                                                                                                                                                                                          | whole number             | required                     |
| `TRIGGER_FUND_ETH`               | `fund-venue`                            | ETH to send                                                                                                                                                                                                                                                                                        | ETH                      | required                     |
| `TRIGGER_PRICE_USD`              | `set-price`                             | New mock price                                                                                                                                                                                                                                                                                     | USD                      | required                     |
| `TRIGGER_ADVANCE_SECONDS`        | `advance-time`                          | How far to move the local chain's clock forward                                                                                                                                                                                                                                                    | whole seconds            | required                     |
| `TRIGGER_CONFIRM_PUBLIC_NETWORK` | every script that sends                 | Confirmation for a chain that is not Hardhat's local chain (below)                                                                                                                                                                                                                                 | the exact sentence       | not set                      |

### The confirmation gate

Every script that sends transactions (both deploys, `place-order`, `place-dca-order`, `place-ladder-order`, `cancel-order`, `fund-venue`, `set-price`, `advance-time` and the demo) first asks the node for its chain ID. On Hardhat's local chain (chain ID 31337) it goes ahead. On any other chain it sends nothing and exits with 1, unless `TRIGGER_CONFIRM_PUBLIC_NETWORK` holds exactly this sentence:

```text
I am sending real transactions to a public network
```

Even then, only `deploy:external`, `place-order`, `place-dca-order`, `place-ladder-order`, `cancel-order` and `fund-venue` go ahead. The demo, `deploy:mocks`, `set-price` and `advance-time` never run on another chain.

When the gate lets a script send on a chain that is not local, it opens the one Hardhat network connection the script uses: it sends a single-use token over that connection, and the network guard (see "Run the checks", step 7) answers it, checks that the connection's own node serves the chain the gate decided on, and from then on lets requests that write through on that connection only. Any other connection, even one to the same chain, stays closed. Deciding alone (`passSendGate`) opens nothing, so a stand-in client that only reports a chain ID cannot open anything, and no environment variable or setting can.

So what the gate and the guard stop is a request that would write, sent through one of Hardhat's network connections to a node that serves a chain other than Hardhat's local chain, on a connection the gate has not opened. They do not make every mistake impossible: with the confirmation sentence set, the six scripts above do send, to whichever chain the selected network serves, and a program that does not use Hardhat's network connections is not covered at all. The keeper is such a program: it does not pass through the gate or the guard, and sends to whichever node its own settings name.

## Run the keeper

The keeper wakes up and fills the orders that name its account as executor, once the contract says they can be woken up or filled. It is only a trigger: the contract itself checks the price, the caller and the money. Each round it reads the contract's `OrderCreated` events for its account and goes through those orders twice. First the dormant ones: for each it asks `canActivate`, simulates the activation, compares the estimated fee with a cap, and only then sends `activateOrder`. Then the open and partly filled ones, including any it has just woken up: for each it asks `canFill`, simulates the fill, compares the estimated fee with the cap, and only then sends `fillOrder`; and it fills the same order again in the same round, as a `Ladder` order whose price fell through several tiers needs, until `canFill` says no or it has filled that order `KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND` times, which it logs as `fill-limit-reached`. An order that cannot be woken up or filled yet, or that someone else filled or cancelled first, is skipped and logged. It stores nothing between rounds.

Build the contracts first: the keeper reads the contract interfaces from Hardhat's build output (`npm run check` builds them too).

```sh
export HARDHAT_DISABLE_TELEMETRY=true
npx hardhat build
```

The keeper takes its settings from environment variables only, and never prints the private key or the node URL:

| Variable                               | Required | Meaning                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEPER_RPC_URL`                       | yes      | URL of the node's JSON-RPC endpoint (`http` or `https`, without a user name or password before the host). Node services often put an access key in it, so treat it as a secret. The keeper talks to this node only: it does not follow a contract's request to fetch data from a web address (CCIP-read). |
| `KEEPER_PRIVATE_KEY`                   | yes      | Private key of the executor account the keeper sends activations and fills from and pays gas with: 64 hex digits, with or without a leading `0x`.                                                                                                                                                         |
| `KEEPER_CONTRACT_ADDRESS`              | yes      | Address of the deployed `LedgerTrigger` contract.                                                                                                                                                                                                                                                         |
| `KEEPER_FROM_BLOCK`                    | yes      | First block to read `OrderCreated` events from, such as the block the contract was deployed in.                                                                                                                                                                                                           |
| `KEEPER_MAX_FEE_WEI`                   | yes      | Largest fee, in wei, the keeper may pay for one transaction, an activation or a fill: the estimated gas times the highest gas price the transaction is sent with. A dearer one is skipped and logged as `fee-above-cap`.                                                                                  |
| `KEEPER_INTERVAL_SECONDS`              | no       | Seconds to wait between two rounds when the keeper keeps running. Default 30.                                                                                                                                                                                                                             |
| `KEEPER_MAX_BLOCK_RANGE`               | no       | Most blocks read in one event request; many node services limit this span. Default 500.                                                                                                                                                                                                                   |
| `KEEPER_MAX_FILLS_PER_ORDER_PER_ROUND` | no       | Most fills of one order in one round. Default 5.                                                                                                                                                                                                                                                          |

The defaults of the three optional variables are set in `keeper/config.ts`. Do not keep these variables in a file inside the repository: `.gitignore` ignores every file whose name starts with `.env`, and the hygiene scan fails on one that is committed anyway.

Start it in one of two modes:

```sh
npm run keeper -- --once   # run one round, then exit
npm run keeper             # keep running: a round, a pause, another round, until stopped
```

It logs one line per event to standard output: the time, the order ID, what it did and why. Before its first round it gets ready: it checks the settings, reads the contract interfaces, asks the node for its chain ID and checks that there is contract code at the address. In `--once` mode it exits with code 1 when getting ready fails or when anything in the round was an error, such as a node that could not be reached or that reported an error that is not a contract revert; a skipped order is not an error. While it keeps running, every error, getting ready included, is logged and the next round runs as usual.

## Run the web page

The web page works with a `LedgerTrigger` deployed on a local Hardhat node. It connects a wallet; shows the ETH / USD price, the balances and, under the contract's address, the contract's limits; places orders of the four kinds, approving the USDC first when the allowance is too small; lists your orders, with each one's kind, its progress (`fills n of N`) and, for a `Dca` or `Ladder` order, its schedule or tiers, and looks up any order by its number; and wakes up (Activate), fills (Fill now) and cancels orders. Below them, a list shows the contract's latest events, everyone's. Each transaction shows its steps: waiting for the wallet, then waiting for the block (a small spinner), then confirmed.

The page reads everything from the local node at `http://127.0.0.1:8545`, never through the wallet. The wallet, such as MetaMask, only gives the account and signs the transactions. The page accepts another node only on this computer: `?rpc=http://localhost:8545` in the address bar works, any other host is refused. Each call that would change something is first simulated on the node: if the contract would reject it, the page shows the contract's error, such as `PriceAboveTarget(price: 2000.00, targetPrice: 1500.00)`, and the wallet is not asked at all.

You need three terminals, each opened in the repository folder: the first runs the node, the second runs the page, and the third is for the commands from step 6 on. The first two keep running until you are done.

**1. Start a local node and deploy**, with the same commands as steps 1 and 2 of "Deploy and operate on a local chain" above. In the first terminal, start the node and leave it running:

```sh
export HARDHAT_DISABLE_TELEMETRY=true
npx hardhat node
```

and, in the second terminal:

```sh
export HARDHAT_DISABLE_TELEMETRY=true
npx hardhat build
npm run deploy:mocks -- --network localhost
```

You should see `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/` in the first terminal, and the `LedgerTrigger` address in the second. Keep the node running.

**2. Start the page.** In the second terminal, once the deployment has finished, start the page and leave it running:

```sh
npm run web
```

You should see `Local: http://localhost:5173/`. Open `http://localhost:5173/?contract=<address>` in the browser, with the `LedgerTrigger` address from step 1 in place of `<address>`, or open `http://localhost:5173/` and paste the address into "Contract address", then press Load. Use the `LedgerTrigger` address, not the `FillReceipt` one: the page says so if you paste the wrong one. The browser remembers the address. You should see the line `Limits of this contract: up to 500.00 USDC per fill · up to 5 unfinished orders per owner · Dca up to 52 periods · Ladder up to 5 tiers`, the ETH / USD price, `2000.00`, and the event list. Without a wallet, the page still shows the price and the events and can look up orders; the buttons that send transactions stay grey and say "No wallet found in this browser".

**3. Set up MetaMask** (once). Use a browser profile that holds no real wallet, and MetaMask only for this.

1. Add the local network by hand: network name `Hardhat local` (any name will do), RPC URL `http://127.0.0.1:8545`, chain ID `31337`, currency symbol `ETH`.
2. Import test account #0 with its private key, printed by `npx hardhat node`. The test accounts and their keys are public, the same on every computer: never send real money to them, and never import them into a wallet that holds real money.
3. Switch MetaMask to the local network.

You should see account #0 in MetaMask with about 9990 ETH: the deployment stocked the swap venue with 10 ETH and paid a little gas.

**4. Connect.** Press "Connect wallet" and accept in MetaMask. You should see the short address, `0xf39F…2266`, and `chain 31337`, and "My USDC" shows `1000.00`. If the wallet is on another chain, the page says so and keeps the buttons that send transactions grey; it never switches the wallet's chain itself.

**5. Place an order**: Amount `100`, Target price `1500`, Valid for `60` minutes, Recipient the address of account #2, Executor the address of account #1 (the keeper's account). Press "Place order". The first time, MetaMask asks twice: first to approve the USDC, then to place the order. You should see `Approve USDC: Confirmed in block …` and `Place order: Confirmed in block …`, and the order under "My orders" as `Open · waiting: PriceAboveTarget`, with a pulsing dot. The allowance is only raised when it is too small for your open orders plus this one, so a later order may need only one confirmation.

The other kinds of order use the same form. Choose Kind `Dormant limit` to add an Activation price, which must be above the target price: the order shows `Dormant · waiting: PriceBelowActivation` until the price rises to it. `Dca` asks for the USDC per period, a Price cap, Every (days), the number of Periods and an optional activation price; the order starts in the block that places it. `Ladder` asks for a price and an amount for each tier, at falling prices, with Add tier and Remove up to the contract's most tiers, and an optional activation price.

**6. Let the keeper fill it.** In a third terminal in the repository folder, move the mock price to the target and run the keeper once (steps 4 and 5 of "Deploy and operate on a local chain" explain each variable):

```sh
export HARDHAT_DISABLE_TELEMETRY=true
export TRIGGER_CONTRACT_ADDRESS=<LedgerTrigger address printed in step 1>
export TRIGGER_PRICE_USD=1500
npm run set-price -- --network localhost
export KEEPER_RPC_URL=http://127.0.0.1:8545
export KEEPER_PRIVATE_KEY=<private key of account 1>
export KEEPER_CONTRACT_ADDRESS=$TRIGGER_CONTRACT_ADDRESS
export KEEPER_FROM_BLOCK=<block number printed in step 1>
export KEEPER_MAX_FEE_WEI=5000000000000000
npm run keeper -- --once
```

The keeper logs `action=filled` for the order; a dormant order is first woken up, `action=activated`, in a round where the price is at or above its activation price. Without reloading the page, you should see the order's row flash and turn to `Filled` in green, the recipient's ETH go up, and an `OrderFilled` line at the top of the event list.

The buttons of each order: a `Dormant` order has **Activate**, **Fill now** and **Cancel**; an `Open` or `PartiallyFilled` order has Fill now and Cancel; an `Expired` order has only Cancel, since it still takes a slot; a `Filled` or `Cancelled` order has none. Activate wakes up a dormant order once the price is at or above its activation price, and Fill now fills the next share of an order yourself; only its owner and its executor can do either, and only its owner can cancel it. Fill now on a dormant order shows the contract's refusal, `OrderNotOpen(orderId: …, status: 1)`. To see a refusal of a stranger, look up someone else's order with "Look up order #" (it is marked "not yours") and press Fill now: the page shows `NotOrderOwnerOrExecutor(...)` and sends nothing.

Good to know:

- The mock price counts as stale 75 minutes after it was set (`maxPriceAge`): orders then show `Open · waiting: StalePrice` or `PartiallyFilled · waiting: StalePrice`, and dormant ones `Dormant · waiting: StalePrice`. Run `set-price` again in the third terminal.
- After restarting the node in the first terminal, everything on the old chain is gone: deploy again in the third terminal and press Load (on a fresh node the address is usually the same as before). MetaMask still counts the old chain's transactions and sends the next one with a wrong number (nonce), which the node refuses. Clear them in MetaMask: open Settings, then Advanced, and press the button that clears the account's activity and nonce data ("Reset account" in MetaMask's developer documentation; some versions call it "Clear activity tab data").
- `npm run web:build` builds the page into `web/dist/`, and `npm run web:preview` serves that build at `http://localhost:4173/`. `npm run web:types` type-checks the page alone, as step `web-types` of `npm run check` does.

**The development page** `http://localhost:5173/dev.html` is for development and checks only; for a demonstration, open the real page with MetaMask. It loads a stand-in wallet that passes every request to the local node, which signs with its own unlocked test accounts: the stand-in holds no key. `?account=N` picks test account N (default 0), `?reject=1` makes it refuse every transaction as if the user said no, and `?switchTo=N` switches to account N 3 seconds after connecting, as a wallet does when the user picks another account. It works only with Hardhat's local chain, and it does not install itself when the browser already has a wallet.

## Sepolia test network

The configuration has a `sepolia` network. Its node URL and private key are Hardhat configuration variables, `TRIGGER_SEPOLIA_RPC_URL` and `TRIGGER_SEPOLIA_PRIVATE_KEY`, read from environment variables of those names or from Hardhat's encrypted keystore; no value is written in the repository. With its chain ID set to 11155111, Hardhat refuses a node that serves another chain. Follow [docs/testnet-guide.md](docs/testnet-guide.md) to deploy on Sepolia with `deploy:external`, place an order and let the keeper fill it: which wallets you need, where the keys go and where they never go, each command, and what you should see. `npm run demo` is not part of it: the demo runs on Hardhat's local chain only.

## Not in this version

- Selling ETH, stop-loss orders, leverage, and any token other than USDC and ETH.
- Running unattended around the clock: orders are woken up and filled only while the keeper runs on the user's computer.
- Third-party automation services that fill orders on the user's behalf, and a tip for whoever fills an order: the keeper is the user's own program and pays its own gas.
- Orders signed off the chain: every order is placed with a transaction from its owner.
- Real money: the project is meant for a local chain and a test network.
- Pictures or other metadata for the receipts: a receipt records its fill on the chain, and its `tokenURI` is empty.

## License

Ledger Trigger is released under the MIT License. See [LICENSE](LICENSE).
