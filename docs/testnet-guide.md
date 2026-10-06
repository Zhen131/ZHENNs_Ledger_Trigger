# Sepolia test network guide

This guide walks you through deploying Ledger Trigger to the Sepolia test network, placing an order, and letting the keeper fill it. Follow the steps in order. Each step says what you should see.

Read this first:

- **Nothing in this guide has been run on Sepolia yet.** Every script was run on a local Hardhat chain only. Steps marked **[Not run on Sepolia]** worked locally; on Sepolia you are the first to run them.
- Steps marked **[Not run at all]** use Hardhat's keystore. They have never been run for this project, not even locally.
- You never need to edit a file in this repository. Every setting is an environment variable that you set in your terminal.
- Sepolia coins have no value, but your keys are still keys. Treat them as secrets.

## 1. What you need

1. **Two new wallets that hold only test coins.** Create them in your wallet app just for this. Never use a wallet that holds real money.
   - **Wallet A, the owner.** It deploys the contracts, places the orders and pays for them. It needs Sepolia test ETH (for fees and for stocking the swap venue) and Sepolia test USDC.
   - **Wallet B, the keeper.** The keeper fills orders from it. It needs Sepolia test ETH only, for fees.
   - You need the private key of each wallet. Your wallet app can show it (it is 64 hex digits, sometimes with `0x` in front).
2. **Test coins.**
   - Test ETH for both wallets: use a Sepolia faucet, for example the one your node service offers.
   - Test USDC for wallet A: use Circle's faucet at https://faucet.circle.com (choose Ethereum Sepolia). A few USDC are enough.
3. **A node service.** Sign up with a node service such as Alchemy or Infura and create a Sepolia endpoint. It gives you an HTTPS URL. **That URL contains your access key: treat it like a password.**
4. **The two addresses this project does not deploy on Sepolia.** Look them up yourself in the official pages; this repository does not contain them.
   - USDC on Sepolia: Circle's page "USDC contract addresses" (https://developers.circle.com/stablecoins/usdc-contract-addresses), section "Testnet", row "Ethereum Sepolia".
   - ETH / USD price feed on Sepolia: Chainlink's page "Price Feed Contract Addresses" (https://docs.chain.link/data-feeds/price-feeds/addresses). Choose Ethereum, then the Sepolia testnet, then find "ETH / USD".
5. This repository, set up and checked as the README says (`npm ci`, then `npm run check`).

You should see: `npm run check` ends with `Check passed`.

## 2. Where the keys go, and where they never go

There are four secrets: the private keys of wallets A and B, and the node URL (it holds your access key).

**Never:**

- put a key or the node URL in any file inside this repository, including a file named `.env` (the hygiene check fails on such a file, and on one that was committed and later deleted);
- write a key in a shell configuration file such as `~/.zshrc`;
- type a key on a command line, as in `export KEY=...`, because zsh saves command lines in its history file;
- show a key on screen while you take screenshots.

**Use instead:**

- For the deploy and operation scripts (Hardhat reads them):
  - Option 1, Hardhat's encrypted keystore. **[Not run at all]** It stores the values encrypted in a file in your home folder and asks for its password whenever a script needs them.

    ```sh
    npx hardhat keystore set TRIGGER_SEPOLIA_RPC_URL
    npx hardhat keystore set TRIGGER_SEPOLIA_PRIVATE_KEY
    ```

    The first command asks you to choose a keystore password, then asks for the value. Paste the node URL, then (second command) wallet A's private key. You should see a message that the key was set. `npx hardhat keystore list` shows the names only.

  - Option 2, environment variables in the current terminal only. **[Not run on Sepolia]** `read -s` reads without showing what you paste and keeps it out of the history:

    ```sh
    read -s "TRIGGER_SEPOLIA_RPC_URL?Node URL: " && export TRIGGER_SEPOLIA_RPC_URL
    read -s "TRIGGER_SEPOLIA_PRIVATE_KEY?Wallet A private key: " && export TRIGGER_SEPOLIA_PRIVATE_KEY
    ```

    This is the zsh way to write `read`, and zsh is the default shell on macOS; in bash it fails. Each line waits for you to paste the value and press Enter. The variables are gone when you close that terminal. If a variable of the same name is set, Hardhat uses it rather than the keystore.

    In a terminal that holds these secrets, run only the commands in this guide. `npm run check` and the tests run on Hardhat's local chain when no network is selected, as usual. If a network that is not local is selected (with `--network` or the `HARDHAT_NETWORK` environment variable), every transaction the tests try is refused before it is sent, however the tests were started and whatever file was loaded with them, and `npx hardhat test` stops before it runs any test. Only the deploy and operation scripts in this guide can send to Sepolia: each one only after its confirmation sentence is set, and only over the one connection it opened through its send gate.

- For the keeper (it is a separate program and cannot read Hardhat's keystore): environment variables in its own terminal, set the same way (step 7).

No script in this repository prints a private key or the node URL.

## 3. Deploy

The external-parts deployment uses the real Sepolia USDC and price feed. It deploys two contracts: a mock swap venue and LedgerTrigger. (The other deployment, `deploy:mocks`, runs on Hardhat's local chain only and refuses Sepolia.) **[Not run on Sepolia]**

1. In a new terminal, go to the repository and set the two secrets for Hardhat (step 2).
2. Set the two addresses from step 1.4, and the confirmation sentence. The scripts refuse to send anything to a chain other than Hardhat's local chain unless `TRIGGER_CONFIRM_PUBLIC_NETWORK` holds exactly this sentence:

   ```sh
   export TRIGGER_USDC_ADDRESS=<USDC address from Circle's page>
   export TRIGGER_PRICE_FEED_ADDRESS=<ETH / USD feed address from Chainlink's page>
   export TRIGGER_CONFIRM_PUBLIC_NETWORK="I am sending real transactions to a public network"
   ```

3. Optional: change the deployment parameters. Each has a default:

   | Variable                        | Meaning                                                   | Unit                                  | Default             |
   | ------------------------------- | --------------------------------------------------------- | ------------------------------------- | ------------------- |
   | `TRIGGER_MAX_ORDER_USDC`        | Largest order (`maxOrderAmount`)                          | USDC, as you write it (`500`, `12.5`) | `500`               |
   | `TRIGGER_MAX_OPEN_ORDERS`       | Open orders one wallet may have (`maxOpenOrdersPerOwner`) | whole number of orders                | `5`                 |
   | `TRIGGER_MAX_PRICE_AGE_SECONDS` | Oldest price that still counts (`maxPriceAge`)            | seconds                               | `4500` (75 minutes) |
   | `TRIGGER_MAX_SLIPPAGE_BPS`      | Allowed price slippage (`maxSlippageBps`)                 | basis points (100 = 1 %)              | `100`               |
   | `TRIGGER_VENUE_FEE_BPS`         | Fee of the mock swap venue                                | basis points                          | `0`                 |

   The script turns the USDC amount into the token's smallest unit with the decimals it reads from the token.

4. Deploy:

   ```sh
   npm run deploy:external -- --network sepolia
   ```

You should see, first, the check of the two addresses (nothing has been sent yet): the USDC token with 6 decimals, and the price feed with 8 decimals and its latest price in USD. Then the addresses of the swap venue and LedgerTrigger, the seven parameters read back from the chain with their units, and a line like `LedgerTrigger was deployed in block 1234567: use it as KEEPER_FROM_BLOCK`. **Write down the LedgerTrigger address and that block number.**

If an address is wrong (for example a mainnet address), the script stops before sending anything and names the variable and the address.

## 4. Stock the swap venue with ETH

The swap venue pays each fill out of ETH sent to it beforehand. **[Not run on Sepolia]**

- **The mock swap venue is open to everyone.** Anyone can swap test USDC for the ETH in it. Send only what your demo needs, and do the demo right after.
- One order buys `amount ÷ price` ETH. For 2 USDC at 2500 USD, that is 0.0008 ETH. **The venue must hold at least the ETH an order buys, or the fill fails.** `canFill` does not check this.
- So keep orders small: a few USDC.

```sh
export TRIGGER_CONTRACT_ADDRESS=<LedgerTrigger address from step 3>
export TRIGGER_FUND_ETH=0.002
npm run fund-venue -- --network sepolia
```

`TRIGGER_FUND_ETH` is in ETH, as you write it. You should see `Sent 0.002 ETH to the swap venue 0x...` and the venue's balance before and after.

## 5. Approve and place an order

The script first checks the order without sending anything: if the contract would reject it (for example it is above the largest order, or wallet A already has 5 open orders), it stops with the contract's error name and sends nothing. Otherwise it sets wallet A's USDC allowance for LedgerTrigger to what all of A's open orders add up to (`openOrderTotal`), then places the order. **[Not run on Sepolia]**

The price on Sepolia moves by itself; nobody can set it. So:

- **To see a fill right away**, set the target price **above** the current price (the price the deploy step printed). The order can be filled at once.
- **To see "the price has not been reached"**, set the target price **below** the current price. The keeper will wait, and `order-status` will say `PriceAboveTarget`.

```sh
export TRIGGER_ORDER_USDC=2
export TRIGGER_TARGET_PRICE_USD=<a price in USD, for example 1000 above the current price>
export TRIGGER_EXPIRY_MINUTES=120
export TRIGGER_RECIPIENT_ADDRESS=<wallet A's address, or any address of yours>
export TRIGGER_EXECUTOR_ADDRESS=<wallet B's address>
npm run place-order -- --network sepolia
```

| Variable                    | Meaning                                 | Unit                                |
| --------------------------- | --------------------------------------- | ----------------------------------- |
| `TRIGGER_ORDER_USDC`        | USDC to spend                           | USDC, as you write it (`2`, `2.5`)  |
| `TRIGGER_TARGET_PRICE_USD`  | Highest ETH price you accept            | USD, as you write it (`2500.5`)     |
| `TRIGGER_EXPIRY_MINUTES`    | How long the order stays valid          | whole minutes from the latest block |
| `TRIGGER_RECIPIENT_ADDRESS` | Who receives the ETH                    | address                             |
| `TRIGGER_EXECUTOR_ADDRESS`  | Who may fill it besides you: the keeper | address                             |

You should see `Placed order <number> from account 0x...` with the amount, the target price, the expiry, the allowance (equal to the open-order total) and wallet A's USDC balance. **Write down the order number.**

## 6. Look at an order, and cancel one

**[Not run on Sepolia]**

Use the order number that `place-order` printed (`Placed order <number> ...`). It is not always 1: every order placed on this LedgerTrigger gets the next number.

```sh
export TRIGGER_ORDER_ID=<the order number place-order printed>
npm run order-status -- --network sepolia
```

You should see the order's fields, `status now` (`Open`, `Filled`, `Cancelled` or `Expired`), and `can fill now` with a reason: `None` when it can be filled, otherwise for example `PriceAboveTarget`, `InsufficientAllowance` or `InsufficientBalance`. This script sends nothing.

To cancel an order (only wallet A, its owner, can):

```sh
npm run cancel-order -- --network sepolia
```

It cancels the order in `TRIGGER_ORDER_ID`. You should see `Order <number>: Open -> Cancelled.`

## 7. Run the keeper against Sepolia

The keeper fills the orders whose executor is wallet B, once they can be filled. Run it on your computer, in a second terminal. **[Not run on Sepolia]**

1. Open a new terminal and go to the repository.
2. Set its two secrets without showing them and without saving them in the history:

   ```sh
   read -s "KEEPER_RPC_URL?Node URL: " && export KEEPER_RPC_URL
   read -s "KEEPER_PRIVATE_KEY?Wallet B private key: " && export KEEPER_PRIVATE_KEY
   ```

   The private key works with or without `0x` in front.

3. Set the rest:

   ```sh
   export KEEPER_CONTRACT_ADDRESS=<LedgerTrigger address from step 3>
   export KEEPER_FROM_BLOCK=<the block number from step 3>
   export KEEPER_MAX_FEE_WEI=5000000000000000
   export KEEPER_MAX_BLOCK_RANGE=10
   ```

   - `KEEPER_FROM_BLOCK`: the block LedgerTrigger was deployed in, as the deploy step printed. Earlier blocks cannot hold its orders.
   - `KEEPER_MAX_BLOCK_RANGE`: how many blocks the keeper reads in one request. The default is 500, but many free node plans allow only 10 blocks per request. A new block comes about every 12 seconds, so by the time you get here more than 10 blocks have passed since the deployment. With a free plan, set 10 as above. On a paid plan you can leave it out.
   - `KEEPER_MAX_FEE_WEI`: the most the keeper may pay for one fill, in wei (1 ETH = 10^18 wei). A fill used about 150,000 to 165,000 gas on the local chain. `5000000000000000` is 0.005 ETH, enough up to a gas price of about 30 gwei. When a fill would cost more, the keeper does not send it and logs a line like `action=skip reason=fee-above-cap estimated-fee-wei=... cap-wei=...`. Then wait for cheaper gas, or raise the cap.

4. Run one round, then exit:

   ```sh
   npm run keeper -- --once
   ```

   Or keep it running (a round every 30 seconds) until you press Ctrl+C:

   ```sh
   npm run keeper
   ```

You should see a `start` line with chain ID `11155111`, then a `round-start` line, then for your order either `action=skip reason=PriceAboveTarget` (it waits) or `action=filled reason=transaction-succeeded tx=0x...`. After a fill, `order-status` shows `Filled`, and the recipient's ETH balance has gone up.

If the keeper logs `action=error reason=node-error step=find-orders`, the node refused to read that many blocks at once. Set a smaller `KEEPER_MAX_BLOCK_RANGE` (for example 5) and start the keeper again.

## 8. Screenshots to take

Before every screenshot, **close or hide every window that shows a private key or the node URL**: your wallet app's key export, your node service's dashboard, and any terminal where you printed variables. Never run `env` or `echo` on these variables.

Take these:

1. The terminal output of `npm run deploy:external` (addresses, parameters, block number).
2. LedgerTrigger's page on the Sepolia block explorer (https://sepolia.etherscan.io), searched by its address: the contract and its deployment transaction.
3. The terminal output of `npm run place-order`, and the `createOrder` transaction on the block explorer.
4. The terminal output of `npm run order-status` before the fill (`Open`) and after it (`Filled`).
5. The keeper's terminal with the `filled` line and its transaction hash.
6. That fill transaction on the block explorer: its Logs tab, and the ETH sent to the recipient. Until the contract's source is verified on the block explorer (a later step, not in this guide), the Logs tab shows the event as hexadecimal topics and data rather than by the name `OrderFilled`; that is expected.
7. Optional: the terminal output of `npm run cancel-order`.

A call the contract would reject at that moment (for example a fill while the price is above the target, or cancelling an order that is already filled) does not reach the chain: `place-order` and `cancel-order` check the call with the node before sending it, and the keeper asks `canFill` and simulates each fill first, so nothing is sent and the terminal says why. That terminal line is its screenshot. Only when the order changes between that check and the moment the transaction is mined, for example when its owner cancels it just as the keeper sends the fill, is the transaction mined and fails on chain, and the keeper skips the order.

## 9. When something goes wrong

| What you see                                                                                  | What it means and what to do                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Hardhat stopped the script with error HHE7 Configuration variable not found`                 | `TRIGGER_SEPOLIA_RPC_URL` or `TRIGGER_SEPOLIA_PRIVATE_KEY` is neither set in this terminal nor in the keystore. Go back to step 2.                |
| `... error HHE703 Cannot connect to the network`                                              | The node URL is wrong, or you are offline.                                                                                                        |
| `... error HHE708 Invalid global chain id`                                                    | The node URL is for another network (for example mainnet). Use the Sepolia URL.                                                                   |
| `... error HHE30 Invalid configuration variable hex string`                                   | The private key is not 64 hex digits. Set `TRIGGER_SEPOLIA_PRIVATE_KEY` again and paste the whole key.                                            |
| `The script stopped on an error it did not expect (... DispatcherError > TypeError)`          | The node URL is not a URL at all (for example a word is missing or extra). Set `TRIGGER_SEPOLIA_RPC_URL` again.                                   |
| `The sending account does not hold enough ETH to pay for this transaction.`                   | Wallet A has no test ETH, or too little for the fee. Get test ETH from a faucet and run the script again.                                         |
| `The script stopped on an error it did not expect (... InvalidInputRpcError > ProviderError)` | Often the same thing: the sending wallet has no ETH for the fee. Check its balance on the block explorer.                                         |
| `... set TRIGGER_CONFIRM_PUBLIC_NETWORK to the exact sentence ...`                            | Set the confirmation sentence exactly as in step 3.                                                                                               |
| `TRIGGER_USDC_ADDRESS (0x...) holds no contract code on chain 11155111`                       | That address is not deployed on Sepolia. Copy it again from Circle's page (the same goes for the price feed).                                     |
| `The contract rejected the call with ExpiryNotInFuture(...)`                                  | `TRIGGER_EXPIRY_MINUTES` is too small. Use a larger number.                                                                                       |
| `The contract rejected the call with AmountAboveMax(...)`                                     | The order is above the largest order set at deployment.                                                                                           |
| `order-status` says `InsufficientBalance`                                                     | Wallet A holds less USDC than the order. Get more from Circle's faucet.                                                                           |
| `order-status` says `StalePrice`                                                              | The feed has not updated for longer than `maxPriceAge`. Wait for its next update.                                                                 |
| Keeper: `action=skip reason=InsufficientEthReserve`                                           | The swap venue holds less ETH than the order buys. Do step 4 again.                                                                               |
| Keeper: `action=skip reason=fee-above-cap`                                                    | See `KEEPER_MAX_FEE_WEI` in step 7.                                                                                                               |
| Keeper: `action=error reason=node-error` at `step=estimate` or `step=send`                    | Often wallet B has no test ETH left for fees. Get more from a faucet.                                                                             |
| Keeper: `action=error reason=config-missing variable=...`                                     | That variable is not set in the keeper's terminal.                                                                                                |
| Keeper: `reason=config-invalid variable=KEEPER_RPC_URL`                                       | The URL must start with `http://` or `https://` and must not hold a user name or password before the host. Paste it as the node service gives it. |

## 10. When you are done

1. Stop the keeper with Ctrl+C.
2. Close both terminals. This clears every variable you exported there.
3. If you used the keystore, delete the two values: **[Not run at all]**

   ```sh
   npx hardhat keystore delete TRIGGER_SEPOLIA_RPC_URL
   npx hardhat keystore delete TRIGGER_SEPOLIA_PRIVATE_KEY
   ```

   You should see that each key was deleted. `npx hardhat keystore list` should no longer show them.

4. If a key or the node URL was ever shown on a screenshot or pasted anywhere, treat it as leaked: create a new endpoint key at your node service, and stop using that wallet.
5. ETH left in the mock swap venue stays there; anyone can swap it out. Nobody, you included, can take it back otherwise: the contracts have no admin.
