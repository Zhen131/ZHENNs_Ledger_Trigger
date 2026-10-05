// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {ISwapVenue} from "./interfaces/ISwapVenue.sol";

/// @title LedgerTrigger
/// @author Zhen Zhu
/// @notice Limit orders to buy ETH with USDC. Anyone can place an order with a USDC amount, a
/// target price, a recipient for the ETH, an executor and an expiry; the owner can cancel it.
/// Placing and cancelling an order move no tokens and no ETH.
/// @dev There is no admin: no pause, no upgrade, no setter and no withdrawal. The seven deployment
/// parameters can never change. The status `Expired` is never stored; `statusOf` works it out from
/// the expiry.
contract LedgerTrigger {
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

    /// @notice Basis points in 100 %.
    uint256 private constant BPS = 10_000;
    /// @notice Largest slippage accepted at deployment: just under 100 %.
    uint256 private constant MAX_SLIPPAGE_BPS = BPS - 1;

    /// @notice The USDC token that orders spend.
    IERC20 public immutable usdc;
    /// @notice The price feed for ETH in USD.
    IPriceFeed public immutable priceFeed;
    /// @notice The swap venue that turns USDC into ETH.
    ISwapVenue public immutable swapVenue;
    /// @notice Largest `usdcAmount` of one order, in the token's smallest unit.
    uint256 public immutable maxOrderAmount;
    /// @notice Largest number of open orders one owner can have at the same time.
    uint256 public immutable maxOpenOrdersPerOwner;
    /// @notice Oldest price, in seconds since its update, that still counts as current.
    uint256 public immutable maxPriceAge;
    /// @notice Allowed price slippage in basis points (100 is 1 %).
    uint256 public immutable maxSlippageBps;
    /// @notice Decimals of `usdc`, read from the token at deployment.
    uint8 public immutable usdcDecimals;
    /// @notice Decimals of `priceFeed`, read from the feed at deployment.
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
    /// Only then does it read the decimals of the token and of the price feed and store them.
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
    /// @param recipient Address that receives the ETH.
    /// @param executor Address the owner names for filling the order; may be the owner.
    /// @param expiry Last second, in Unix time, at which the order is valid (uint256).
    /// @return orderId ID of the new order: 1 for the first order, then one more each time.
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

    /// @notice Returns every field of an order, with its status as stored. An expired order still
    /// shows `Open` here; `statusOf` gives the status worked out from the expiry.
    /// @dev Anyone can call it. Rejects an ID that no order has (`OrderNotFound`), ID 0 included.
    /// @param orderId The order (uint256).
    /// @return order The stored order.
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
    /// @return status `Open`, `Filled`, `Cancelled` or `Expired`.
    function statusOf(
        uint256 orderId
    ) external view orderExists(orderId) returns (OrderStatus status) {
        Order storage order = orders[orderId];
        status = order.status;
        if (status == OrderStatus.Open && _isExpired(order)) {
            status = OrderStatus.Expired;
        }
    }

    /// @notice Number of orders of `owner` whose stored status is `Open`, expired ones included.
    /// @dev Anyone can call it; it never reverts. Zero for an address with no orders.
    /// @param owner Any address.
    /// @return The number of open orders (uint256).
    function openOrderCount(address owner) external view returns (uint256) {
        return openOrdersOf[owner].count;
    }

    /// @notice USDC amounts of the orders of `owner` whose stored status is `Open`, expired ones
    /// included, added up. This is the allowance `owner` needs to give this contract to cover them.
    /// @dev Anyone can call it; it never reverts. Zero for an address with no orders.
    /// @param owner Any address.
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
}
