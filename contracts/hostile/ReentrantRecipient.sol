// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {LedgerTrigger} from "../LedgerTrigger.sol";

/// @title ReentrantRecipient
/// @author Zhen Zhu
/// @notice Test-only attacker. When it receives ETH, it calls `fillOrder` on the same order of
/// the same LedgerTrigger again, and records how that second call ended instead of reverting.
/// @dev For tests only; never deploy it anywhere else. A test names it as both the executor and
/// the recipient of an order, so the second call gets past the caller check and only the
/// contract's own defences can stop it. It catches the failure of the second call so that
/// receiving the ETH succeeds: if it reverted instead, the first fill would fail as well
/// and the test could not show that a second fill never happens. Anyone can set the target order.
contract ReentrantRecipient {
    /// @notice The LedgerTrigger it calls back into.
    LedgerTrigger public immutable trigger;
    /// @notice The order it tries to fill again.
    uint256 public targetOrderId;
    /// @notice How many times it has tried to fill again.
    uint256 public reentryAttempts;
    /// @notice True if a second fill ever went through.
    bool public reentrySucceeded;
    /// @notice The revert data of the last failed second fill.
    bytes public reentryError;

    /// @notice Deploys the attacker against one LedgerTrigger.
    /// @param trigger_ The LedgerTrigger to call back into.
    constructor(LedgerTrigger trigger_) {
        trigger = trigger_;
    }

    /// @notice On receiving ETH, tries to fill `targetOrderId` again.
    /// @dev Never reverts because of that attempt: the outcome is recorded instead.
    receive() external payable {
        _fillAgain();
    }

    /// @notice Sets the order to fill again when ETH arrives.
    /// @dev Anyone can call it; it never reverts.
    /// @param orderId The order.
    function setTargetOrder(uint256 orderId) external {
        targetOrderId = orderId;
    }

    /// @notice Calls `fillOrder(targetOrderId)` and records whether it went through or, if not,
    /// its revert data.
    function _fillAgain() private {
        ++reentryAttempts;
        try trigger.fillOrder(targetOrderId) {
            reentrySucceeded = true;
        } catch (bytes memory reason) {
            reentryError = reason;
        }
    }
}
