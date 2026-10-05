// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

/// @title IPriceFeed
/// @author Zhen Zhu
/// @notice The two read functions of a Chainlink price feed that this project uses.
/// @dev Written by hand from the Chainlink Data Feeds API reference (AggregatorV3Interface).
/// The names, parameters, return types and their order are exactly those of Chainlink, so a
/// real Chainlink feed can be used wherever this interface is expected. Only the functions this
/// project calls are listed.
interface IPriceFeed {
    /// @notice Number of decimals in the answer (8 for the ETH / USD feed).
    /// @dev Anyone can call it. It never reverts on a working feed.
    /// @return The number of decimals.
    function decimals() external view returns (uint8);

    /// @notice Latest price and when it was last updated.
    /// @dev Anyone can call it. The caller must check that `answer` is positive and that
    /// `updatedAt` is recent enough; the feed itself does not. This interface does not promise
    /// that the call succeeds: a feed may revert, for example one that has no price yet. When it
    /// does, the call that read it reverts too, because the order contract does not catch it.
    /// @return roundId The round ID.
    /// @return answer The price, with `decimals()` decimals.
    /// @return startedAt Timestamp of when the round started.
    /// @return updatedAt Timestamp of when the round was updated.
    /// @return answeredInRound Deprecated by Chainlink; kept for the exact signature.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
