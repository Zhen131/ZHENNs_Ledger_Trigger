// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFillReceipt} from "../interfaces/IFillReceipt.sol";

/// @title RefusingFillReceipt
/// @author Zhen Zhu
/// @notice Test-only receipt contract that names the order contract it is given but refuses to
/// issue any receipt. It shows that a fill whose receipt cannot be issued is undone as a whole.
/// @dev For tests only; never deploy it anywhere else. LedgerTrigger only checks what `trigger`
/// returns, so it accepts this contract at deployment.
contract RefusingFillReceipt is IFillReceipt {
    /// @notice The order contract this contract names.
    address public immutable trigger;

    /// @notice Every call to `mint` reverts with this error.
    error ReceiptRefused();

    /// @notice Deploys the contract, naming `trigger_` as its order contract.
    /// @param trigger_ The order contract to name.
    constructor(address trigger_) {
        trigger = trigger_;
    }

    /// @notice Refuses to issue a receipt, whoever calls it and whatever it is given.
    /// @dev Always reverts with `ReceiptRefused`.
    /// @return The ID of the new receipt, never returned.
    function mint(address, Receipt calldata) external pure returns (uint256) {
        revert ReceiptRefused();
    }
}
