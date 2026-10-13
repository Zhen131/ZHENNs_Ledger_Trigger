// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {IFillReceipt} from "./interfaces/IFillReceipt.sol";

/// @title FillReceipt
/// @author Zhen Zhu
/// @notice Receipts for the fills of LedgerTrigger orders, one ERC-721 token for each fill. Each
/// receipt is issued to the owner of the order that was filled and records the order, which fill
/// of it this was, the USDC it spent, the ETH it bought, the price it used and when it happened.
/// A receipt can never be transferred, and no one can be approved to move it: it stays with the
/// account it was issued to for good.
/// @dev There is no admin: no pause, no upgrade, no setter, no burning and no withdrawal. The
/// order contract allowed to issue receipts is fixed at deployment. It is bound the other way
/// too: the order contract checks, when it is deployed, that this contract names it. Receipt IDs
/// start at 1 and go up by one with each receipt, across all orders; an ID is never used twice.
/// `tokenURI` is OpenZeppelin's: an empty string for a receipt that exists. Errors from
/// OpenZeppelin's ERC-721 also apply, such as `ERC721NonexistentToken` for an ID that no receipt
/// has.
contract FillReceipt is ERC721, IFillReceipt {
    /// @notice The order contract this receipt contract is bound to: the only address that can
    /// issue receipts. Fixed at deployment.
    address public immutable trigger;

    /// @notice The ID of the last receipt issued; 0 before the first.
    uint256 private lastTokenId;

    /// @notice What each receipt records, by receipt ID.
    mapping(uint256 tokenId => Receipt data) private receipts;

    /// @notice A receipt was issued.
    /// @param tokenId The ID of the new receipt.
    /// @param orderId The order whose fill it records.
    /// @param owner The account it was issued to: the owner of that order.
    event ReceiptIssued(
        uint256 indexed tokenId,
        uint256 indexed orderId,
        address indexed owner
    );

    /// @notice The order contract given at deployment is the zero address.
    error ZeroTrigger();
    /// @notice Someone other than the order contract tried to issue a receipt.
    /// @param caller The account that tried.
    error NotTrigger(address caller);
    /// @notice Receipts cannot be transferred, and no one can be approved to move them.
    /// @param tokenId The receipt someone tried to transfer or approve; 0, which is never a
    /// receipt, for an approval of all of an owner's receipts.
    error ReceiptNotTransferable(uint256 tokenId);

    /// @notice Lets only the order contract through.
    /// @dev Reverts with `NotTrigger` for any other caller.
    modifier onlyTrigger() {
        if (msg.sender != trigger) revert NotTrigger(msg.sender);
        _;
    }

    /// @notice Deploys the receipt contract, bound to one order contract for good.
    /// @dev Rejects the zero address (`ZeroTrigger`). The order contract does not have to exist
    /// yet: its deployment checks this binding.
    /// @param trigger_ The order contract that will issue the receipts.
    constructor(
        address trigger_
    ) ERC721("Ledger Trigger Fill Receipt", "LTFR") {
        if (trigger_ == address(0)) revert ZeroTrigger();
        trigger = trigger_;
    }

    /// @notice Issues one new receipt to `to`, recording `data`.
    /// @dev Only the order contract can call it (`NotTrigger`). The new receipt gets the next ID.
    /// It emits OpenZeppelin's `Transfer` from the zero address, then `ReceiptIssued`. It does not
    /// call `to`, so issuing a receipt runs no code of the account that gets it.
    /// @param to The account that gets the receipt.
    /// @param data What the receipt records.
    /// @return tokenId The ID of the new receipt.
    function mint(
        address to,
        Receipt calldata data
    ) external onlyTrigger returns (uint256 tokenId) {
        tokenId = ++lastTokenId;
        receipts[tokenId] = data;
        _mint(to, tokenId);
        emit ReceiptIssued(tokenId, data.orderId, to);
    }

    /// @notice What a receipt records.
    /// @dev Anyone can call it. Rejects an ID that no receipt has, ID 0 included
    /// (`ERC721NonexistentToken`).
    /// @param tokenId The receipt.
    /// @return data What it records.
    function receiptOf(
        uint256 tokenId
    ) external view returns (Receipt memory data) {
        _requireOwned(tokenId);
        data = receipts[tokenId];
    }

    /// @notice Always refused: no one can be approved to move a receipt.
    /// @dev Reverts with `ReceiptNotTransferable` for the receipt named, whatever the input,
    /// before any other check.
    /// @param tokenId The receipt named.
    function approve(address, uint256 tokenId) public pure override {
        revert ReceiptNotTransferable(tokenId);
    }

    /// @notice Always refused: no one can be approved to move an owner's receipts.
    /// @dev Reverts with `ReceiptNotTransferable(0)` whatever the input, before any other check:
    /// it names no single receipt, and 0 is never a receipt.
    function setApprovalForAll(address, bool) public pure override {
        revert ReceiptNotTransferable(0);
    }

    /// @notice OpenZeppelin's hook for every change of a receipt's owner, changed so that a
    /// receipt can be issued but never moved.
    /// @dev Lets a new receipt through, one that has no owner yet; for a receipt that has an
    /// owner it reverts with `ReceiptNotTransferable`. Every transfer goes through here, so
    /// `transferFrom` and both `safeTransferFrom` are refused this way. Two cases are refused by
    /// OpenZeppelin instead: a transfer to the zero address, before it gets here
    /// (`ERC721InvalidReceiver`), and a transfer of an ID that no receipt has, which has no owner
    /// and so passes this check, but is then refused while the caller's right to move it is
    /// checked (`ERC721NonexistentToken`); no receipt comes out of it.
    /// @param to The new owner.
    /// @param tokenId The receipt.
    /// @param auth The account whose right to move the receipt is checked, or zero for none.
    /// @return The previous owner: the zero address, as only issuing gets through.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) {
            revert ReceiptNotTransferable(tokenId);
        }
        return super._update(to, tokenId, auth);
    }
}
