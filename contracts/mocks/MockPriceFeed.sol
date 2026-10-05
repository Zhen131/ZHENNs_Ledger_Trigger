// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

/// @title MockPriceFeed
/// @author Zhen Zhu
/// @notice Stand-in for a Chainlink price feed in local tests and local demos. Anyone can set the
/// price and the update time by hand.
/// @dev Not a real feed. It does not check the price at all: zero and negative prices are stored
/// as given, because checking the price is the job of the contract that reads it.
contract MockPriceFeed is IPriceFeed {
    uint8 private immutable feedDecimals;

    uint80 private roundId;
    int256 private answer;
    uint256 private updatedAt;

    /// @notice Deploys the feed with a fixed number of decimals and a first price.
    /// @dev The first price counts as round 1 and is stamped with the deployment block's time.
    /// @param decimals_ Number of decimals of every price this feed reports. Never changes.
    /// @param initialAnswer First price, with `decimals_` decimals. Any value is accepted.
    constructor(uint8 decimals_, int256 initialAnswer) {
        feedDecimals = decimals_;
        _setAnswer(initialAnswer);
    }

    /// @notice Sets a new price.
    /// @dev Anyone can call it; it never reverts. Any value is accepted, including zero and
    /// negative values. The update time becomes the current block's time and the round ID goes
    /// up by one.
    /// @param newAnswer New price, with `decimals()` decimals.
    function setAnswer(int256 newAnswer) external {
        _setAnswer(newAnswer);
    }

    /// @notice Sets the update time to any moment, past or future, leaving the price alone.
    /// @dev Anyone can call it; it never reverts. The round ID does not change.
    /// @param newUpdatedAt New update time, in seconds since the Unix epoch.
    function setUpdatedAt(uint256 newUpdatedAt) external {
        updatedAt = newUpdatedAt;
    }

    /// @inheritdoc IPriceFeed
    /// @dev Anyone can call it; it never reverts. The value is the one given at deployment.
    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    /// @inheritdoc IPriceFeed
    /// @dev Anyone can call it; it never reverts. `startedAt` always equals `updatedAt`, and
    /// `answeredInRound` always equals `roundId`.
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function _setAnswer(int256 newAnswer) private {
        answer = newAnswer;
        updatedAt = block.timestamp;
        ++roundId;
    }
}
