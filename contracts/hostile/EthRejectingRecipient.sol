// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapVenue} from "../interfaces/ISwapVenue.sol";

/// @title EthRejectingRecipient
/// @author Zhen Zhu
/// @notice Test-only contract that refuses every ETH transfer. As the recipient of an order it
/// makes the last step of a fill fail. It can also swap USDC at a swap venue itself, which shows
/// what the venue does when its caller cannot take the ETH.
/// @dev For tests only; never deploy it anywhere else.
contract EthRejectingRecipient {
    using SafeERC20 for IERC20;

    /// @notice This contract refuses ETH.
    /// @param sender The account that sent it.
    /// @param amount The ETH sent, in wei.
    error EthRefused(address sender, uint256 amount);

    /// @notice Refuses every ETH transfer.
    /// @dev Always reverts with `EthRefused`.
    receive() external payable {
        revert EthRefused(msg.sender, msg.value);
    }

    /// @notice Swaps `usdcAmount` of this contract's own USDC for ETH at `venue`, accepting any
    /// amount of ETH. The venue then has to send the ETH here, which this contract refuses.
    /// @dev Anyone can call it. Approves `venue` for `usdcAmount` of `usdc`, then calls
    /// `venue.swapUsdcForEth(usdcAmount, 0)` and lets any revert from the venue through.
    /// @param venue The swap venue.
    /// @param usdc The USDC token the venue takes.
    /// @param usdcAmount USDC to swap, in the token's smallest unit.
    function swapAt(
        ISwapVenue venue,
        IERC20 usdc,
        uint256 usdcAmount
    ) external {
        usdc.forceApprove(address(venue), usdcAmount);
        venue.swapUsdcForEth(usdcAmount, 0);
    }
}
