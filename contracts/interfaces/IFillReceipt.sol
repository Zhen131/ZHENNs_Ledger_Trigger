// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IFillReceipt
/// @author Zhen Zhu
/// @notice The receipt contract as LedgerTrigger sees it: what a receipt records, which order
/// contract it is bound to, and the one call that issues a receipt. LedgerTrigger only knows this
/// interface.
interface IFillReceipt {
    /// @notice What one receipt records about one fill of an order.
    /// @dev Fields: `orderId` is the order that was filled. `fillNumber` is which fill of that
    /// order it was, counted from 1. `usdcIn` is the USDC this fill spent, in the token's smallest
    /// unit. `ethOut` is the ETH this fill bought, in wei, all of it sent to the order's recipient.
    /// `price` is the price feed's price the fill used, with the price feed's decimals. `filledAt`
    /// is the time of the block in which the fill happened.
    struct Receipt {
        uint256 orderId;
        uint256 fillNumber;
        uint256 usdcIn;
        uint256 ethOut;
        uint256 price;
        uint256 filledAt;
    }

    /// @notice The order contract this receipt contract is bound to: the only address that can
    /// issue receipts.
    /// @dev Anyone can call it. It is fixed at deployment and never changes.
    /// @return The address of the order contract.
    function trigger() external view returns (address);

    /// @notice Issues one new receipt to `to`, recording `data`.
    /// @dev Only the order contract returned by `trigger` can call it; anyone else is refused.
    /// @param to The account that gets the receipt.
    /// @param data What the receipt records.
    /// @return tokenId The ID of the new receipt.
    function mint(
        address to,
        Receipt calldata data
    ) external returns (uint256 tokenId);
}
