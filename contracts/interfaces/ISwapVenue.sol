// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

/// @title ISwapVenue
/// @author Zhen Zhu
/// @notice A place that swaps USDC for ETH. The order contract only knows this interface, so the
/// venue behind it can be replaced without changing the order contract.
interface ISwapVenue {
    /// @notice Swaps exactly `usdcAmount` USDC from the caller for ETH sent back to the caller.
    /// @dev Anyone can call it. The caller must first approve the venue to take at least
    /// `usdcAmount` USDC. The venue takes exactly `usdcAmount` USDC from the caller and sends the
    /// ETH to the caller. If the swap would give less than `minEthOut` ETH, the whole call reverts
    /// and nothing moves.
    /// @param usdcAmount Amount of USDC to swap, in the token's smallest unit.
    /// @param minEthOut Smallest amount of ETH, in wei, the caller accepts.
    /// @return ethOut Amount of ETH, in wei, sent to the caller.
    function swapUsdcForEth(
        uint256 usdcAmount,
        uint256 minEthOut
    ) external returns (uint256 ethOut);
}
