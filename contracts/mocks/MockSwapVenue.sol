// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {ISwapVenue} from "../interfaces/ISwapVenue.sol";

/// @title MockSwapVenue
/// @author Zhen Zhu
/// @notice Stand-in swap venue: swaps USDC for ETH at the price its price feed reports, minus a
/// fee fixed at deployment. It pays out of the ETH that has been sent to it beforehand.
/// @dev Not a real exchange. It is open to everyone and has no admin: nobody can change its fee,
/// its token or its feed after deployment, and nobody can take its ETH out except by swapping.
/// It does not look at how old the price is, just as a real venue does not. The error
/// `SafeERC20FailedOperation` in its interface comes from OpenZeppelin: a USDC transfer that
/// failed without an error of its own, or returned false.
contract MockSwapVenue is ISwapVenue {
    using SafeERC20 for IERC20;

    /// @notice Basis points in 100 %.
    uint256 private constant BPS = 10_000;
    /// @notice Largest fee accepted at deployment: just under 100 %.
    uint256 private constant MAX_FEE_BPS = BPS - 1;
    /// @notice ETH has 18 decimals.
    uint256 private constant ETH_DECIMALS = 18;
    /// @notice Largest power of ten that fits in a uint256 is 10^77.
    uint256 private constant MAX_SCALE_EXPONENT = 77;

    /// @notice The USDC token this venue takes. Fixed at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    IERC20 public immutable usdc;
    /// @notice The price feed this venue swaps at (ETH price in USD). Fixed at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    IPriceFeed public immutable priceFeed;
    /// @notice Fee in basis points, taken out of the ETH paid. Fixed at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint256 public immutable feeBps;
    /// @notice Decimals of `usdc`, read from the token at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint8 public immutable usdcDecimals;
    /// @notice Decimals of `priceFeed`, read from the feed at deployment.
    /// @dev Anyone can read it; reading it never reverts.
    uint8 public immutable priceDecimals;
    /// @notice 10^k with k = 18 + priceDecimals - usdcDecimals.
    uint256 private immutable scale;

    /// @notice The fee given at deployment is 100 % or more.
    /// @param feeBps The rejected fee, in basis points.
    error FeeTooHigh(uint256 feeBps);
    /// @notice The token and feed decimals cannot be combined into a uint256 scale factor.
    /// @param usdcDecimals Decimals reported by the token.
    /// @param priceDecimals Decimals reported by the feed.
    error UnsupportedDecimals(uint8 usdcDecimals, uint8 priceDecimals);
    /// @notice The feed reports a price of zero or below.
    /// @param price The price the feed reported.
    error NonPositivePrice(int256 price);
    /// @notice The swap would give less ETH than the caller accepts.
    /// @param ethOut ETH the swap would give, in wei.
    /// @param minEthOut Smallest amount the caller accepts, in wei.
    error InsufficientOutput(uint256 ethOut, uint256 minEthOut);
    /// @notice The venue holds less ETH than the swap would pay.
    /// @param available ETH the venue holds, in wei.
    /// @param needed ETH the swap would pay, in wei.
    error InsufficientEthReserve(uint256 available, uint256 needed);
    /// @notice Sending the ETH to the caller failed.
    error EthTransferFailed();

    /// @notice Deploys the venue for one token and one price feed, with a fixed fee.
    /// @dev Reads and stores the decimals of the token and of the feed. Reverts with
    /// `FeeTooHigh` if `feeBps_` is 100 % (10000) or more, and with `UnsupportedDecimals` if the
    /// decimals do not fit the conversion. It also reverts if the token or the feed does not
    /// report its decimals.
    /// @param usdc_ The USDC token.
    /// @param priceFeed_ The price feed for ETH in USD.
    /// @param feeBps_ Fee in basis points (30 is 0.3 %). Must be below 10000. Never changes.
    constructor(IERC20 usdc_, IPriceFeed priceFeed_, uint256 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        uint8 usdcDecimals_ = IERC20Metadata(address(usdc_)).decimals();
        uint8 priceDecimals_ = priceFeed_.decimals();
        uint256 withEth = ETH_DECIMALS + priceDecimals_;
        if (
            usdcDecimals_ > withEth ||
            withEth - usdcDecimals_ > MAX_SCALE_EXPONENT
        ) {
            revert UnsupportedDecimals(usdcDecimals_, priceDecimals_);
        }
        usdc = usdc_;
        priceFeed = priceFeed_;
        feeBps = feeBps_;
        usdcDecimals = usdcDecimals_;
        priceDecimals = priceDecimals_;
        scale = 10 ** (withEth - usdcDecimals_);
    }

    /// @notice Accepts ETH from anyone. This is how the venue is stocked with ETH to pay out.
    /// @dev Anyone can call it; it never reverts. There is no way to take the ETH back out other
    /// than swapping USDC for it. The body is empty on purpose: receiving is the whole job.
    receive() external payable {}

    /// @inheritdoc ISwapVenue
    /// @dev Anyone can call it; the caller approves the venue for `usdcAmount` USDC first.
    /// Pays `mulDiv(mulDiv(usdcAmount, 10^k, price), 10000 - feeBps, 10000)` wei, each step
    /// rounded down. Checks, in order: the price is above zero (`NonPositivePrice`); the payout
    /// is at least `minEthOut` (`InsufficientOutput`); the venue holds enough ETH
    /// (`InsufficientEthReserve`). Then it takes the USDC, which reverts with the token's own
    /// error if the allowance or the balance is too small, and sends the ETH
    /// (`EthTransferFailed`).
    function swapUsdcForEth(
        uint256 usdcAmount,
        uint256 minEthOut
    ) external returns (uint256 ethOut) {
        (, int256 price, , , ) = priceFeed.latestRoundData();
        if (price < 1) revert NonPositivePrice(price);

        uint256 gross = Math.mulDiv(usdcAmount, scale, uint256(price));
        ethOut = Math.mulDiv(gross, BPS - feeBps, BPS);
        if (ethOut < minEthOut) revert InsufficientOutput(ethOut, minEthOut);
        uint256 available = address(this).balance;
        if (ethOut > available) {
            revert InsufficientEthReserve(available, ethOut);
        }

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        (bool sent, ) = msg.sender.call{value: ethOut}("");
        if (!sent) revert EthTransferFailed();
    }
}
