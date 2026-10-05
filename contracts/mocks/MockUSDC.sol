// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @author Zhen Zhu
/// @notice Stand-in for USDC in local tests and local demos: a plain ERC-20 token with 6 decimals.
/// Anyone can mint any amount to themselves. There is no supply cap and no admin.
/// @dev Not a real asset. Never treat its balances as having value. Apart from `mint` and
/// `decimals`, its functions, events and errors are OpenZeppelin's ERC20, unchanged: anyone can
/// read `name`, `symbol`, `totalSupply`, `balanceOf` and `allowance`, which never revert;
/// anyone can `transfer` their own tokens, `approve` a spender for them, and `transferFrom` up
/// to the allowance they were given, each of which reverts with the matching `ERC20...` error
/// when the balance or the allowance is too small or an address is the zero address.
contract MockUSDC is ERC20 {
    /// @notice Deploys the token with zero supply.
    constructor() ERC20("Mock USD Coin", "mUSDC") {}

    /// @notice Mints `amount` new tokens to the caller.
    /// @dev Anyone can call it. It only ever mints to `msg.sender`, never to another address.
    /// It does not reject any amount; it only reverts if the total supply would overflow.
    /// @param amount Amount in the smallest unit (6 decimals, so 1 token is 1_000_000).
    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /// @notice Number of decimals, the same as USDC.
    /// @dev Anyone can call it; it never reverts.
    /// @return Always 6.
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
