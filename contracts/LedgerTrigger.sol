// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {ISwapVenue} from "./interfaces/ISwapVenue.sol";

/// @title LedgerTrigger
/// @author Zhen Zhu
/// @notice Limit orders to buy ETH with USDC. Anyone can place an order with a USDC amount, a
/// target price, a recipient for the ETH, an executor and an expiry; the owner can cancel it.
/// Placing and cancelling an order move no tokens and no ETH. Once the price feed reports a price
/// at or below the target, the owner or the executor can fill the order: only then is the USDC
/// taken from the owner, swapped for ETH at the swap venue and the ETH sent to the recipient.
/// An order can also be placed dormant, with an activation price above its target price: it
/// cannot be filled until the price feed reports a price at or above the activation price and
/// the owner or the executor activates it. Activating moves no tokens and no ETH either; from
/// then on the order is open and waits for the price to fall back to its target.
/// An order can also be time-scheduled: from its start time on, it buys a set amount of USDC's
/// worth of ETH once in each period, for a number of periods, each time at no more than its
/// target price. A period that passes without a fill is skipped for good. The owner approves the
/// whole budget once; each fill takes the amount of one period. Such an order is partly filled
/// after its first fill and filled after its last.
/// An order can also be laddered: it has a few tiers, each a price and an amount of USDC, at
/// strictly falling prices. Its tiers are bought one at a time, in order: each fill buys the next
/// tier's amount at no more than that tier's price, so a price that falls through several tiers
/// at once still fills only the next one. Here too the owner approves the whole budget once, and
/// the order is partly filled after its first fill and filled after its last.
/// @dev There is no admin: no pause, no upgrade, no setter and no withdrawal. The nine deployment
/// parameters can never change. The status `Expired` is never stored; `statusOf` works it out from
/// the expiry. A fill keeps none of the USDC and ETH it moves: it passes all of both straight
/// through. USDC sent straight to this contract cannot be refused, and stays here for good, as
/// nothing can take it out.
/// Two errors in its interface come from OpenZeppelin: `ReentrancyGuardReentrantCall` (a call to
/// `fillOrder` made while a fill is running) and `SafeERC20FailedOperation` (a USDC transfer that
/// returned something other than true, such as false, instead of reverting, or an approval of the
/// swap venue that returned false when tried again; see `fillOrder`). A USDC call that reverts is
/// not turned into that error: its own revert data is passed on unchanged, even when it is empty.
/// The one exception is the first try of each approval of the swap venue: if it reverts, it is
/// tried again (see `fillOrder`).
contract LedgerTrigger is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What kind of order it is.
    /// @dev `Limit`: one fill that spends the whole amount, at no more than the target price.
    /// `Dca`: a set amount bought once per period over a number of periods. `Ladder`: amounts
    /// bought one tier at a time, at falling prices. `createOrder` and `createDormantOrder` place
    /// `Limit` orders, `createDcaOrder` places `Dca` orders and `createLadderOrder` places
    /// `Ladder` orders.
    enum OrderKind {
        Limit,
        Dca,
        Ladder
    }

    /// @notice Where an order stands.
    /// @dev `None`: no order has this ID. `Dormant`: placed with an activation price and not yet
    /// activated; it cannot be filled. `Open`: can be filled. `PartiallyFilled`: has had some of
    /// its fills, not all of them; it can be filled again. `Filled` and `Cancelled` are final.
    /// `Expired` is never stored: `statusOf` reports it for an order stored as `Dormant`, `Open`
    /// or `PartiallyFilled` whose expiry has passed.
    enum OrderStatus {
        None,
        Dormant,
        Open,
        PartiallyFilled,
        Filled,
        Cancelled,
        Expired
    }

    /// @notice Why an order cannot be filled right now, as reported by `canFill`.
    /// @dev `None`: nothing stops it. `NotOpen`: its stored status is `Filled` or `Cancelled`.
    /// `Dormant`: it has not been activated. `Expired`: its expiry has passed. `NotStarted`: a
    /// `Dca` order whose first period has not begun. `PeriodAlreadyFilled`: a `Dca` order whose
    /// current period has been bought already. `InvalidPrice`: the feed's price is zero or below,
    /// or its update time is after the current block's time. `StalePrice`: the price is older than
    /// `maxPriceAge`. `PriceAboveTarget`: the price is above the most this fill may pay, which is
    /// the order's target price, or for a `Ladder` order the price of its next tier; for a `Dca`
    /// order the target price is the cap of every period. `InsufficientAllowance`: the owner's USDC
    /// allowance to this contract is below the amount of this fill, which for a `Dca` order is its
    /// amount per period and for a `Ladder` order the amount of its next tier.
    /// `InsufficientBalance`: the owner's USDC balance is below the amount of this fill. When
    /// several apply, the first in this list is reported.
    enum FillBlocker {
        None,
        NotOpen,
        Dormant,
        Expired,
        NotStarted,
        PeriodAlreadyFilled,
        InvalidPrice,
        StalePrice,
        PriceAboveTarget,
        InsufficientAllowance,
        InsufficientBalance
    }

    /// @notice Why a dormant order cannot be activated right now, as reported by `canActivate`.
    /// @dev `None`: nothing stops it. `NotDormant`: its stored status is not `Dormant`. `Expired`:
    /// its expiry has passed. `InvalidPrice`: the feed's price is zero or below, or its update
    /// time is after the current block's time. `StalePrice`: the price is older than
    /// `maxPriceAge`. `PriceBelowActivation`: the price is below the order's activation price.
    /// When several apply, the first in this list is reported.
    enum ActivationBlocker {
        None,
        NotDormant,
        Expired,
        InvalidPrice,
        StalePrice,
        PriceBelowActivation
    }

    /// @notice One order. Orders are never deleted, and their owner, executor and recipient never
    /// change.
    /// @dev Fields: `owner` placed the order. `executor` is the one address besides the owner that
    /// the owner names for activating and filling it. `recipient` receives the ETH. `kind` is the
    /// kind of order. `status` is the stored status and is never `Expired`. `usdcAmount` is the
    /// USDC budget of the whole order, in the token's smallest unit: for a `Dca` order, its amount
    /// per period times its number of periods; for a `Ladder` order, the amounts of its tiers
    /// added up. `usdcRemaining` is the part of that budget not spent yet: `usdcAmount` when the
    /// order is placed, less the amount of each fill. `targetPrice` is the ETH price in USD, with
    /// the price feed's decimals, above which a fill is refused; for a `Ladder` order it is the
    /// price of tier 0, the highest, and each fill is held to the price of the tier it buys.
    /// `activationPrice` is zero for an order that is `Open` once placed; otherwise the order is
    /// placed `Dormant` and can be activated once the price is at or above it, and it keeps its
    /// value after the activation. `fillsTotal` is how many fills the order takes in all, and
    /// `fillsDone` how many it has had. `createdAt` is the time of the block that placed the order.
    /// `expiry` is the last second, in Unix time, at which the order is still valid; for a `Dca`
    /// order it is worked out from the schedule: the last second of its last period.
    struct Order {
        address owner;
        address executor;
        address recipient;
        OrderKind kind;
        OrderStatus status;
        uint256 usdcAmount;
        uint256 usdcRemaining;
        uint256 targetPrice;
        uint256 activationPrice;
        uint256 fillsTotal;
        uint256 fillsDone;
        uint256 createdAt;
        uint256 expiry;
    }

    /// @notice The unfinished orders of one owner: how many there are and the USDC they have
    /// left to spend, added up.
    /// @dev An order counts here while its stored status is `Dormant`, `Open` or
    /// `PartiallyFilled`, expired or not; `total` adds up the `usdcRemaining` of those orders.
    struct OpenOrders {
        uint256 count;
        uint256 total;
    }

    /// @notice The schedule of a time-scheduled (`Dca`) order. Period p, counting from 0, is the
    /// seconds from `startAt + p * periodLength` to `startAt + (p + 1) * periodLength - 1`; the
    /// current period is `(now - startAt) / periodLength`, rounded down.
    /// @dev Fields: `startAt` is the time, in Unix seconds, at which period 0 begins.
    /// `periodLength` is the length of one period, in seconds. `usdcPerPeriod` is the USDC one
    /// fill spends, in the token's smallest unit. `filledThrough` is the first period that may
    /// still be bought: zero at first, and p + 1 once period p has been bought, so a period that
    /// was skipped can never be bought later. The number of periods is the order's `fillsTotal`.
    struct DcaSchedule {
        uint256 startAt;
        uint256 periodLength;
        uint256 usdcPerPeriod;
        uint256 filledThrough;
    }

    /// @notice The inputs of `createDcaOrder`.
    /// @dev Fields: `usdcPerPeriod` is the USDC bought in each period, in the token's smallest
    /// unit. `targetPrice` is the ETH price in USD, with the price feed's decimals, above which no
    /// period is bought. `periodLength` is the length of one period, in seconds. `periodCount` is
    /// the number of periods. `startAt` is the time, in Unix seconds, at which period 0 begins, or
    /// zero for the time of the block that places the order. `activationPrice` is zero for an
    /// order that is `Open` once placed; otherwise the order is placed `Dormant`. `recipient`
    /// receives the ETH, and `executor` is the address the owner names for activating and filling
    /// the order.
    struct DcaOrderParams {
        uint256 usdcPerPeriod;
        uint256 targetPrice;
        uint256 periodLength;
        uint256 periodCount;
        uint256 startAt;
        uint256 activationPrice;
        address recipient;
        address executor;
    }

    /// @notice One tier of a `Ladder` order: a price and the USDC that the tier spends once the
    /// price feed reports a price at or below it.
    /// @dev Fields: `price` is the most this tier's fill may pay, an ETH price in USD with the
    /// price feed's decimals. `usdcAmount` is the USDC this tier's fill spends, in the token's
    /// smallest unit.
    struct Tier {
        uint256 price;
        uint256 usdcAmount;
    }

    /// @notice The inputs of `createLadderOrder`.
    /// @dev Fields: `tiers` are the order's tiers, in the order they are filled: tier 0 has the
    /// highest price and is filled first, and each later tier's price is strictly below the one
    /// before it. `activationPrice` is zero for an order that is `Open` once placed; otherwise the
    /// order is placed `Dormant`, and the price must be above the price of tier 0. `recipient`
    /// receives the ETH, and `executor` is the address the owner names for activating and filling
    /// the order. `expiry` is the last second, in Unix time, at which the order is valid.
    struct LadderOrderParams {
        Tier[] tiers;
        uint256 activationPrice;
        address recipient;
        address executor;
        uint256 expiry;
    }

    /// @notice What the fill checks found for one order: the first reason it cannot be filled,
    /// and the values read on the way.
    /// @dev Fields: `blocker` is `None` when the order can be filled. `amount` is the USDC this
    /// fill spends and `priceCap` the highest feed price at which it may go ahead: a `Limit`
    /// order spends all of its `usdcRemaining` and a `Dca` order the `usdcPerPeriod` of its
    /// schedule, both with the order's `targetPrice` as the cap; a `Ladder` order spends the
    /// amount of its next tier, with that tier's price as the cap. `price` and `updatedAt` are the
    /// feed's answer and update time. `allowance` and `balance` are the owner's USDC allowance to
    /// this contract and USDC balance. `period` is, for a `Dca` order, the current period,
    /// counting from 0. A value is zero when the checks stopped before working it out or reading
    /// it.
    struct FillCheck {
        FillBlocker blocker;
        uint256 amount;
        uint256 priceCap;
        int256 price;
        uint256 updatedAt;
        uint256 allowance;
        uint256 balance;
        uint256 period;
    }

    /// @notice What the activation checks found for one order: the first reason it cannot be
    /// activated, and the values read on the way.
    /// @dev Fields: `blocker` is `None` when the order can be activated. `price` and `updatedAt`
    /// are the feed's answer and update time, zero when the checks stopped before reading them.
    struct ActivationCheck {
        ActivationBlocker blocker;
        int256 price;
        uint256 updatedAt;
    }

    /// @notice Basis points in 100 %.
    uint256 private constant BPS = 10_000;
    /// @notice Largest slippage accepted at deployment: just under 100 %.
    uint256 private constant MAX_SLIPPAGE_BPS = BPS - 1;
    /// @notice ETH has 18 decimals.
    uint256 private constant ETH_DECIMALS = 18;

    /// @notice The USDC token that orders spend. Set at deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    IERC20 public immutable usdc;
    /// @notice The price feed for ETH in USD. Set at deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    IPriceFeed public immutable priceFeed;
    /// @notice The swap venue that turns USDC into ETH. Set at deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    ISwapVenue public immutable swapVenue;
    /// @notice Largest amount of USDC one fill may spend, in the token's smallest unit: the whole
    /// `usdcAmount` of a `Limit` order, the amount per period of a `Dca` order, the amount of each
    /// tier of a `Ladder` order. The whole budget of a `Dca` or `Ladder` order may be above it.
    /// Set at deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxOrderAmount;
    /// @notice Largest number of unfinished orders one owner can have at the same time. Set at
    /// deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxOpenOrdersPerOwner;
    /// @notice Oldest price, in seconds since its update, that still counts as current. Set at
    /// deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxPriceAge;
    /// @notice Allowed price slippage in basis points (100 is 1 %). Set at deployment, never
    /// changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxSlippageBps;
    /// @notice Largest number of periods of one `Dca` order. Set at deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxPeriodsPerOrder;
    /// @notice Largest number of tiers of one `Ladder` order. Set at deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxTiersPerOrder;
    /// @notice Decimals of `usdc`, read from the token at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint8 public immutable usdcDecimals;
    /// @notice Decimals of `priceFeed`, read from the feed at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint8 public immutable priceDecimals;

    /// @notice Order ID to order. IDs start at 1; ID 0 is never used.
    mapping(uint256 orderId => Order order) private orders;
    /// @notice Owner to the count and the USDC total of their unfinished orders.
    mapping(address owner => OpenOrders open) private openOrdersOf;
    /// @notice ID of the newest order, or 0 before the first one.
    uint256 private lastOrderId;
    /// @notice Order ID to schedule, for `Dca` orders only.
    mapping(uint256 orderId => DcaSchedule schedule) private schedules;
    /// @notice Order ID to tiers, for `Ladder` orders only. The tiers are stored as given and never
    /// change; the order's `fillsDone` is the index of its next tier.
    mapping(uint256 orderId => Tier[] tiers) private tiersOf;

    /// @notice An order was placed.
    /// @param orderId ID of the new order.
    /// @param owner The account that placed it.
    /// @param executor The address the owner names for filling it.
    /// @param recipient Where the ETH goes.
    /// @param usdcAmount USDC budget of the whole order, in the token's smallest unit.
    /// @param targetPrice ETH price in USD, with the price feed's decimals.
    /// @param expiry Last second at which the order is valid.
    /// @param kind The kind of order.
    /// @param activationPrice Zero for an order placed `Open`; otherwise the order was placed
    /// `Dormant`, and this is the price, with the price feed's decimals, at or above which it can
    /// be activated.
    event OrderCreated(
        uint256 indexed orderId,
        address indexed owner,
        address indexed executor,
        address recipient,
        uint256 usdcAmount,
        uint256 targetPrice,
        uint256 expiry,
        OrderKind kind,
        uint256 activationPrice
    );

    /// @notice A time-scheduled (`Dca`) order was placed. Emitted right after its `OrderCreated`.
    /// @param orderId ID of the new order.
    /// @param startAt Time, in Unix seconds, at which period 0 begins: the time given, or the
    /// time of the block that placed the order when zero was given.
    /// @param periodLength Length of one period, in seconds.
    /// @param periodCount Number of periods.
    /// @param usdcPerPeriod USDC bought in each period, in the token's smallest unit.
    event OrderScheduled(
        uint256 indexed orderId,
        uint256 indexed startAt,
        uint256 indexed periodLength,
        uint256 periodCount,
        uint256 usdcPerPeriod
    );

    /// @notice A `Ladder` order was placed. Emitted right after its `OrderCreated`.
    /// @dev Only `orderId` is indexed: an indexed array of structs would be logged as its hash
    /// alone, and the tiers could not be read back from the log.
    /// @param orderId ID of the new order.
    /// @param tiers All of its tiers, as given, in the order they are filled.
    event OrderTiered(uint256 indexed orderId, Tier[] tiers);

    /// @notice A dormant order was activated: it is `Open` from now on.
    /// @param orderId ID of the order.
    /// @param activatedBy The account that activated it: the owner or the order's executor.
    /// @param price The price feed's price at activation, with the feed's decimals.
    event OrderActivated(
        uint256 indexed orderId,
        address indexed activatedBy,
        uint256 indexed price
    );

    /// @notice An order was cancelled by its owner.
    /// @param orderId ID of the order.
    /// @param owner The order's owner, who cancelled it.
    /// @param afterExpiry True if the order's expiry had already passed when it was cancelled.
    event OrderCancelled(
        uint256 indexed orderId,
        address indexed owner,
        bool indexed afterExpiry
    );

    /// @notice An order was filled: USDC of the order was swapped for ETH and the ETH sent to its
    /// recipient.
    /// @param orderId ID of the order.
    /// @param owner The order's owner, whose USDC was spent.
    /// @param filledBy The account that filled it: the owner or the order's executor.
    /// @param recipient Where the ETH went.
    /// @param usdcAmount USDC spent by this fill, in the token's smallest unit.
    /// @param ethReceived ETH, in wei, that the swap brought in and the recipient received.
    /// @param price The price feed's price used for the fill, with the feed's decimals.
    /// @param fillNumber Which fill of the order this is, counting from 1.
    /// @param fillsTotal How many fills the order takes in all.
    event OrderFilled(
        uint256 indexed orderId,
        address indexed owner,
        address indexed filledBy,
        address recipient,
        uint256 usdcAmount,
        uint256 ethReceived,
        uint256 price,
        uint256 fillNumber,
        uint256 fillsTotal
    );

    /// @notice No order has this ID.
    /// @param orderId The ID asked for.
    error OrderNotFound(uint256 orderId);
    /// @notice Only the order's owner may do this.
    /// @param orderId The order.
    /// @param caller The account that tried.
    error NotOrderOwner(uint256 orderId, address caller);
    /// @notice The order's stored status does not allow this: a fill needs `Open` or
    /// `PartiallyFilled`, and a cancellation `Dormant`, `Open` or `PartiallyFilled`.
    /// @param orderId The order.
    /// @param status Its stored status.
    error OrderNotOpen(uint256 orderId, OrderStatus status);
    /// @notice The order amount, or the amount per period of a `Dca` order, or the amount of a
    /// tier of a `Ladder` order, is zero.
    error ZeroAmount();
    /// @notice The order amount, or the amount per period of a `Dca` order, or the amount of a
    /// tier of a `Ladder` order, is above `maxOrderAmount`.
    /// @param amount The amount asked for: the order amount, the amount per period, or the amount
    /// of the tier.
    /// @param max The largest amount allowed.
    error AmountAboveMax(uint256 amount, uint256 max);
    /// @notice The target price, which for a `Dca` order is the cap of every period, or the price
    /// of a tier of a `Ladder` order, is zero.
    error ZeroTargetPrice();
    /// @notice The recipient is the zero address.
    error ZeroRecipient();
    /// @notice The executor is the zero address.
    error ZeroExecutor();
    /// @notice The expiry is not after the current block's time.
    /// @param expiry The expiry asked for, or for a `Dca` order the one worked out from its
    /// schedule.
    /// @param currentTime The current block's time.
    error ExpiryNotInFuture(uint256 expiry, uint256 currentTime);
    /// @notice The caller already has `maxOpenOrdersPerOwner` unfinished orders.
    /// @param owner The caller.
    /// @param max The largest number of unfinished orders allowed.
    error TooManyOpenOrders(address owner, uint256 max);
    /// @notice Only the order's owner or its executor may do this.
    /// @param orderId The order.
    /// @param caller The account that tried.
    error NotOrderOwnerOrExecutor(uint256 orderId, address caller);
    /// @notice The order's expiry has passed.
    /// @param orderId The order.
    /// @param expiry Its expiry: the last second at which it was valid.
    error OrderExpired(uint256 orderId, uint256 expiry);
    /// @notice The price feed's price is zero or below, or its update time is after the current
    /// block's time.
    /// @param price The price the feed reported.
    error InvalidPrice(int256 price);
    /// @notice The price feed's price is older than `maxPriceAge`.
    /// @param updatedAt When the feed last updated the price.
    /// @param maxPriceAge The oldest price age allowed, in seconds.
    error StalePrice(uint256 updatedAt, uint256 maxPriceAge);
    /// @notice The price feed's price is above the most this fill may pay: the order's target
    /// price, or for a `Ladder` order the price of its next tier. For a `Dca` order the target
    /// price is the cap of every period.
    /// @param price The price the feed reported.
    /// @param targetPrice The most this fill may pay.
    error PriceAboveTarget(uint256 price, uint256 targetPrice);
    /// @notice The owner's USDC allowance to this contract is below the amount of this fill, which
    /// for a `Dca` order is its amount per period and for a `Ladder` order the amount of its next
    /// tier.
    /// @param allowance The allowance the owner has given.
    /// @param needed The amount of this fill.
    error InsufficientAllowance(uint256 allowance, uint256 needed);
    /// @notice The owner's USDC balance is below the amount of this fill, which for a `Dca` order
    /// is its amount per period and for a `Ladder` order the amount of its next tier.
    /// @param balance The owner's balance.
    /// @param needed The amount of this fill.
    error InsufficientBalance(uint256 balance, uint256 needed);
    /// @notice After the swap, this contract's USDC balance is not what it was before the USDC
    /// was taken from the owner, so the swap venue did not take exactly the amount of the fill.
    /// @param expectedBalance This contract's USDC balance before the fill took any USDC.
    /// @param actualBalance This contract's USDC balance after the swap.
    error SwapUsdcMismatch(uint256 expectedBalance, uint256 actualBalance);
    /// @notice The swap brought in less ETH than the minimum the fill accepts.
    /// @param received ETH, in wei, by which this contract's balance went up during the swap.
    /// @param minEthOut The minimum, in wei.
    error InsufficientEthOut(uint256 received, uint256 minEthOut);
    /// @notice Sending the ETH to the recipient failed.
    /// @param recipient The order's recipient.
    /// @param amount ETH, in wei, that could not be sent.
    error EthTransferFailed(address recipient, uint256 amount);
    /// @notice ETH was sent to this contract by an account other than the swap venue.
    /// @param sender The account that sent it.
    error UnexpectedEthSender(address sender);
    /// @notice Deployment: the USDC address is the zero address.
    error ZeroUsdc();
    /// @notice Deployment: the price feed address is the zero address.
    error ZeroPriceFeed();
    /// @notice Deployment: the swap venue address is the zero address.
    error ZeroSwapVenue();
    /// @notice Deployment: `maxOrderAmount` is zero.
    error ZeroMaxOrderAmount();
    /// @notice Deployment: `maxOpenOrdersPerOwner` is zero.
    error ZeroMaxOpenOrdersPerOwner();
    /// @notice Deployment: `maxPriceAge` is zero.
    error ZeroMaxPriceAge();
    /// @notice Deployment: `maxSlippageBps` is 100 % (10000) or more.
    /// @param maxSlippageBps The rejected value, in basis points.
    error SlippageTooHigh(uint256 maxSlippageBps);
    /// @notice The order's stored status is not `Dormant`, so it cannot be activated.
    /// @param orderId The order.
    /// @param status Its stored status.
    error OrderNotDormant(uint256 orderId, OrderStatus status);
    /// @notice The price feed's price is below the order's activation price.
    /// @param price The price the feed reported.
    /// @param activationPrice The order's activation price.
    error PriceBelowActivation(uint256 price, uint256 activationPrice);
    /// @notice The activation price of a dormant order is not above its target price, which for a
    /// `Ladder` order is the price of tier 0.
    /// @param activationPrice The activation price asked for.
    /// @param targetPrice The target price asked for, or the price of tier 0.
    error ActivationNotAboveTarget(
        uint256 activationPrice,
        uint256 targetPrice
    );
    /// @notice Deployment: `maxPeriodsPerOrder` is zero.
    error ZeroMaxPeriodsPerOrder();
    /// @notice Deployment: `maxTiersPerOrder` is zero.
    error ZeroMaxTiersPerOrder();
    /// @notice The period length of a `Dca` order is zero.
    error ZeroPeriodLength();
    /// @notice The number of periods of a `Dca` order is zero.
    error ZeroPeriodCount();
    /// @notice The number of periods of a `Dca` order is above `maxPeriodsPerOrder`.
    /// @param periodCount The number of periods asked for.
    /// @param maxPeriods The largest number of periods allowed.
    error TooManyPeriods(uint256 periodCount, uint256 maxPeriods);
    /// @notice The start time of a `Dca` order is not zero and is before the current block's time.
    /// @param startAt The start time asked for.
    /// @param currentTime The current block's time.
    error StartInPast(uint256 startAt, uint256 currentTime);
    /// @notice The first period of a `Dca` order has not begun yet.
    /// @param orderId The order.
    /// @param startAt The time at which its first period begins.
    error NotStarted(uint256 orderId, uint256 startAt);
    /// @notice The current period of a `Dca` order has been bought already.
    /// @param orderId The order.
    /// @param periodIndex The current period, counting from 0.
    error PeriodAlreadyFilled(uint256 orderId, uint256 periodIndex);
    /// @notice The order is not a `Dca` order, so it has no schedule.
    /// @param orderId The order.
    error NotADcaOrder(uint256 orderId);
    /// @notice A `Ladder` order was given no tiers.
    error NoTiers();
    /// @notice A `Ladder` order was given more tiers than `maxTiersPerOrder`.
    /// @param tierCount The number of tiers given.
    /// @param maxTiers The largest number of tiers allowed.
    error TooManyTiers(uint256 tierCount, uint256 maxTiers);
    /// @notice The price of a tier of a `Ladder` order is not strictly below the price of the tier
    /// before it.
    /// @param tierIndex The tier, counting from 0; never 0, as tier 0 has no tier before it.
    error TiersNotDescending(uint256 tierIndex);
    /// @notice The order is not a `Ladder` order, so it has no tiers.
    /// @param orderId The order.
    error NotALadderOrder(uint256 orderId);

    /// @notice Rejects an ID that no order has, with `OrderNotFound`.
    /// @param orderId The order.
    modifier orderExists(uint256 orderId) {
        if (orders[orderId].status == OrderStatus.None) {
            revert OrderNotFound(orderId);
        }
        _;
    }

    /// @notice Rejects any caller other than the order's owner, with `NotOrderOwner`.
    /// @param orderId The order.
    modifier onlyOrderOwner(uint256 orderId) {
        if (msg.sender != orders[orderId].owner) {
            revert NotOrderOwner(orderId, msg.sender);
        }
        _;
    }

    /// @notice Rejects any caller other than the order's owner and its executor, with
    /// `NotOrderOwnerOrExecutor`.
    /// @param orderId The order.
    modifier onlyOrderOwnerOrExecutor(uint256 orderId) {
        Order storage order = orders[orderId];
        if (msg.sender != order.owner && msg.sender != order.executor) {
            revert NotOrderOwnerOrExecutor(orderId, msg.sender);
        }
        _;
    }

    /// @notice Lets through only an order whose stored status is `Open` or `PartiallyFilled`, the
    /// two a fill accepts; rejects any other with `OrderNotOpen`. An expired order keeps its
    /// stored status here.
    /// @param orderId The order.
    modifier onlyOpen(uint256 orderId) {
        OrderStatus status = orders[orderId].status;
        if (!_isOpen(status)) revert OrderNotOpen(orderId, status);
        _;
    }

    /// @notice Lets through only an order whose stored status is `Dormant`, `Open` or
    /// `PartiallyFilled`, the three a cancellation accepts; rejects a finished one with
    /// `OrderNotOpen`. An expired order keeps its stored status here.
    /// @param orderId The order.
    modifier onlyUnfinished(uint256 orderId) {
        OrderStatus status = orders[orderId].status;
        if (!_isUnfinished(status)) revert OrderNotOpen(orderId, status);
        _;
    }

    /// @notice Lets through only an order whose stored status is `Dormant`, the one an activation
    /// accepts; rejects any other with `OrderNotDormant`. An expired order keeps its stored status
    /// here.
    /// @param orderId The order.
    modifier onlyDormant(uint256 orderId) {
        OrderStatus status = orders[orderId].status;
        if (status != OrderStatus.Dormant) {
            revert OrderNotDormant(orderId, status);
        }
        _;
    }

    /// @notice Deploys the contract with its nine parameters, none of which can change later.
    /// @dev Checks, in order: the three addresses are not the zero address (`ZeroUsdc`,
    /// `ZeroPriceFeed`, `ZeroSwapVenue`); `maxOrderAmount_`, `maxOpenOrdersPerOwner_` and
    /// `maxPriceAge_` are above zero (`ZeroMaxOrderAmount`, `ZeroMaxOpenOrdersPerOwner`,
    /// `ZeroMaxPriceAge`); `maxSlippageBps_` is below 10000 (`SlippageTooHigh`), zero allowed;
    /// `maxPeriodsPerOrder_` and `maxTiersPerOrder_` are above zero (`ZeroMaxPeriodsPerOrder`,
    /// `ZeroMaxTiersPerOrder`). Only then does it read the decimals of the token and of the price
    /// feed and store them; it also reverts if either of them does not report its decimals.
    /// @param usdc_ The USDC token (an ERC-20 token address).
    /// @param priceFeed_ The price feed for ETH in USD (a Chainlink-style feed address).
    /// @param swapVenue_ The swap venue (an `ISwapVenue` address).
    /// @param maxOrderAmount_ Largest amount one fill may spend, in the token's smallest unit: the
    /// amount of a `Limit` order, the amount per period of a `Dca` order, the amount of each tier
    /// of a `Ladder` order (uint256).
    /// @param maxOpenOrdersPerOwner_ Largest number of unfinished orders per owner (uint256).
    /// @param maxPriceAge_ Oldest acceptable price age, in seconds (uint256).
    /// @param maxSlippageBps_ Allowed slippage, in basis points (uint256).
    /// @param maxPeriodsPerOrder_ Largest number of periods of one `Dca` order (uint256).
    /// @param maxTiersPerOrder_ Largest number of tiers of one `Ladder` order (uint256).
    constructor(
        IERC20 usdc_,
        IPriceFeed priceFeed_,
        ISwapVenue swapVenue_,
        uint256 maxOrderAmount_,
        uint256 maxOpenOrdersPerOwner_,
        uint256 maxPriceAge_,
        uint256 maxSlippageBps_,
        uint256 maxPeriodsPerOrder_,
        uint256 maxTiersPerOrder_
    ) {
        if (address(usdc_) == address(0)) revert ZeroUsdc();
        if (address(priceFeed_) == address(0)) revert ZeroPriceFeed();
        if (address(swapVenue_) == address(0)) revert ZeroSwapVenue();
        if (maxOrderAmount_ == 0) revert ZeroMaxOrderAmount();
        if (maxOpenOrdersPerOwner_ == 0) revert ZeroMaxOpenOrdersPerOwner();
        if (maxPriceAge_ == 0) revert ZeroMaxPriceAge();
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS) {
            revert SlippageTooHigh(maxSlippageBps_);
        }
        if (maxPeriodsPerOrder_ == 0) revert ZeroMaxPeriodsPerOrder();
        if (maxTiersPerOrder_ == 0) revert ZeroMaxTiersPerOrder();

        usdc = usdc_;
        priceFeed = priceFeed_;
        swapVenue = swapVenue_;
        maxOrderAmount = maxOrderAmount_;
        maxOpenOrdersPerOwner = maxOpenOrdersPerOwner_;
        maxPriceAge = maxPriceAge_;
        maxSlippageBps = maxSlippageBps_;
        maxPeriodsPerOrder = maxPeriodsPerOrder_;
        maxTiersPerOrder = maxTiersPerOrder_;
        usdcDecimals = IERC20Metadata(address(usdc_)).decimals();
        priceDecimals = priceFeed_.decimals();
    }

    /// @notice Accepts ETH from the swap venue only: that is how a swap pays this contract during
    /// a fill.
    /// @dev Rejects ETH from any other sender (`UnexpectedEthSender`). ETH sent here by mistake
    /// would otherwise be stuck, because this contract only ever sends ETH to the recipient of the
    /// order being filled.
    receive() external payable {
        if (msg.sender != address(swapVenue)) {
            revert UnexpectedEthSender(msg.sender);
        }
    }

    /// @notice Places an `Open` order for the caller, who becomes its owner. Moves no tokens and
    /// no ETH, and needs no USDC allowance.
    /// @dev Anyone can call it. Rejects, in this order: a zero `usdcAmount` (`ZeroAmount`); a
    /// `usdcAmount` above `maxOrderAmount` (`AmountAboveMax`); a zero `targetPrice`
    /// (`ZeroTargetPrice`); a zero `recipient` (`ZeroRecipient`); a zero `executor`
    /// (`ZeroExecutor`); an `expiry` not after the current block's time (`ExpiryNotInFuture`);
    /// a caller who already has `maxOpenOrdersPerOwner` unfinished orders, expired ones included
    /// (`TooManyOpenOrders`). The executor may be the caller. The order is a `Limit` order with
    /// no activation price, filled once for its whole amount. Emits `OrderCreated`.
    /// @param usdcAmount USDC to spend, in the token's smallest unit (uint256).
    /// @param targetPrice ETH price in USD with the price feed's decimals (uint256).
    /// @param recipient Address that receives the ETH (address).
    /// @param executor Address the owner names for filling the order; may be the owner (address).
    /// @param expiry Last second, in Unix time, at which the order is valid (uint256).
    /// @return orderId ID of the new order: 1 for the first order, then one more each time
    /// (uint256).
    function createOrder(
        uint256 usdcAmount,
        uint256 targetPrice,
        address recipient,
        address executor,
        uint256 expiry
    ) external returns (uint256 orderId) {
        _requireValidAmountAndTarget(usdcAmount, targetPrice);
        _requireValidPartiesExpiryAndSlot(recipient, executor, expiry);
        orderId = _placeOrder(
            OrderKind.Limit,
            usdcAmount,
            targetPrice,
            0,
            1,
            recipient,
            executor,
            expiry
        );
    }

    /// @notice Places a `Dormant` order for the caller, who becomes its owner: a `Limit` order that
    /// cannot be filled until it has been activated, which needs the price feed to report a price
    /// at or above `activationPrice`. Once activated it is an `Open` order like one placed with
    /// `createOrder`. Moves no tokens and no ETH, and needs no USDC allowance.
    /// @dev Anyone can call it. Rejects, in this order: a zero `usdcAmount` (`ZeroAmount`); a
    /// `usdcAmount` above `maxOrderAmount` (`AmountAboveMax`); a zero `targetPrice`
    /// (`ZeroTargetPrice`); an `activationPrice` not above `targetPrice`
    /// (`ActivationNotAboveTarget`); a zero `recipient` (`ZeroRecipient`); a zero `executor`
    /// (`ZeroExecutor`); an `expiry` not after the current block's time (`ExpiryNotInFuture`); a
    /// caller who already has `maxOpenOrdersPerOwner` unfinished orders, expired ones included
    /// (`TooManyOpenOrders`). A dormant order takes one of the owner's slots and counts in the
    /// owner's open total from the moment it is placed. The executor may be the caller. Emits
    /// `OrderCreated`.
    /// @param usdcAmount USDC to spend, in the token's smallest unit (uint256).
    /// @param targetPrice ETH price in USD with the price feed's decimals (uint256).
    /// @param activationPrice ETH price in USD with the price feed's decimals at or above which the
    /// order can be activated; must be above `targetPrice` (uint256).
    /// @param recipient Address that receives the ETH (address).
    /// @param executor Address the owner names for activating and filling the order; may be the
    /// owner (address).
    /// @param expiry Last second, in Unix time, at which the order is valid (uint256).
    /// @return orderId ID of the new order, numbered with the orders `createOrder` places
    /// (uint256).
    function createDormantOrder(
        uint256 usdcAmount,
        uint256 targetPrice,
        uint256 activationPrice,
        address recipient,
        address executor,
        uint256 expiry
    ) external returns (uint256 orderId) {
        _requireValidAmountAndTarget(usdcAmount, targetPrice);
        if (!(activationPrice > targetPrice)) {
            revert ActivationNotAboveTarget(activationPrice, targetPrice);
        }
        _requireValidPartiesExpiryAndSlot(recipient, executor, expiry);
        orderId = _placeOrder(
            OrderKind.Limit,
            usdcAmount,
            targetPrice,
            activationPrice,
            1,
            recipient,
            executor,
            expiry
        );
    }

    /// @notice Places a time-scheduled (`Dca`) order for the caller, who becomes its owner: from
    /// `p.startAt` on, `p.usdcPerPeriod` can be spent once in each period of `p.periodLength`
    /// seconds, for `p.periodCount` periods, each time at no more than `p.targetPrice`. A period
    /// that passes without a fill is skipped for good. The order's budget is `p.usdcPerPeriod`
    /// times `p.periodCount`, and its expiry, worked out here, is the last second of its last
    /// period. Moves no tokens and no ETH, and needs no USDC allowance; each fill needs the
    /// allowance to cover the amount of one period.
    /// @dev Anyone can call it. Rejects, in this order: a zero `usdcPerPeriod` (`ZeroAmount`); a
    /// `usdcPerPeriod` above `maxOrderAmount` (`AmountAboveMax`; the budget itself may be above
    /// it); a zero `targetPrice` (`ZeroTargetPrice`); a zero `periodLength` (`ZeroPeriodLength`);
    /// a zero `periodCount` (`ZeroPeriodCount`); a `periodCount` above `maxPeriodsPerOrder`
    /// (`TooManyPeriods`); a `startAt` that is not zero and is before the current block's time
    /// (`StartInPast`); a zero `recipient` (`ZeroRecipient`); a zero `executor` (`ZeroExecutor`);
    /// an expiry not after the current block's time (`ExpiryNotInFuture`), which happens only for
    /// one period of one second that starts in the current block; a caller who already has
    /// `maxOpenOrdersPerOwner` unfinished orders, expired ones included (`TooManyOpenOrders`). A
    /// `startAt` of zero stands for the time of the block that places the order, and that time is
    /// stored. A product of the inputs that does not fit in 256 bits (the number of periods times
    /// their length, or times the amount per period) makes the call revert with a panic. With an
    /// `activationPrice` above zero the order is placed `Dormant` and must be activated before it
    /// can be filled; that price may be at, below or above `targetPrice`. The order takes one of
    /// the owner's slots and adds its whole budget to the owner's open total. The executor may be
    /// the caller. Emits `OrderCreated`, then `OrderScheduled`.
    /// @param p The order (a `DcaOrderParams` struct): `usdcPerPeriod`, USDC per period in the
    /// token's smallest unit; `targetPrice`, ETH price in USD with the price feed's decimals, the
    /// most any period may pay; `periodLength`, in seconds; `periodCount`; `startAt`, the Unix
    /// time at which period 0 begins, or zero; `activationPrice`, zero or the price at or above
    /// which the order can be activated; `recipient`; `executor`.
    /// @return orderId ID of the new order, numbered with the orders of the other kinds
    /// (uint256).
    function createDcaOrder(
        DcaOrderParams calldata p
    ) external returns (uint256 orderId) {
        _requireValidAmountAndTarget(p.usdcPerPeriod, p.targetPrice);
        uint256 startAt = _requireValidSchedule(p);
        uint256 expiry = startAt + p.periodCount * p.periodLength - 1;
        _requireValidPartiesExpiryAndSlot(p.recipient, p.executor, expiry);
        orderId = _placeOrder(
            OrderKind.Dca,
            p.usdcPerPeriod * p.periodCount,
            p.targetPrice,
            p.activationPrice,
            p.periodCount,
            p.recipient,
            p.executor,
            expiry
        );
        DcaSchedule storage schedule = schedules[orderId];
        schedule.startAt = startAt;
        schedule.periodLength = p.periodLength;
        schedule.usdcPerPeriod = p.usdcPerPeriod;
        // `filledThrough` starts at zero.

        emit OrderScheduled(
            orderId,
            startAt,
            p.periodLength,
            p.periodCount,
            p.usdcPerPeriod
        );
    }

    /// @notice Places a `Ladder` order for the caller, who becomes its owner: it buys ETH one tier
    /// at a time, in the order of `p.tiers`. Each fill spends the amount of the next tier, at no
    /// more than that tier's price; a price that falls through several tiers at once still fills
    /// only the next one, and a tier is never skipped or joined with another. The order's budget
    /// is the amounts of its tiers added up, and its target price is the price of tier 0, the
    /// highest. Moves no tokens and no ETH, and needs no USDC allowance; each fill needs the
    /// allowance to cover the amount of the next tier.
    /// @dev Anyone can call it. Rejects, in this order: no tiers (`NoTiers`); more tiers than
    /// `maxTiersPerOrder` (`TooManyTiers`; exactly that many is allowed); then, tier by tier from
    /// tier 0, each tier checked in full before the next: a zero amount (`ZeroAmount`), an amount
    /// above `maxOrderAmount` (`AmountAboveMax`; the budget itself may be above it), a zero price
    /// (`ZeroTargetPrice`), and from tier 1 on a price not strictly below the tier before
    /// (`TiersNotDescending`); then an `activationPrice` above zero that is not above the price of
    /// tier 0 (`ActivationNotAboveTarget`); a zero `recipient` (`ZeroRecipient`); a zero
    /// `executor` (`ZeroExecutor`); an `expiry` not after the current block's time
    /// (`ExpiryNotInFuture`); a caller who already has `maxOpenOrdersPerOwner` unfinished orders,
    /// expired ones included (`TooManyOpenOrders`). With an `activationPrice` above zero the order
    /// is placed `Dormant` and must be activated before it can be filled. The order takes one of
    /// the owner's slots and adds its whole budget to the owner's open total. The tiers are stored
    /// as given and never change. The executor may be the caller. Emits `OrderCreated`, then
    /// `OrderTiered`.
    /// @param p The order (a `LadderOrderParams` struct): `tiers`, each a `price`, the ETH price
    /// in USD with the price feed's decimals that the tier may pay at most, and a `usdcAmount`, in
    /// the token's smallest unit; `activationPrice`, zero or the price at or above which the order
    /// can be activated; `recipient`; `executor`; `expiry`, the last second, in Unix time, at
    /// which the order is valid.
    /// @return orderId ID of the new order, numbered with the orders of the other kinds
    /// (uint256).
    function createLadderOrder(
        LadderOrderParams calldata p
    ) external returns (uint256 orderId) {
        uint256 budget = _requireValidTiers(p.tiers);
        uint256 topPrice = p.tiers[0].price;
        if (p.activationPrice > 0 && !(p.activationPrice > topPrice)) {
            revert ActivationNotAboveTarget(p.activationPrice, topPrice);
        }
        _requireValidPartiesExpiryAndSlot(p.recipient, p.executor, p.expiry);
        orderId = _placeOrder(
            OrderKind.Ladder,
            budget,
            topPrice,
            p.activationPrice,
            p.tiers.length,
            p.recipient,
            p.executor,
            p.expiry
        );
        Tier[] storage tiers = tiersOf[orderId];
        uint256 tierCount = p.tiers.length;
        for (uint256 i = 0; i < tierCount; ++i) {
            tiers.push(p.tiers[i]);
        }

        emit OrderTiered(orderId, p.tiers);
    }

    /// @notice Activates a dormant order once the price has risen to its activation price: the
    /// order goes from `Dormant` to `Open` and can be filled from then on. Moves no tokens and no
    /// ETH, calls neither the USDC token nor the swap venue, and leaves the owner's open count and
    /// total as they were.
    /// @dev Only the order's owner or its executor can call it. Rejects, in this order: an ID that
    /// no order has (`OrderNotFound`); a caller other than the owner and the executor
    /// (`NotOrderOwnerOrExecutor`); then the checks that `canActivate` reports, each with its own
    /// error: stored status not `Dormant` (`OrderNotDormant`), expiry passed (`OrderExpired`),
    /// price zero or below or updated after the current block's time (`InvalidPrice`), price
    /// older than `maxPriceAge` (`StalePrice`), price below the activation price
    /// (`PriceBelowActivation`). A price exactly `maxPriceAge` old counts as fresh, a price equal
    /// to the activation price is enough, and an order can still be activated at its expiry
    /// second. Then it sets the status to `Open`, keeping the activation price as it was, and
    /// emits `OrderActivated`. If the price feed reverts, the call reverts with the feed's own
    /// revert data.
    /// @param orderId The order (uint256).
    function activateOrder(
        uint256 orderId
    )
        external
        orderExists(orderId)
        onlyOrderOwnerOrExecutor(orderId)
        onlyDormant(orderId)
    {
        // The modifiers have run, in this order: step 0 (the order exists), step 1 (the caller is
        // the owner or the executor) and step 2 (the stored status is `Dormant`).
        Order storage order = orders[orderId];
        // Steps 2 to 5: stored status, expiry, price valid and fresh, price not below activation.
        uint256 price = _requireActivatable(orderId, order);

        // Step 6: the order is open from now on.
        order.status = OrderStatus.Open;

        // Step 7: record the activation.
        emit OrderActivated(orderId, msg.sender, price);
    }

    /// @notice Fills an open order: takes the USDC of this fill from the owner, swaps it for ETH at
    /// the swap venue and sends all of that ETH to the order's recipient. A `Limit` order is
    /// filled once, for all of its `usdcRemaining`, at no more than its target price. A `Dca`
    /// order is filled at most once in each period of its schedule, for its amount per period, at
    /// no more than its target price; a period that passes without a fill is skipped for good. A
    /// `Ladder` order is filled one tier at a time, in order, for the amount of its next tier, at
    /// no more than that tier's price; one call fills one tier only, even when the price is below
    /// several of them.
    /// @dev Only the order's owner or its executor can call it. It takes no address and no
    /// instruction from the caller: the token, the price feed and the swap venue are fixed at
    /// deployment, and the recipient is fixed in the order. Rejects, in this order: a call made
    /// while a fill is already running (`ReentrancyGuardReentrantCall`); an ID that no order has
    /// (`OrderNotFound`); a caller other than the owner and the executor
    /// (`NotOrderOwnerOrExecutor`); then the checks that `canFill` reports, each with its own
    /// error: stored status not `Open` or `PartiallyFilled` (`OrderNotOpen`, which names the
    /// stored status, `Dormant` for an order not activated yet), expiry passed (`OrderExpired`),
    /// for a `Dca` order its period 0 not begun yet (`NotStarted`) or its current period bought
    /// already (`PeriodAlreadyFilled`), price zero or below or updated after the current block's
    /// time (`InvalidPrice`), price older than `maxPriceAge` (`StalePrice`), price above the
    /// price cap of this fill (`PriceAboveTarget`), owner's allowance below the amount of this
    /// fill (`InsufficientAllowance`), owner's balance below the amount of this fill
    /// (`InsufficientBalance`). The amount of this fill is the order's `usdcRemaining` for a
    /// `Limit` order, its amount per period for a `Dca` order and the amount of its next tier for
    /// a `Ladder` order; the price cap of this fill is the order's target price, or for a `Ladder`
    /// order the price of its next tier. A price exactly `maxPriceAge` old counts as fresh, and a
    /// price equal to the price cap can fill. Then it counts the fill and takes its amount off
    /// the order's `usdcRemaining` and off the owner's open total; for a `Dca` order it records
    /// the current period as bought, so the next fill can only come in a later period; for a
    /// `Ladder` order the higher fill count points at its next tier; on the order's last fill it
    /// marks the order `Filled` and takes it off
    /// the owner's open count, and on any earlier fill it marks the order `PartiallyFilled`. Then
    /// it takes the amount from the owner, approves the swap venue for that amount and swaps it
    /// with a minimum ETH output. It trusts its own balances, not the venue's return value:
    /// its USDC balance must be back to what it was before the USDC was taken
    /// (`SwapUsdcMismatch`), and its ETH balance must have gone up by at least the minimum
    /// (`InsufficientEthOut`). It then sets the venue's allowance back to zero, sends all of the
    /// ETH that came in to the recipient (`EthTransferFailed`) and emits `OrderFilled`. If the
    /// price feed, the USDC token or the swap venue reverts on the way, the fill reverts with that
    /// call's own revert data, unchanged even when it is empty. Only the two approvals of the swap
    /// venue (to the amount, then back to zero) are handled differently: if one reverts or
    /// returns false, OpenZeppelin's `forceApprove` tries again, setting the allowance to zero and
    /// then to the wanted amount, and a revert in those two calls is passed on. A USDC transfer that
    /// returns something other than true, such as false, instead of reverting, or an approval that
    /// returns false when tried again, makes the fill revert with `SafeERC20FailedOperation`. Any
    /// rejection undoes the whole call: the order keeps the status it had, and no USDC or ETH
    /// moves. The minimum ETH output, in wei, is the larger of
    /// `amount * 10^k / priceCap` (never pay more than the price cap of this fill) and
    /// `amount * 10^k * (10000 - maxSlippageBps) / (price * 10000)` (never get much less than
    /// the feed price gives), each worked out in full and rounded down once, with
    /// k = 18 + price feed decimals - USDC decimals.
    /// @param orderId The order (uint256).
    function fillOrder(
        uint256 orderId
    )
        external
        nonReentrant
        orderExists(orderId)
        onlyOrderOwnerOrExecutor(orderId)
        onlyOpen(orderId)
    {
        // The modifiers have run, in this order: the reentrancy guard, step 0 (the order exists),
        // step 1 (the caller is the owner or the executor) and the stored status of step 2.
        Order storage order = orders[orderId];
        // Steps 2 to 5: status, expiry, the period of a `Dca` order, this fill's amount and price
        // cap, price, allowance and balance.
        FillCheck memory check = _requireFillable(orderId, order);
        uint256 amount = check.amount;
        uint256 price = uint256(check.price);

        // Step 6: count the fill and take it off the order and the owner's open orders.
        _recordFill(orderId, order, check);

        // Step 7: take the amount of this fill from the owner.
        uint256 usdcBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(order.owner, address(this), amount);

        // Step 8: swap it for ETH; see `_swapForEth`.
        uint256 ethReceived = _swapForEth(
            amount,
            _minEthOut(amount, check.priceCap, price),
            usdcBefore
        );

        // Step 9: set the swap venue's allowance back to zero.
        usdc.forceApprove(address(swapVenue), 0);

        // Step 10: send all of the ETH that came in to the recipient.
        (bool sent, ) = order.recipient.call{value: ethReceived}("");
        if (!sent) revert EthTransferFailed(order.recipient, ethReceived);

        // Step 12: record the fill.
        emit OrderFilled(
            orderId,
            order.owner,
            msg.sender,
            order.recipient,
            amount,
            ethReceived,
            price,
            order.fillsDone,
            order.fillsTotal
        );
    }

    /// @notice Cancels an unfinished order, expired or not, which frees one of the owner's
    /// open-order slots and takes the USDC it had left to spend off the owner's open total. Moves
    /// no tokens and no ETH, and calls no other contract: it works whatever the price feed or the
    /// swap venue does.
    /// @dev Only the order's owner can call it; the executor cannot. Rejects, in this order: an ID
    /// that no order has (`OrderNotFound`); a caller other than the owner (`NotOrderOwner`); an
    /// order whose stored status is not `Dormant`, `Open` or `PartiallyFilled`, that is one
    /// already filled or cancelled (`OrderNotOpen`). Sets the status to `Cancelled`, takes the
    /// order off the owner's open count, takes its `usdcRemaining` off the owner's open total and
    /// emits `OrderCancelled`. The order's `usdcRemaining` itself is kept as it was.
    /// @param orderId The order (uint256).
    function cancelOrder(
        uint256 orderId
    )
        external
        orderExists(orderId)
        onlyOrderOwner(orderId)
        onlyUnfinished(orderId)
    {
        Order storage order = orders[orderId];
        order.status = OrderStatus.Cancelled;
        OpenOrders storage open = openOrdersOf[order.owner];
        --open.count;
        open.total -= order.usdcRemaining;

        emit OrderCancelled(orderId, order.owner, _isExpired(order));
    }

    /// @notice Returns every field of an order, with its status as stored. An expired order still
    /// shows its stored status here; `statusOf` gives the status worked out from the expiry.
    /// @dev Anyone can call it. Rejects an ID that no order has (`OrderNotFound`), ID 0 included.
    /// @param orderId The order (uint256).
    /// @return order The stored order (an `Order` struct).
    function getOrder(
        uint256 orderId
    ) external view orderExists(orderId) returns (Order memory order) {
        return orders[orderId];
    }

    /// @notice Returns the schedule of a `Dca` order: when its period 0 begins, how long a period
    /// lasts, how much each period spends and the first period it may still buy.
    /// @dev Anyone can call it, whatever the order's status: a filled, cancelled or expired `Dca`
    /// order still has its schedule. Rejects, in this order: an ID that no order has
    /// (`OrderNotFound`), ID 0 included; an order of another kind (`NotADcaOrder`).
    /// @param orderId The order (uint256).
    /// @return schedule The stored schedule (a `DcaSchedule` struct).
    function getSchedule(
        uint256 orderId
    ) external view orderExists(orderId) returns (DcaSchedule memory schedule) {
        if (orders[orderId].kind != OrderKind.Dca) {
            revert NotADcaOrder(orderId);
        }
        return schedules[orderId];
    }

    /// @notice Returns all the tiers of a `Ladder` order, as they were given when it was placed,
    /// in the order they are filled. The order's `fillsDone` is the index of its next tier.
    /// @dev Anyone can call it, whatever the order's status: a filled, cancelled or expired
    /// `Ladder` order still has its tiers. Rejects, in this order: an ID that no order has
    /// (`OrderNotFound`), ID 0 included; an order of another kind (`NotALadderOrder`).
    /// @param orderId The order (uint256).
    /// @return tiers The stored tiers (an array of `Tier` structs).
    function getTiers(
        uint256 orderId
    ) external view orderExists(orderId) returns (Tier[] memory tiers) {
        if (orders[orderId].kind != OrderKind.Ladder) {
            revert NotALadderOrder(orderId);
        }
        return tiersOf[orderId];
    }

    /// @notice Returns the status of an order as it stands now: `Expired` for an order stored as
    /// `Dormant`, `Open` or `PartiallyFilled` whose expiry is before the current block's time,
    /// otherwise the stored status. At the expiry second itself the order keeps its stored status.
    /// @dev Anyone can call it. Rejects an ID that no order has (`OrderNotFound`), ID 0 included;
    /// it never returns `None`.
    /// @param orderId The order (uint256).
    /// @return status `Dormant`, `Open`, `PartiallyFilled`, `Filled`, `Cancelled` or `Expired`
    /// (an `OrderStatus`, uint8 in the ABI).
    function statusOf(
        uint256 orderId
    ) external view orderExists(orderId) returns (OrderStatus status) {
        Order storage order = orders[orderId];
        status = order.status;
        if (_isUnfinished(status) && _isExpired(order)) {
            status = OrderStatus.Expired;
        }
    }

    /// @notice Says whether `fillOrder` would get past its checks for this order right now and, if
    /// not, the first reason why.
    /// @dev Anyone can call it. It does not look at the caller, so it says nothing about who may
    /// fill the order. Rejects an ID that no order has (`OrderNotFound`), ID 0 included. It runs
    /// the very checks that `fillOrder` runs after checking the caller, in the same order: stored
    /// status (it goes on only for `Open` or `PartiallyFilled`), expiry, for a `Dca` order its
    /// period (not started, current period bought already), price (against the target price, or
    /// for a `Ladder` order the price of its next tier), allowance and balance (against the
    /// amount of this fill: for a `Ladder` order, the amount of its next tier). It does not try
    /// the swap, so a fill it reports as possible can fail at the swap venue or when sending the
    /// ETH. It also reverts if the price feed or the USDC token reverts when it reads them.
    /// @param orderId The order (uint256).
    /// @return fillable True exactly when `reason` is `None` (bool).
    /// @return reason The first reason found, or `None` (a `FillBlocker`, uint8 in the ABI).
    function canFill(
        uint256 orderId
    )
        external
        view
        orderExists(orderId)
        returns (bool fillable, FillBlocker reason)
    {
        reason = _checkFill(orderId).blocker;
        fillable = reason == FillBlocker.None;
    }

    /// @notice Says whether `activateOrder` would get past its checks for this order right now
    /// and, if not, the first reason why.
    /// @dev Anyone can call it. It does not look at the caller, so it says nothing about who may
    /// activate the order. Rejects an ID that no order has (`OrderNotFound`), ID 0 included. It
    /// runs the very checks that `activateOrder` runs after checking the caller, in the same
    /// order: stored status, expiry, price. It also reverts if the price feed reverts when it
    /// reads it.
    /// @param orderId The order (uint256).
    /// @return activatable True exactly when `reason` is `None` (bool).
    /// @return reason The first reason found, or `None` (an `ActivationBlocker`, uint8 in the
    /// ABI).
    function canActivate(
        uint256 orderId
    )
        external
        view
        orderExists(orderId)
        returns (bool activatable, ActivationBlocker reason)
    {
        reason = _checkActivation(orders[orderId]).blocker;
        activatable = reason == ActivationBlocker.None;
    }

    /// @notice Number of orders of `owner` whose stored status is `Dormant`, `Open` or
    /// `PartiallyFilled`, expired ones included.
    /// @dev Anyone can call it; it never reverts. Zero for an address with no orders.
    /// @param owner Any address (address).
    /// @return The number of unfinished orders (uint256).
    function openOrderCount(address owner) external view returns (uint256) {
        return openOrdersOf[owner].count;
    }

    /// @notice USDC that the orders of `owner` whose stored status is `Dormant`, `Open` or
    /// `PartiallyFilled`, expired ones included, have left to spend: their `usdcRemaining` added
    /// up. This is the allowance `owner` needs to give this contract to cover them.
    /// @dev Anyone can call it; it never reverts. Zero for an address with no orders.
    /// @param owner Any address (address).
    /// @return The total, in the token's smallest unit (uint256).
    function openOrderTotal(address owner) external view returns (uint256) {
        return openOrdersOf[owner].total;
    }

    /// @notice Checks the amount and the target price of a new order, or, for a `Ladder` order, the
    /// amount and the price of one of its tiers: rejects a zero amount (`ZeroAmount`), an amount
    /// above `maxOrderAmount` (`AmountAboveMax`) and a zero target price (`ZeroTargetPrice`), in
    /// this order.
    /// @param usdcAmount The amount asked for, or the amount of the tier.
    /// @param targetPrice The target price asked for, or the price of the tier.
    function _requireValidAmountAndTarget(
        uint256 usdcAmount,
        uint256 targetPrice
    ) private view {
        if (usdcAmount == 0) revert ZeroAmount();
        if (usdcAmount > maxOrderAmount) {
            revert AmountAboveMax(usdcAmount, maxOrderAmount);
        }
        if (targetPrice == 0) revert ZeroTargetPrice();
    }

    /// @notice Checks the rest of a new order: rejects a zero recipient (`ZeroRecipient`), a zero
    /// executor (`ZeroExecutor`), an expiry not after the current block's time
    /// (`ExpiryNotInFuture`) and a caller who already has `maxOpenOrdersPerOwner` unfinished
    /// orders (`TooManyOpenOrders`), in this order.
    /// @param recipient The recipient asked for.
    /// @param executor The executor asked for.
    /// @param expiry The expiry asked for.
    function _requireValidPartiesExpiryAndSlot(
        address recipient,
        address executor,
        uint256 expiry
    ) private view {
        if (recipient == address(0)) revert ZeroRecipient();
        if (executor == address(0)) revert ZeroExecutor();
        if (!(expiry > block.timestamp)) {
            revert ExpiryNotInFuture(expiry, block.timestamp);
        }
        if (!(openOrdersOf[msg.sender].count < maxOpenOrdersPerOwner)) {
            revert TooManyOpenOrders(msg.sender, maxOpenOrdersPerOwner);
        }
    }

    /// @notice Checks the schedule of a new `Dca` order: rejects a zero period length
    /// (`ZeroPeriodLength`), a zero number of periods (`ZeroPeriodCount`), more periods than
    /// `maxPeriodsPerOrder` (`TooManyPeriods`) and a start time that is not zero and is before the
    /// current block's time (`StartInPast`), in this order.
    /// @param p The inputs of the order.
    /// @return startAt The start time to store: the one given, or the current block's time when
    /// zero was given.
    function _requireValidSchedule(
        DcaOrderParams calldata p
    ) private view returns (uint256 startAt) {
        if (p.periodLength == 0) revert ZeroPeriodLength();
        if (p.periodCount == 0) revert ZeroPeriodCount();
        if (p.periodCount > maxPeriodsPerOrder) {
            revert TooManyPeriods(p.periodCount, maxPeriodsPerOrder);
        }
        startAt = p.startAt;
        if (startAt == 0) return block.timestamp;
        if (startAt < block.timestamp) {
            revert StartInPast(startAt, block.timestamp);
        }
    }

    /// @notice Checks the tiers of a new `Ladder` order: rejects no tiers (`NoTiers`) and more
    /// tiers than `maxTiersPerOrder` (`TooManyTiers`); then, tier by tier from tier 0, each tier
    /// checked in full before the next, a zero amount (`ZeroAmount`), an amount above
    /// `maxOrderAmount` (`AmountAboveMax`), a zero price (`ZeroTargetPrice`) and, from tier 1
    /// on, a price not strictly below the tier before (`TiersNotDescending`), in this order.
    /// @param tiers The tiers asked for.
    /// @return budget The amounts of the tiers added up.
    function _requireValidTiers(
        Tier[] calldata tiers
    ) private view returns (uint256 budget) {
        uint256 tierCount = tiers.length;
        if (tierCount == 0) revert NoTiers();
        if (tierCount > maxTiersPerOrder) {
            revert TooManyTiers(tierCount, maxTiersPerOrder);
        }
        for (uint256 i = 0; i < tierCount; ++i) {
            Tier calldata tier = tiers[i];
            _requireValidAmountAndTarget(tier.usdcAmount, tier.price);
            if (i > 0 && !(tier.price < tiers[i - 1].price)) {
                revert TiersNotDescending(i);
            }
            budget += tier.usdcAmount;
        }
    }

    /// @notice Stores a new order of `kind` for the caller, adds it to the caller's open count and
    /// its budget to the caller's open total, and emits `OrderCreated`. The order is `Dormant`
    /// when `activationPrice` is above zero and `Open` otherwise. The inputs must have been
    /// checked already.
    /// @param kind The kind of order.
    /// @param usdcAmount USDC budget of the whole order, in the token's smallest unit.
    /// @param targetPrice ETH price in USD with the price feed's decimals: the most any fill of
    /// the order may pay.
    /// @param activationPrice Zero, or the activation price of a dormant order.
    /// @param fillsTotal How many fills the order takes: one for a `Limit` order, its number of
    /// periods for a `Dca` order, its number of tiers for a `Ladder` order.
    /// @param recipient Address that receives the ETH.
    /// @param executor Address the owner names for filling the order.
    /// @param expiry Last second at which the order is valid.
    /// @return orderId ID of the new order.
    function _placeOrder(
        OrderKind kind,
        uint256 usdcAmount,
        uint256 targetPrice,
        uint256 activationPrice,
        uint256 fillsTotal,
        address recipient,
        address executor,
        uint256 expiry
    ) private returns (uint256 orderId) {
        orderId = ++lastOrderId;
        Order storage order = orders[orderId];
        order.owner = msg.sender;
        order.executor = executor;
        order.recipient = recipient;
        order.kind = kind;
        order.status =
            activationPrice == 0 ? OrderStatus.Open : OrderStatus.Dormant;
        order.usdcAmount = usdcAmount;
        order.usdcRemaining = usdcAmount;
        order.targetPrice = targetPrice;
        order.activationPrice = activationPrice;
        order.fillsTotal = fillsTotal;
        // `fillsDone` starts at zero.
        order.createdAt = block.timestamp;
        order.expiry = expiry;
        OpenOrders storage open = openOrdersOf[msg.sender];
        ++open.count;
        open.total += usdcAmount;

        _emitOrderCreated(orderId, order);
    }

    /// @notice Emits `OrderCreated` for an order just stored, with the values it was stored with.
    /// Reading them back from storage keeps `_placeOrder` within the stack's reach.
    /// @param orderId ID of the new order.
    /// @param order The order.
    function _emitOrderCreated(uint256 orderId, Order storage order) private {
        emit OrderCreated(
            orderId,
            order.owner,
            order.executor,
            order.recipient,
            order.usdcAmount,
            order.targetPrice,
            order.expiry,
            order.kind,
            order.activationPrice
        );
    }

    /// @notice Step 6 of a fill: counts the fill and takes its amount off what the order has left
    /// to spend. For a `Dca` order it sets the schedule's `filledThrough`, in storage, to the
    /// period after the current one. When this is the last of the order's fills, it marks the
    /// order `Filled` and takes it off the owner's open count; otherwise it marks the order
    /// `PartiallyFilled` and the order keeps its slot. Either way it takes the amount off the
    /// owner's open total.
    /// @param orderId The order's ID, for its schedule.
    /// @param order The order.
    /// @param check What the fill checks found: the amount of this fill and, for a `Dca` order,
    /// the current period.
    function _recordFill(
        uint256 orderId,
        Order storage order,
        FillCheck memory check
    ) private {
        uint256 amount = check.amount;
        uint256 fillsDone = ++order.fillsDone;
        order.usdcRemaining -= amount;
        if (order.kind == OrderKind.Dca) {
            schedules[orderId].filledThrough = check.period + 1;
        }
        OpenOrders storage open = openOrdersOf[order.owner];
        if (fillsDone == order.fillsTotal) {
            order.status = OrderStatus.Filled;
            --open.count;
        } else {
            order.status = OrderStatus.PartiallyFilled;
        }
        open.total -= amount;
    }

    /// @notice True when the current block's time is after the order's expiry.
    /// @param order The order.
    /// @return Whether the order has expired.
    function _isExpired(Order storage order) private view returns (bool) {
        return block.timestamp > order.expiry;
    }

    /// @notice True for the stored statuses a fill accepts: `Open` and `PartiallyFilled`.
    /// @param status A stored status.
    /// @return Whether an order with this stored status can be filled.
    function _isOpen(OrderStatus status) private pure returns (bool) {
        return
            status == OrderStatus.Open || status == OrderStatus.PartiallyFilled;
    }

    /// @notice True for the stored statuses of an order that is not finished: `Dormant`, `Open`
    /// and `PartiallyFilled`. Such an order takes a slot and counts in its owner's open total.
    /// @param status A stored status.
    /// @return Whether an order with this stored status is unfinished.
    function _isUnfinished(OrderStatus status) private pure returns (bool) {
        return status == OrderStatus.Dormant || _isOpen(status);
    }

    /// @notice Runs the fill checks on an order in a fixed order and stops at the first that
    /// fails: stored status (`NotOpen` for a finished order, `Dormant` for one not activated),
    /// expiry, for a `Dca` order its period (period 0 begun, current period not bought yet), then,
    /// with the amount and the price cap of this fill worked out (for a `Ladder` order, the
    /// amount and the price of its next tier, read only once the stored status has passed, so
    /// that the tier exists), price (above zero and not
    /// updated in the future, then not older than `maxPriceAge`, then not above the price cap),
    /// allowance, balance. Both `canFill` and `fillOrder` use it, so they always agree.
    /// @param orderId The order.
    /// @return check The first reason found, or `None`, and the values read on the way.
    function _checkFill(
        uint256 orderId
    ) private view returns (FillCheck memory check) {
        Order storage order = orders[orderId];
        check.blocker = _checkStatusAndExpiry(order);
        if (check.blocker != FillBlocker.None) return check;
        OrderKind kind = order.kind;
        if (kind == OrderKind.Dca) {
            // A `Dca` order spends the amount of one period, once in each period, at no more than
            // its target price.
            _checkPeriod(schedules[orderId], check);
            if (check.blocker != FillBlocker.None) return check;
            check.priceCap = order.targetPrice;
        } else if (kind == OrderKind.Ladder) {
            // A `Ladder` order spends the amount of its next tier, at no more than that tier's
            // price. The stored status passed above, so the order still has a next tier.
            Tier storage tier = tiersOf[orderId][order.fillsDone];
            check.amount = tier.usdcAmount;
            check.priceCap = tier.price;
        } else {
            // A `Limit` order spends all it has left, at no more than its target price.
            check.amount = order.usdcRemaining;
            check.priceCap = order.targetPrice;
        }
        _checkPriceAndFunds(order.owner, check);
    }

    /// @notice The fill checks of a `Dca` order's schedule: period 0 has begun, then the current
    /// period has not been bought yet. Records in `check` the first reason found, the current
    /// period and, when both pass, the amount of this fill: the amount per period.
    /// @param schedule The order's schedule.
    /// @param check What the checks found so far; updated in place.
    function _checkPeriod(
        DcaSchedule storage schedule,
        FillCheck memory check
    ) private view {
        uint256 startAt = schedule.startAt;
        if (block.timestamp < startAt) {
            check.blocker = FillBlocker.NotStarted;
            return;
        }
        check.period = (block.timestamp - startAt) / schedule.periodLength;
        if (check.period < schedule.filledThrough) {
            check.blocker = FillBlocker.PeriodAlreadyFilled;
            return;
        }
        check.amount = schedule.usdcPerPeriod;
    }

    /// @notice The first two fill checks: stored status (`NotOpen` for a finished order, `Dormant`
    /// for one not activated), then expiry.
    /// @param order The order.
    /// @return blocker The first reason found, or `None`.
    function _checkStatusAndExpiry(
        Order storage order
    ) private view returns (FillBlocker blocker) {
        OrderStatus status = order.status;
        if (!_isOpen(status)) {
            return
                status == OrderStatus.Dormant
                    ? FillBlocker.Dormant
                    : FillBlocker.NotOpen;
        }
        if (_isExpired(order)) return FillBlocker.Expired;
        return FillBlocker.None;
    }

    /// @notice The last fill checks, once the amount and the price cap of this fill are in
    /// `check`: price (above zero and not updated in the future, then not older than
    /// `maxPriceAge`, then not above the price cap), allowance, balance. Records in `check` the
    /// first reason found and the values read on the way.
    /// @param owner The order's owner, whose allowance and balance are read.
    /// @param check What the checks found so far; updated in place.
    function _checkPriceAndFunds(
        address owner,
        FillCheck memory check
    ) private view {
        (check.price, check.updatedAt) = _latestPrice();
        if (_isInvalidPrice(check.price, check.updatedAt)) {
            check.blocker = FillBlocker.InvalidPrice;
            return;
        }
        if (_isStalePrice(check.updatedAt)) {
            check.blocker = FillBlocker.StalePrice;
            return;
        }
        if (uint256(check.price) > check.priceCap) {
            check.blocker = FillBlocker.PriceAboveTarget;
            return;
        }
        check.allowance = usdc.allowance(owner, address(this));
        if (check.allowance < check.amount) {
            check.blocker = FillBlocker.InsufficientAllowance;
            return;
        }
        check.balance = usdc.balanceOf(owner);
        if (check.balance < check.amount) {
            check.blocker = FillBlocker.InsufficientBalance;
        }
    }

    /// @notice Runs the fill checks and reverts with the error that matches the first reason
    /// found. A finished order and a dormant one both get `OrderNotOpen` with the stored status.
    /// @param orderId The order's ID, for the checks and the errors.
    /// @param order The order.
    /// @return check What the checks found, when every check passes.
    function _requireFillable(
        uint256 orderId,
        Order storage order
    ) private view returns (FillCheck memory check) {
        check = _checkFill(orderId);
        FillBlocker blocker = check.blocker;
        if (blocker == FillBlocker.NotOpen || blocker == FillBlocker.Dormant) {
            revert OrderNotOpen(orderId, order.status);
        }
        if (blocker == FillBlocker.Expired) {
            revert OrderExpired(orderId, order.expiry);
        }
        if (blocker == FillBlocker.NotStarted) {
            revert NotStarted(orderId, schedules[orderId].startAt);
        }
        if (blocker == FillBlocker.PeriodAlreadyFilled) {
            revert PeriodAlreadyFilled(orderId, check.period);
        }
        if (blocker == FillBlocker.InvalidPrice) {
            revert InvalidPrice(check.price);
        }
        if (blocker == FillBlocker.StalePrice) {
            revert StalePrice(check.updatedAt, maxPriceAge);
        }
        if (blocker == FillBlocker.PriceAboveTarget) {
            revert PriceAboveTarget(uint256(check.price), check.priceCap);
        }
        if (blocker == FillBlocker.InsufficientAllowance) {
            revert InsufficientAllowance(check.allowance, check.amount);
        }
        if (blocker == FillBlocker.InsufficientBalance) {
            revert InsufficientBalance(check.balance, check.amount);
        }
    }

    /// @notice Runs the activation checks on an order in a fixed order and stops at the first that
    /// fails: stored status (`Dormant`), expiry, price (above zero and not updated in the future,
    /// then not older than `maxPriceAge`, then not below the activation price). Both
    /// `canActivate` and `activateOrder` use it, so they always agree.
    /// @param order The order.
    /// @return check The first reason found, or `None`, and the values read on the way.
    function _checkActivation(
        Order storage order
    ) private view returns (ActivationCheck memory check) {
        if (order.status != OrderStatus.Dormant) {
            check.blocker = ActivationBlocker.NotDormant;
            return check;
        }
        if (_isExpired(order)) {
            check.blocker = ActivationBlocker.Expired;
            return check;
        }
        (check.price, check.updatedAt) = _latestPrice();
        if (_isInvalidPrice(check.price, check.updatedAt)) {
            check.blocker = ActivationBlocker.InvalidPrice;
            return check;
        }
        if (_isStalePrice(check.updatedAt)) {
            check.blocker = ActivationBlocker.StalePrice;
            return check;
        }
        if (uint256(check.price) < order.activationPrice) {
            check.blocker = ActivationBlocker.PriceBelowActivation;
        }
    }

    /// @notice Runs the activation checks and reverts with the error that matches the first
    /// reason found.
    /// @param orderId The order's ID, for the errors.
    /// @param order The order.
    /// @return price The feed's price, when every check passes.
    function _requireActivatable(
        uint256 orderId,
        Order storage order
    ) private view returns (uint256 price) {
        ActivationCheck memory check = _checkActivation(order);
        ActivationBlocker blocker = check.blocker;
        if (blocker == ActivationBlocker.NotDormant) {
            revert OrderNotDormant(orderId, order.status);
        }
        if (blocker == ActivationBlocker.Expired) {
            revert OrderExpired(orderId, order.expiry);
        }
        if (blocker == ActivationBlocker.InvalidPrice) {
            revert InvalidPrice(check.price);
        }
        if (blocker == ActivationBlocker.StalePrice) {
            revert StalePrice(check.updatedAt, maxPriceAge);
        }
        price = uint256(check.price);
        if (blocker == ActivationBlocker.PriceBelowActivation) {
            revert PriceBelowActivation(price, order.activationPrice);
        }
    }

    /// @notice Reads the price feed's latest price and its update time.
    /// @return price The feed's price, with the feed's decimals.
    /// @return updatedAt When the feed last updated it.
    function _latestPrice()
        private
        view
        returns (int256 price, uint256 updatedAt)
    {
        (, price, , updatedAt, ) = priceFeed.latestRoundData();
    }

    /// @notice True when a price cannot be used: it is zero or below, or its update time is after
    /// the current block's time.
    /// @param price The feed's price.
    /// @param updatedAt The feed's update time.
    /// @return Whether the price is invalid.
    function _isInvalidPrice(
        int256 price,
        uint256 updatedAt
    ) private view returns (bool) {
        return price < 1 || updatedAt > block.timestamp;
    }

    /// @notice True when a price is older than `maxPriceAge`. A price exactly that old is not.
    /// @param updatedAt The feed's update time, not after the current block's time.
    /// @return Whether the price is stale.
    function _isStalePrice(uint256 updatedAt) private view returns (bool) {
        return block.timestamp - updatedAt > maxPriceAge;
    }

    /// @notice Step 8 of a fill: approves the swap venue for `amount` USDC, swaps it for ETH with
    /// `minEthOut` as the minimum, and checks the outcome by this contract's own balances rather
    /// than by the venue's return value.
    /// @dev Reverts with `SwapUsdcMismatch` unless the USDC balance is back to `usdcBefore`, that
    /// is the venue took exactly `amount`; then with `InsufficientEthOut` if the ETH balance went
    /// up by less than `minEthOut`.
    /// @param amount The amount of the fill, in the token's smallest unit.
    /// @param minEthOut The smallest ETH output accepted, in wei.
    /// @param usdcBefore This contract's USDC balance before the amount was taken.
    /// @return ethReceived How much this contract's ETH balance went up during the swap, in wei.
    function _swapForEth(
        uint256 amount,
        uint256 minEthOut,
        uint256 usdcBefore
    ) private returns (uint256 ethReceived) {
        uint256 ethBefore = address(this).balance;
        usdc.forceApprove(address(swapVenue), amount);
        swapVenue.swapUsdcForEth(amount, minEthOut);
        uint256 usdcAfter = usdc.balanceOf(address(this));
        if (usdcAfter != usdcBefore) {
            revert SwapUsdcMismatch(usdcBefore, usdcAfter);
        }
        ethReceived = address(this).balance - ethBefore;
        if (ethReceived < minEthOut) {
            revert InsufficientEthOut(ethReceived, minEthOut);
        }
    }

    /// @notice The smallest ETH output a fill accepts, in wei: the larger of
    /// `usdcAmount * 10^k / targetPrice` and
    /// `usdcAmount * 10^k * (10000 - maxSlippageBps) / (price * 10000)`, each rounded down once,
    /// with k = 18 + price feed decimals - USDC decimals.
    /// @param usdcAmount The amount of the fill, in the token's smallest unit.
    /// @param targetPrice The most the fill may pay, with the feed's decimals.
    /// @param price The feed's price, with the feed's decimals.
    /// @return The minimum ETH output, in wei.
    function _minEthOut(
        uint256 usdcAmount,
        uint256 targetPrice,
        uint256 price
    ) private view returns (uint256) {
        uint256 scale = 10 ** (ETH_DECIMALS + priceDecimals - usdcDecimals);
        uint256 notAboveTarget = Math.mulDiv(usdcAmount, scale, targetPrice);
        uint256 withinSlippage = Math.mulDiv(
            usdcAmount,
            scale * (BPS - maxSlippageBps),
            price * BPS
        );
        return Math.max(notAboveTarget, withinSlippage);
    }
}
