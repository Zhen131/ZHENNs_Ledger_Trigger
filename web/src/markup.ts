// The page's markup. It holds no data: the controllers fill it in.

import { WALLET_ICON } from "./icons.ts";

export const PAGE_MARKUP = `
<main class="page">
  <header class="page-head">
    <p class="eyebrow">Ledger Trigger · local chain demo</p>
    <h1 class="page-title">Ledger Trigger</h1>
    <p class="page-lede">Orders that buy ETH with USDC when the price is right: a limit order, a dormant limit order that wakes at an activation price, a Dca order that buys a little in every period, and a Ladder order that buys tier by tier on the way down. Everything here runs on a local Hardhat chain.</p>
  </header>

  <section class="card bar" aria-label="Contract and wallet">
    <form id="contract-form" class="bar-contract" novalidate>
      <label class="field field-grow">
        <span class="field-label">Contract address</span>
        <input id="contract-input" class="input mono" placeholder="0x…" autocomplete="off" spellcheck="false" />
      </label>
      <button class="button button-secondary" type="submit">Load</button>
    </form>
    <div class="bar-wallet">
      <button id="connect" class="button button-primary" type="button">${WALLET_ICON}<span id="connect-label">Connect wallet</span></button>
      <p id="wallet-status" class="wallet-status">Not connected</p>
    </div>
    <p id="contract-limits" class="limits" hidden></p>
    <p id="page-notice" class="notice" role="status" hidden></p>
  </section>

  <section class="metrics" aria-label="Price and balances">
    <article class="card metric">
      <p class="metric-label">ETH / USD</p>
      <p id="metric-price" class="metric-value">—</p>
      <p id="metric-price-note" class="metric-note">Load the contract to read the price</p>
    </article>
    <article class="card metric">
      <p class="metric-label">My USDC</p>
      <p id="metric-usdc" class="metric-value">—</p>
      <p id="metric-usdc-note" class="metric-note">Connect a wallet to see it</p>
    </article>
    <article class="card metric">
      <p class="metric-label">Recipient's ETH</p>
      <p id="metric-eth" class="metric-value">—</p>
      <p id="metric-eth-note" class="metric-note">Enter a recipient in the order form</p>
    </article>
  </section>

  <section class="card" aria-labelledby="order-title">
    <h2 id="order-title" class="card-title">Place an order</h2>
    <p id="order-lede" class="card-lede"></p>
    <form id="order-form" class="order-form" novalidate>
      <fieldset class="kind-picker">
        <legend class="field-label">Kind</legend>
        <div class="kind-options">
          <label class="kind-option"><input type="radio" name="order-kind" value="limit" checked /><span>Limit</span></label>
          <label class="kind-option"><input type="radio" name="order-kind" value="dormant-limit" /><span>Dormant limit</span></label>
          <label class="kind-option"><input type="radio" name="order-kind" value="dca" /><span>Dca</span></label>
          <label class="kind-option"><input type="radio" name="order-kind" value="ladder" /><span>Ladder</span></label>
        </div>
      </fieldset>
      <label class="field" data-kinds="limit dormant-limit">
        <span class="field-label">Amount (USDC)</span>
        <input id="order-usdc" class="input num" inputmode="decimal" placeholder="100" autocomplete="off" />
      </label>
      <label class="field" data-kinds="limit dormant-limit">
        <span class="field-label">Target price (USD)</span>
        <input id="order-target" class="input num" inputmode="decimal" placeholder="1500" autocomplete="off" />
      </label>
      <label class="field" data-kinds="dormant-limit">
        <span class="field-label">Activation price (USD)</span>
        <input id="order-activation" class="input num" inputmode="decimal" placeholder="2100" autocomplete="off" />
      </label>
      <label class="field" data-kinds="dca">
        <span class="field-label">USDC per period</span>
        <input id="dca-usdc" class="input num" inputmode="decimal" placeholder="10" autocomplete="off" />
      </label>
      <label class="field" data-kinds="dca">
        <span class="field-label">Price cap (USD)</span>
        <input id="dca-cap" class="input num" inputmode="decimal" placeholder="2100" autocomplete="off" />
      </label>
      <label class="field" data-kinds="dca">
        <span class="field-label">Every (days)</span>
        <input id="dca-days" class="input num" inputmode="numeric" value="1" autocomplete="off" />
      </label>
      <label class="field" data-kinds="dca">
        <span class="field-label">Periods</span>
        <input id="dca-periods" class="input num" inputmode="numeric" placeholder="3" autocomplete="off" />
      </label>
      <label class="field" data-kinds="dca">
        <span class="field-label">Activation price (USD, optional)</span>
        <input id="dca-activation" class="input num" inputmode="decimal" autocomplete="off" />
      </label>
      <div class="tiers" data-kinds="ladder">
        <div id="tier-rows" class="tier-rows"></div>
        <div class="tier-actions">
          <button id="tier-add" class="button button-secondary button-small" type="button">Add tier</button>
          <span id="tier-limit" class="hint"></span>
        </div>
      </div>
      <label class="field" data-kinds="ladder">
        <span class="field-label">Activation price (USD, optional)</span>
        <input id="ladder-activation" class="input num" inputmode="decimal" autocomplete="off" />
      </label>
      <label class="field" data-kinds="limit dormant-limit ladder">
        <span class="field-label">Valid for (minutes)</span>
        <input id="order-minutes" class="input num" inputmode="numeric" value="60" autocomplete="off" />
      </label>
      <label class="field field-wide field-recipient">
        <span class="field-label">Recipient</span>
        <input id="order-recipient" class="input mono" placeholder="0x…" autocomplete="off" spellcheck="false" />
        <span class="field-hint">who receives the ETH</span>
      </label>
      <label class="field field-wide">
        <span class="field-label">Executor</span>
        <input id="order-executor" class="input mono" placeholder="0x…" autocomplete="off" spellcheck="false" />
        <span class="field-hint">the keeper's account</span>
      </label>
      <div class="form-actions">
        <button id="order-submit" class="button button-primary" type="submit">Place order</button>
        <p id="order-hint" class="hint"></p>
      </div>
    </form>
    <p id="order-message" class="message message-error" role="alert" hidden></p>
    <div id="order-steps" class="tx-steps" aria-live="polite"></div>
  </section>

  <section class="card" aria-labelledby="orders-title">
    <div class="card-head">
      <h2 id="orders-title" class="card-title">My orders</h2>
      <form id="lookup-form" class="lookup" novalidate>
        <label class="field">
          <span class="field-label">Look up order #</span>
          <input id="lookup-input" class="input num lookup-input" inputmode="numeric" autocomplete="off" />
        </label>
        <button class="button button-secondary" type="submit">Look up</button>
      </form>
    </div>
    <div id="lookup-result" class="lookup-result" hidden></div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col" class="num">Amount (USDC)</th>
            <th scope="col" class="num">Target (USD)</th>
            <th scope="col">Fills</th>
            <th scope="col">Expires</th>
            <th scope="col">Status</th>
            <th scope="col" class="actions-col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody id="my-orders"></tbody>
      </table>
    </div>
    <p id="my-orders-empty" class="empty">Connect a wallet to see your orders.</p>
  </section>

  <section class="card" aria-labelledby="feed-title">
    <h2 id="feed-title" class="card-title">Events</h2>
    <p class="card-lede">Everyone's orders on this contract, newest first, up to 50.</p>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col" class="num">Block</th>
            <th scope="col">Event</th>
            <th scope="col" class="num">Order</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody id="feed"></tbody>
      </table>
    </div>
    <p id="feed-empty" class="empty">No events yet.</p>
  </section>
</main>
`;
