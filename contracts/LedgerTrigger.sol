// SPDX-License-Identifier: UNLICENSED
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
/// @dev There is no admin: no pause, no upgrade, no setter and no withdrawal. The seven deployment
/// parameters can never change. The status `Expired` is never stored; `statusOf` works it out from
/// the expiry. A fill keeps none of the USDC and ETH it moves: it passes all of both straight
/// through. USDC sent straight to this contract cannot be refused, and stays here for good, as
/// nothing can take it out.
/// Two errors in its interface come from OpenZeppelin: `ReentrancyGuardReentrantCall` (a call to
/// `fillOrder` made while a fill is running) and `SafeERC20FailedOperation` (a USDC transfer or
/// approval that did not revert but returned something other than true, such as false, or a USDC
/// address with no code). A USDC call that reverts is not turned into that error: its own revert
/// data is passed on unchanged, even when it is empty.
contract LedgerTrigger is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where an order stands.
    /// @dev `None`: no order has this ID. `Open`: placed and not yet filled or cancelled.
    /// `Filled` and `Cancelled` are final. `Expired` is never stored: `statusOf` reports it for an
    /// order stored as `Open` whose expiry has passed.
    enum OrderStatus {
        None,
        Open,
        Filled,
        Cancelled,
        Expired
    }

    /// @notice Why an order cannot be filled right now, as reported by `canFill`.
    /// @dev `None`: nothing stops it. `NotOpen`: its stored status is `Filled` or `Cancelled`.
    /// `Expired`: its expiry has passed. `InvalidPrice`: the feed's price is zero or below, or its
    /// update time is after the current block's time. `StalePrice`: the price is older than
    /// `maxPriceAge`. `PriceAboveTarget`: the price is above the order's target price.
    /// `InsufficientAllowance`: the owner's USDC allowance to this contract is below the order
    /// amount. `InsufficientBalance`: the owner's USDC balance is below the order amount. When
    /// several apply, the first in this list is reported.
    enum FillBlocker {
        None,
        NotOpen,
        Expired,
        InvalidPrice,
        StalePrice,
        PriceAboveTarget,
        InsufficientAllowance,
        InsufficientBalance
    }

    /// @notice One order. Orders are never deleted, and their owner, executor and recipient never
    /// change.
    /// @dev Fields: `owner` placed the order. `executor` is the one address besides the owner that
    /// the owner names for filling it. `recipient` receives the ETH. `usdcAmount` is the USDC to
    /// spend, in the token's smallest unit. `targetPrice` is the ETH price in USD with the price
    /// feed's decimals. `createdAt` is the time of the block that placed the order. `expiry` is the
    /// last second, in Unix time, at which the order is still valid. `status` is the stored status
    /// and is never `Expired`.
    struct Order {
        address owner;
        address executor;
        address recipient;
        uint256 usdcAmount;
        uint256 targetPrice;
        uint256 createdAt;
        uint256 expiry;
        OrderStatus status;
    }

    /// @notice The open orders of one owner: how many there are and their USDC amounts added up.
    /// @dev An order counts here while its stored status is `Open`, expired or not.
    struct OpenOrders {
        uint256 count;
        uint256 total;
    }

    /// @notice What the fill checks found for one order: the first reason it cannot be filled,
    /// and the values read on the way.
    /// @dev Fields: `blocker` is `None` when the order can be filled. `price` and `updatedAt` are
    /// the feed's answer and update time. `allowance` and `balance` are the owner's USDC
    /// allowance to this contract and USDC balance. A value is zero when the checks stopped
    /// before reading it.
    struct FillCheck {
        FillBlocker blocker;
        int256 price;
        uint256 updatedAt;
        uint256 allowance;
        uint256 balance;
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
    /// @notice Largest `usdcAmount` of one order, in the token's smallest unit. Set at
    /// deployment, never changes.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable maxOrderAmount;
    /// @notice Largest number of open orders one owner can have at the same time. Set at
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
    /// @notice Decimals of `usdc`, read from the token at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint8 public immutable usdcDecimals;
    /// @notice Decimals of `priceFeed`, read from the feed at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint8 public immutable priceDecimals;

    /// @notice Order ID to order. IDs start at 1; ID 0 is never used.
    mapping(uint256 orderId => Order order) private orders;
    /// @notice Owner to the count and the USDC total of their open orders.
    mapping(address owner => OpenOrders open) private openOrdersOf;
    /// @notice ID of the newest order, or 0 before the first one.
    uint256 private lastOrderId;

    /// @notice An order was placed.
    /// @param orderId ID of the new order.
    /// @param owner The account that placed it.
    /// @param executor The address the owner names for filling it.
    /// @param recipient Where the ETH goes.
    /// @param usdcAmount USDC to spend, in the token's smallest unit.
    /// @param targetPrice ETH price in USD, with the price feed's decimals.
    /// @param expiry Last second at which the order is valid.
    event OrderCreated(
        uint256 indexed orderId,
        address indexed owner,
        address indexed executor,
        address recipient,
        uint256 usdcAmount,
        uint256 targetPrice,
        uint256 expiry
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

    /// @notice An order was filled: its USDC was swapped for ETH and the ETH sent to its
    /// recipient.
    /// @param orderId ID of the order.
    /// @param owner The order's owner, whose USDC was spent.
    /// @param filledBy The account that filled it: the owner or the order's executor.
    /// @param recipient Where the ETH went.
    /// @param usdcAmount USDC spent, in the token's smallest unit.
    /// @param ethReceived ETH, in wei, that the swap brought in and the recipient received.
    /// @param price The price feed's price used for the fill, with the feed's decimals.
    event OrderFilled(
        uint256 indexed orderId,
        address indexed owner,
        address indexed filledBy,
        address recipient,
        uint256 usdcAmount,
        uint256 ethReceived,
        uint256 price
    );

    /// @notice No order has this ID.
    /// @param orderId The ID asked for.
    error OrderNotFound(uint256 orderId);
    /// @notice Only the order's owner may do this.
    /// @param orderId The order.
    /// @param caller The account that tried.
    error NotOrderOwner(uint256 orderId, address caller);
    /// @notice The order's stored status is not `Open`.
    /// @param orderId The order.
    /// @param status Its stored status.
    error OrderNotOpen(uint256 orderId, OrderStatus status);
    /// @notice The order amount is zero.
    error ZeroAmount();
    /// @notice The order amount is above `maxOrderAmount`.
    /// @param amount The amount asked for.
    /// @param max The largest amount allowed.
    error AmountAboveMax(uint256 amount, uint256 max);
    /// @notice The target price is zero.
    error ZeroTargetPrice();
    /// @notice The recipient is the zero address.
    error ZeroRecipient();
    /// @notice The executor is the zero address.
    error ZeroExecutor();
    /// @notice The expiry is not after the current block's time.
    /// @param expiry The expiry asked for.
    /// @param currentTime The current block's time.
    error ExpiryNotInFuture(uint256 expiry, uint256 currentTime);
    /// @notice The caller already has `maxOpenOrdersPerOwner` open orders.
    /// @param owner The caller.
    /// @param max The largest number of open orders allowed.
    error TooManyOpenOrders(address owner, uint256 max);
    /// @notice Only the order's owner or its executor may fill it.
    /// @param orderId The order.
    /// @param caller The account that tried.
    error NotOrderOwnerOrExecutor(uint256 orderId, address caller);
    /// @notice The order's expiry has passed.
    /// @param orderId The order.
    /// @param expiry Its expiry: the last second at which it could be filled.
    error OrderExpired(uint256 orderId, uint256 expiry);
    /// @notice The price feed's price is zero or below, or its update time is after the current
    /// block's time.
    /// @param price The price the feed reported.
    error InvalidPrice(int256 price);
    /// @notice The price feed's price is older than `maxPriceAge`.
    /// @param updatedAt When the feed last updated the price.
    /// @param maxPriceAge The oldest price age allowed, in seconds.
    error StalePrice(uint256 updatedAt, uint256 maxPriceAge);
    /// @notice The price feed's price is above the order's target price.
    /// @param price The price the feed reported.
    /// @param targetPrice The order's target price.
    error PriceAboveTarget(uint256 price, uint256 targetPrice);
    /// @notice The owner's USDC allowance to this contract is below the order amount.
    /// @param allowance The allowance the owner has given.
    /// @param needed The order amount.
    error InsufficientAllowance(uint256 allowance, uint256 needed);
    /// @notice The owner's USDC balance is below the order amount.
    /// @param balance The owner's balance.
    /// @param needed The order amount.
    error InsufficientBalance(uint256 balance, uint256 needed);
    /// @notice After the swap, this contract's USDC balance is not what it was before the USDC
    /// was taken from the owner, so the swap venue did not take exactly the order amount.
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

    /// @notice Rejects an order whose stored status is not `Open`, with `OrderNotOpen`. An expired
    /// order is still stored as `Open` and passes.
    /// @param orderId The order.
    modifier onlyOpen(uint256 orderId) {
        OrderStatus status = orders[orderId].status;
        if (status != OrderStatus.Open) revert OrderNotOpen(orderId, status);
        _;
    }

    /// @notice Deploys the contract with its seven parameters, none of which can change later.
    /// @dev Checks, in order: the three addresses are not the zero address (`ZeroUsdc`,
    /// `ZeroPriceFeed`, `ZeroSwapVenue`); `maxOrderAmount_`, `maxOpenOrdersPerOwner_` and
    /// `maxPriceAge_` are above zero (`ZeroMaxOrderAmount`, `ZeroMaxOpenOrdersPerOwner`,
    /// `ZeroMaxPriceAge`); `maxSlippageBps_` is below 10000 (`SlippageTooHigh`), zero allowed.
    /// Only then does it read the decimals of the token and of the price feed and store them; it
    /// also reverts if either of them does not report its decimals.
    /// @param usdc_ The USDC token (an ERC-20 token address).
    /// @param priceFeed_ The price feed for ETH in USD (a Chainlink-style feed address).
    /// @param swapVenue_ The swap venue (an `ISwapVenue` address).
    /// @param maxOrderAmount_ Largest order amount, in the token's smallest unit (uint256).
    /// @param maxOpenOrdersPerOwner_ Largest number of open orders per owner (uint256).
    /// @param maxPriceAge_ Oldest acceptable price age, in seconds (uint256).
    /// @param maxSlippageBps_ Allowed slippage, in basis points (uint256).
    constructor(
        IERC20 usdc_,
        IPriceFeed priceFeed_,
        ISwapVenue swapVenue_,
        uint256 maxOrderAmount_,
        uint256 maxOpenOrdersPerOwner_,
        uint256 maxPriceAge_,
        uint256 maxSlippageBps_
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

        usdc = usdc_;
        priceFeed = priceFeed_;
        swapVenue = swapVenue_;
        maxOrderAmount = maxOrderAmount_;
        maxOpenOrdersPerOwner = maxOpenOrdersPerOwner_;
        maxPriceAge = maxPriceAge_;
        maxSlippageBps = maxSlippageBps_;
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
    /// a caller who already has `maxOpenOrdersPerOwner` open orders, expired ones included
    /// (`TooManyOpenOrders`). The executor may be the caller. Emits `OrderCreated`.
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
        if (usdcAmount == 0) revert ZeroAmount();
        if (usdcAmount > maxOrderAmount) {
            revert AmountAboveMax(usdcAmount, maxOrderAmount);
        }
        if (targetPrice == 0) revert ZeroTargetPrice();
        if (recipient == address(0)) revert ZeroRecipient();
        if (executor == address(0)) revert ZeroExecutor();
        if (!(expiry > block.timestamp)) {
            revert ExpiryNotInFuture(expiry, block.timestamp);
        }
        OpenOrders storage open = openOrdersOf[msg.sender];
        if (!(open.count < maxOpenOrdersPerOwner)) {
            revert TooManyOpenOrders(msg.sender, maxOpenOrdersPerOwner);
        }

        orderId = ++lastOrderId;
        orders[orderId] = Order({
            owner: msg.sender,
            executor: executor,
            recipient: recipient,
            usdcAmount: usdcAmount,
            targetPrice: targetPrice,
            createdAt: block.timestamp,
            expiry: expiry,
            status: OrderStatus.Open
        });
        ++open.count;
        open.total += usdcAmount;

        emit OrderCreated(
            orderId,
            msg.sender,
            executor,
            recipient,
            usdcAmount,
            targetPrice,
            expiry
        );
    }

    /// @notice Fills an open order: takes its USDC from the owner, swaps it for ETH at the swap
    /// venue and sends all of that ETH to the order's recipient.
    /// @dev Only the order's owner or its executor can call it. It takes no address and no
    /// instruction from the caller: the token, the price feed and the swap venue are fixed at
    /// deployment, and the recipient is fixed in the order. Rejects, in this order: a call made
    /// while a fill is already running (`ReentrancyGuardReentrantCall`); an ID that no order has
    /// (`OrderNotFound`); a caller other than the owner and the executor
    /// (`NotOrderOwnerOrExecutor`); then the checks that `canFill` reports, each with its own
    /// error: stored status not `Open` (`OrderNotOpen`), expiry passed (`OrderExpired`), price
    /// zero or below or updated after the current block's time (`InvalidPrice`), price older than
    /// `maxPriceAge` (`StalePrice`), price above the target price (`PriceAboveTarget`), owner's
    /// allowance below the order amount (`InsufficientAllowance`), owner's balance below the order
    /// amount (`InsufficientBalance`). A price exactly `maxPriceAge` old counts as fresh, and a price
    /// equal to the target price can fill. Then it marks the order `Filled`, takes it off the
    /// owner's open count and total, takes the order amount from the owner, approves the swap
    /// venue for that amount and swaps it with a minimum ETH output. It trusts its own balances,
    /// not the venue's return value: its USDC balance must be back to what it was before the USDC
    /// was taken (`SwapUsdcMismatch`), and its ETH balance must have gone up by at least the
    /// minimum (`InsufficientEthOut`). It then sets the venue's allowance back to zero, sends all of
    /// the ETH that came in to the recipient (`EthTransferFailed`) and emits `OrderFilled`. If the
    /// price feed, the USDC token or the swap venue reverts on the way, the fill reverts with that
    /// call's own revert data, unchanged even when it is empty. Only the two approvals of the swap
    /// venue (to the order amount, then back to zero) are handled differently: if one reverts,
    /// OpenZeppelin's `forceApprove` sets the allowance to zero and then to the wanted amount, and a
    /// revert in those two calls is passed on. A USDC transfer or approval that returns false
    /// instead of reverting, or a USDC address with no code, makes the fill revert with
    /// `SafeERC20FailedOperation`. Any rejection undoes the whole call: the order stays `Open` and
    /// no USDC or ETH moves. The minimum ETH output, in wei, is the larger of
    /// `usdcAmount * 10^k / targetPrice` (never pay more than the target price) and
    /// `usdcAmount * 10^k * (10000 - maxSlippageBps) / (price * 10000)` (never get much less than
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
    {
        // The modifiers have run, in this order: the reentrancy guard, step 0 (the order
        // exists) and step 1 (the caller is the owner or the executor).
        Order storage order = orders[orderId];
        // Steps 2 to 4: status and expiry, price, allowance and balance.
        uint256 price = _requireFillable(orderId, order);

        // Step 5: mark the order filled and take it off the owner's open orders.
        order.status = OrderStatus.Filled;
        OpenOrders storage open = openOrdersOf[order.owner];
        --open.count;
        open.total -= order.usdcAmount;

        // Step 6: take the order amount from the owner.
        uint256 usdcBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(order.owner, address(this), order.usdcAmount);

        // Step 7: swap it for ETH; see `_swapForEth`.
        uint256 ethReceived = _swapForEth(
            order.usdcAmount,
            _minEthOut(order.usdcAmount, order.targetPrice, price),
            usdcBefore
        );

        // Step 8: set the swap venue's allowance back to zero.
        usdc.forceApprove(address(swapVenue), 0);

        // Step 9: send all of the ETH that came in to the recipient.
        (bool sent, ) = order.recipient.call{value: ethReceived}("");
        if (!sent) revert EthTransferFailed(order.recipient, ethReceived);

        // Step 10: record the fill.
        emit OrderFilled(
            orderId,
            order.owner,
            msg.sender,
            order.recipient,
            order.usdcAmount,
            ethReceived,
            price
        );
    }

    /// @notice Cancels an open order, expired or not, which frees one of the owner's open-order
    /// slots. Moves no tokens and no ETH, and calls no other contract: it works whatever the price
    /// feed or the swap venue does.
    /// @dev Only the order's owner can call it; the executor cannot. Rejects, in this order: an ID
    /// that no order has (`OrderNotFound`); a caller other than the owner (`NotOrderOwner`); an
    /// order whose stored status is not `Open`, that is one already filled or cancelled
    /// (`OrderNotOpen`). Sets the status to `Cancelled`, takes the order off the owner's open
    /// count and total, and emits `OrderCancelled`.
    /// @param orderId The order (uint256).
    function cancelOrder(
        uint256 orderId
    ) external orderExists(orderId) onlyOrderOwner(orderId) onlyOpen(orderId) {
        Order storage order = orders[orderId];
        order.status = OrderStatus.Cancelled;
        OpenOrders storage open = openOrdersOf[order.owner];
        --open.count;
        open.total -= order.usdcAmount;

        emit OrderCancelled(orderId, order.owner, _isExpired(order));
    }

    /// @notice Returns every field of an order, with its status as stored. An expired order still
    /// shows `Open` here; `statusOf` gives the status worked out from the expiry.
    /// @dev Anyone can call it. Rejects an ID that no order has (`OrderNotFound`), ID 0 included.
    /// @param orderId The order (uint256).
    /// @return order The stored order (an `Order` struct).
    function getOrder(
        uint256 orderId
    ) external view orderExists(orderId) returns (Order memory order) {
        return orders[orderId];
    }

    /// @notice Returns the status of an order as it stands now: `Expired` for an order stored as
    /// `Open` whose expiry is before the current block's time, otherwise the stored status. At the
    /// expiry second itself the order is still `Open`.
    /// @dev Anyone can call it. Rejects an ID that no order has (`OrderNotFound`), ID 0 included;
    /// it never returns `None`.
    /// @param orderId The order (uint256).
    /// @return status `Open`, `Filled`, `Cancelled` or `Expired` (an `OrderStatus`, uint8 in the
    /// ABI).
    function statusOf(
        uint256 orderId
    ) external view orderExists(orderId) returns (OrderStatus status) {
        Order storage order = orders[orderId];
        status = order.status;
        if (status == OrderStatus.Open && _isExpired(order)) {
            status = OrderStatus.Expired;
        }
    }

    /// @notice Says whether `fillOrder` would get past its checks for this order right now and, if
    /// not, the first reason why.
    /// @dev Anyone can call it. It does not look at the caller, so it says nothing about who may
    /// fill the order. Rejects an ID that no order has (`OrderNotFound`), ID 0 included. It runs
    /// the very checks that `fillOrder` runs after checking the caller, in the same order: stored
    /// status, expiry, price, allowance, balance. It does not try the swap, so a fill it reports as
    /// possible can fail at the swap venue or when sending the ETH. It also reverts if the price
    /// feed or the USDC token reverts when it reads them.
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
        reason = _checkFill(orders[orderId]).blocker;
        fillable = reason == FillBlocker.None;
    }

    /// @notice Number of orders of `owner` whose stored status is `Open`, expired ones included.
    /// @dev Anyone can call it; it never reverts. Zero for an address with no orders.
    /// @param owner Any address (address).
    /// @return The number of open orders (uint256).
    function openOrderCount(address owner) external view returns (uint256) {
        return openOrdersOf[owner].count;
    }

    /// @notice USDC amounts of the orders of `owner` whose stored status is `Open`, expired ones
    /// included, added up. This is the allowance `owner` needs to give this contract to cover them.
    /// @dev Anyone can call it; it never reverts. Zero for an address with no orders.
    /// @param owner Any address (address).
    /// @return The total, in the token's smallest unit (uint256).
    function openOrderTotal(address owner) external view returns (uint256) {
        return openOrdersOf[owner].total;
    }

    /// @notice True when the current block's time is after the order's expiry.
    /// @param order The order.
    /// @return Whether the order has expired.
    function _isExpired(Order storage order) private view returns (bool) {
        return block.timestamp > order.expiry;
    }

    /// @notice Runs the fill checks on an order in a fixed order and stops at the first that
    /// fails: stored status, expiry, price (above zero and not updated in the future, then not
    /// older than `maxPriceAge`, then not above the target price), allowance, balance. Both
    /// `canFill` and `fillOrder` use it, so they always agree.
    /// @param order The order.
    /// @return check The first reason found, or `None`, and the values read on the way.
    function _checkFill(
        Order storage order
    ) private view returns (FillCheck memory check) {
        if (order.status != OrderStatus.Open) {
            check.blocker = FillBlocker.NotOpen;
            return check;
        }
        if (_isExpired(order)) {
            check.blocker = FillBlocker.Expired;
            return check;
        }
        (, int256 price, , uint256 updatedAt, ) = priceFeed.latestRoundData();
        check.price = price;
        check.updatedAt = updatedAt;
        if (price < 1 || updatedAt > block.timestamp) {
            check.blocker = FillBlocker.InvalidPrice;
            return check;
        }
        if (block.timestamp - updatedAt > maxPriceAge) {
            check.blocker = FillBlocker.StalePrice;
            return check;
        }
        if (uint256(price) > order.targetPrice) {
            check.blocker = FillBlocker.PriceAboveTarget;
            return check;
        }
        check.allowance = usdc.allowance(order.owner, address(this));
        if (check.allowance < order.usdcAmount) {
            check.blocker = FillBlocker.InsufficientAllowance;
            return check;
        }
        check.balance = usdc.balanceOf(order.owner);
        if (check.balance < order.usdcAmount) {
            check.blocker = FillBlocker.InsufficientBalance;
        }
    }

    /// @notice Runs the fill checks and reverts with the error that matches the first reason
    /// found.
    /// @param orderId The order's ID, for the errors.
    /// @param order The order.
    /// @return price The feed's price, when every check passes.
    function _requireFillable(
        uint256 orderId,
        Order storage order
    ) private view returns (uint256 price) {
        FillCheck memory check = _checkFill(order);
        FillBlocker blocker = check.blocker;
        if (blocker == FillBlocker.NotOpen) {
            revert OrderNotOpen(orderId, order.status);
        }
        if (blocker == FillBlocker.Expired) {
            revert OrderExpired(orderId, order.expiry);
        }
        if (blocker == FillBlocker.InvalidPrice) {
            revert InvalidPrice(check.price);
        }
        if (blocker == FillBlocker.StalePrice) {
            revert StalePrice(check.updatedAt, maxPriceAge);
        }
        price = uint256(check.price);
        if (blocker == FillBlocker.PriceAboveTarget) {
            revert PriceAboveTarget(price, order.targetPrice);
        }
        if (blocker == FillBlocker.InsufficientAllowance) {
            revert InsufficientAllowance(check.allowance, order.usdcAmount);
        }
        if (blocker == FillBlocker.InsufficientBalance) {
            revert InsufficientBalance(check.balance, order.usdcAmount);
        }
    }

    /// @notice Step 7 of a fill: approves the swap venue for `amount` USDC, swaps it for ETH with
    /// `minEthOut` as the minimum, and checks the outcome by this contract's own balances rather
    /// than by the venue's return value.
    /// @dev Reverts with `SwapUsdcMismatch` unless the USDC balance is back to `usdcBefore`, that
    /// is the venue took exactly `amount`; then with `InsufficientEthOut` if the ETH balance went
    /// up by less than `minEthOut`.
    /// @param amount The order amount, in the token's smallest unit.
    /// @param minEthOut The smallest ETH output accepted, in wei.
    /// @param usdcBefore This contract's USDC balance before the order amount was taken.
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
    /// @param usdcAmount The order amount, in the token's smallest unit.
    /// @param targetPrice The order's target price, with the feed's decimals.
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
