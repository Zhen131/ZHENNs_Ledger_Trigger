// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LedgerTrigger} from "../LedgerTrigger.sol";

/// @title CancellingRecipient
/// @author Zhen Zhu
/// @notice Test-only attacker that owns orders and receives their ETH. When it receives ETH, it
/// calls `cancelOrder` on the order it targets, and records how that call ended instead of
/// reverting.
/// @dev For tests only; never deploy it anywhere else. It places its orders itself, so it is
/// their owner and the cancel gets past the owner check. `cancelOrder` has no reentrancy guard,
/// so only the order of the steps in `fillOrder` (the status is changed before any money moves)
/// can stop a cancel made while the fill pays this contract. It catches the failure of the
/// cancel so that receiving the ETH succeeds: if it reverted instead, the fill would fail as well
/// and the test could not show what the cancel met. Anyone can call its functions.
contract CancellingRecipient {
    using SafeERC20 for IERC20;

    /// @notice The LedgerTrigger it places orders on and calls back into.
    LedgerTrigger public immutable trigger;
    /// @notice The order it tries to cancel when ETH arrives.
    uint256 public targetOrderId;
    /// @notice How many times it has tried to cancel.
    uint256 public cancelAttempts;
    /// @notice True if a cancel made while receiving ETH ever went through.
    bool public cancelSucceeded;
    /// @notice The revert data of the last failed cancel.
    bytes public cancelError;

    /// @notice Deploys the attacker against one LedgerTrigger.
    /// @param trigger_ The LedgerTrigger to place orders on and call back into.
    constructor(LedgerTrigger trigger_) {
        trigger = trigger_;
    }

    /// @notice On receiving ETH, tries to cancel `targetOrderId`.
    /// @dev Never reverts because of that attempt: the outcome is recorded instead.
    receive() external payable {
        _cancel();
    }

    /// @notice Lets the LedgerTrigger take up to `amount` of this contract's USDC.
    /// @dev Anyone can call it.
    /// @param amount The allowance, in the token's smallest unit.
    function approveTrigger(uint256 amount) external {
        trigger.usdc().forceApprove(address(trigger), amount);
    }

    /// @notice Places an order with this contract as its owner and its recipient.
    /// @dev Anyone can call it; it reverts when `createOrder` does.
    /// @param usdcAmount USDC to spend, in the token's smallest unit.
    /// @param targetPrice ETH price in USD with the price feed's decimals.
    /// @param executor The executor named in the order.
    /// @param expiry Last second at which the order is valid.
    /// @return orderId The ID of the new order.
    function placeOrder(
        uint256 usdcAmount,
        uint256 targetPrice,
        address executor,
        uint256 expiry
    ) external returns (uint256 orderId) {
        orderId = trigger.createOrder(
            usdcAmount,
            targetPrice,
            address(this),
            executor,
            expiry
        );
    }

    /// @notice Sets the order to cancel when ETH arrives.
    /// @dev Anyone can call it; it never reverts.
    /// @param orderId The order.
    function setTargetOrder(uint256 orderId) external {
        targetOrderId = orderId;
    }

    /// @notice Calls `cancelOrder(targetOrderId)` and records whether it went through or, if not,
    /// its revert data.
    function _cancel() private {
        ++cancelAttempts;
        try trigger.cancelOrder(targetOrderId) {
            cancelSucceeded = true;
        } catch (bytes memory reason) {
            cancelError = reason;
        }
    }
}
