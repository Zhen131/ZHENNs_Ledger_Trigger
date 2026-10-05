// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapVenue} from "../interfaces/ISwapVenue.sol";

/// @title ShortChangingSwapVenue
/// @author Zhen Zhu
/// @notice Test-only swap venue that breaks the `ISwapVenue` promises in the way a test picks.
/// It shows that LedgerTrigger counts what a swap really took and paid by its own balances,
/// instead of trusting the venue.
/// @dev For tests only; never deploy it anywhere else. It ignores the price feed. It pays out of
/// the ETH sent to it beforehand. Anyone can pick its mode.
contract ShortChangingSwapVenue is ISwapVenue {
    using SafeERC20 for IERC20;

    /// @notice How the venue cheats.
    /// @dev `PayGivenAmount`: takes exactly `usdcAmount`, pays `ethToPay` whatever `minEthOut`
    /// says, and reports what it paid. `PayLessReportMore`: takes exactly `usdcAmount`, pays
    /// `minEthOut - 1` and reports `minEthOut`. `TakeLessUsdc`: takes `usdcAmount - 1`, pays
    /// `minEthOut` and reports it.
    enum Mode {
        PayGivenAmount,
        PayLessReportMore,
        TakeLessUsdc
    }

    /// @notice The USDC token this venue takes.
    IERC20 public immutable usdc;
    /// @notice The current mode.
    Mode public mode;
    /// @notice ETH, in wei, paid per swap in `PayGivenAmount` mode.
    uint256 public ethToPay;

    /// @notice Sending the ETH to the caller failed.
    error EthPaymentFailed();

    /// @notice Deploys the venue for one token, in `PayGivenAmount` mode paying nothing.
    /// @param usdc_ The USDC token.
    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    /// @notice Accepts ETH from anyone; this is how the venue is stocked with ETH to pay out.
    /// @dev Anyone can call it; it never reverts. The body is empty on purpose.
    receive() external payable {}

    /// @notice Picks how the venue cheats from now on.
    /// @dev Anyone can call it; it never reverts.
    /// @param newMode The mode.
    /// @param newEthToPay ETH, in wei, to pay per swap in `PayGivenAmount` mode.
    function setMode(Mode newMode, uint256 newEthToPay) external {
        mode = newMode;
        ethToPay = newEthToPay;
    }

    /// @notice Swaps the way the current mode says, breaking the `ISwapVenue` promises on purpose.
    /// @dev Anyone can call it; the caller approves the venue first. Reverts if taking the USDC
    /// fails, if sending the ETH fails (`EthPaymentFailed`), and, through checked arithmetic, in
    /// `PayLessReportMore` mode when `minEthOut` is 0 and in `TakeLessUsdc` mode when `usdcAmount`
    /// is 0.
    /// @param usdcAmount USDC the caller asks to swap, in the token's smallest unit.
    /// @param minEthOut Smallest amount of ETH, in wei, the caller accepts.
    /// @return ethOut ETH, in wei, the venue reports, which is not always what it paid.
    function swapUsdcForEth(
        uint256 usdcAmount,
        uint256 minEthOut
    ) external returns (uint256 ethOut) {
        uint256 usdcTaken = usdcAmount;
        uint256 ethPaid;
        if (mode == Mode.PayGivenAmount) {
            ethPaid = ethToPay;
            ethOut = ethPaid;
        } else if (mode == Mode.PayLessReportMore) {
            ethPaid = minEthOut - 1;
            ethOut = minEthOut;
        } else {
            usdcTaken = usdcAmount - 1;
            ethPaid = minEthOut;
            ethOut = ethPaid;
        }
        usdc.safeTransferFrom(msg.sender, address(this), usdcTaken);
        (bool sent, ) = msg.sender.call{value: ethPaid}("");
        if (!sent) revert EthPaymentFailed();
    }
}
