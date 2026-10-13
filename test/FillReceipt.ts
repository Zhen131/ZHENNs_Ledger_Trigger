import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifacts, network } from "hardhat";
import { getAddress, parseEventLogs, zeroAddress } from "viem";

// The receipt contract on its own, without LedgerTrigger: its shape (the ABI
// of FillReceipt and of the IFillReceipt interface LedgerTrigger uses) and its
// issuing rules. Here it is bound to a plain test account, the issuer, which
// calls `mint` directly, as LedgerTrigger does during a fill.

type AbiParameter = {
  readonly name: string;
  readonly type: string;
  readonly indexed?: boolean;
  readonly components?: readonly AbiParameter[];
};
type AbiEntry = {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
  readonly inputs?: readonly AbiParameter[];
  readonly outputs?: readonly AbiParameter[];
};

/** One line per function: mutability, name, inputs and named outputs. */
function functionSignatures(abi: readonly AbiEntry[]): string[] {
  const show = (parameters: readonly AbiParameter[] = []) =>
    parameters
      .map((parameter) => `${parameter.type} ${parameter.name}`.trim())
      .join(", ");
  return abi
    .filter((entry) => entry.type === "function")
    .map(
      (entry) =>
        `${entry.name ?? ""}(${show(entry.inputs)}) ${entry.stateMutability ?? ""} returns (${show(entry.outputs)})`,
    )
    .sort();
}

/** Name, type and (for events) indexed flag of each input, per entry. */
function inputsOf(abi: readonly AbiEntry[], type: string) {
  return abi
    .filter((entry) => entry.type === type)
    .map((entry) => [
      entry.name,
      (entry.inputs ?? []).map((input) =>
        input.indexed === undefined
          ? [input.name, input.type]
          : [input.name, input.type, input.indexed],
      ),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

/** Field names of the tuple parameter named `name` of function `fn`. */
function tupleFields(
  abi: readonly AbiEntry[],
  fn: string,
  side: "inputs" | "outputs",
  name: string,
) {
  const entry = abi.find((e) => e.type === "function" && e.name === fn);
  const parameter = entry?.[side]?.find((p) => p.name === name);
  return (parameter?.components ?? []).map((c) => `${c.type} ${c.name}`);
}

const RECEIPT_FIELDS = [
  "uint256 orderId",
  "uint256 fillNumber",
  "uint256 usdcIn",
  "uint256 ethOut",
  "uint256 price",
  "uint256 filledAt",
];

/**
 * A new local chain with one FillReceipt bound to the test account
 * `issuer`. `alice` and `bob` get receipts; `stranger` has no role.
 */
async function setUpReceipt() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [, issuer, alice, bob, stranger] = await viem.getWalletClients();
  if (
    issuer === undefined ||
    alice === undefined ||
    bob === undefined ||
    stranger === undefined
  ) {
    throw new Error("the local chain must provide at least five test accounts");
  }
  const fillReceipt = await viem.deployContract("FillReceipt", [
    issuer.account.address,
  ]);
  return { viem, publicClient, issuer, alice, bob, stranger, fillReceipt };
}

describe("FillReceipt: shape", () => {
  it("has exactly OpenZeppelin's ERC-721 functions plus trigger, mint and receiptOf, with approve and setApprovalForAll pure", async () => {
    const { abi } = await artifacts.readArtifact("FillReceipt");

    assert.deepEqual(functionSignatures(abi), [
      "approve(address, uint256 tokenId) pure returns ()",
      "balanceOf(address owner) view returns (uint256)",
      "getApproved(uint256 tokenId) view returns (address)",
      "isApprovedForAll(address owner, address operator) view returns (bool)",
      "mint(address to, tuple data) nonpayable returns (uint256 tokenId)",
      "name() view returns (string)",
      "ownerOf(uint256 tokenId) view returns (address)",
      "receiptOf(uint256 tokenId) view returns (tuple data)",
      "safeTransferFrom(address from, address to, uint256 tokenId) nonpayable returns ()",
      "safeTransferFrom(address from, address to, uint256 tokenId, bytes data) nonpayable returns ()",
      "setApprovalForAll(address, bool) pure returns ()",
      "supportsInterface(bytes4 interfaceId) view returns (bool)",
      "symbol() view returns (string)",
      "tokenURI(uint256 tokenId) view returns (string)",
      "transferFrom(address from, address to, uint256 tokenId) nonpayable returns ()",
      "trigger() view returns (address)",
    ]);
    assert.deepEqual(
      tupleFields(abi, "mint", "inputs", "data"),
      RECEIPT_FIELDS,
    );
    assert.deepEqual(
      tupleFields(abi, "receiptOf", "outputs", "data"),
      RECEIPT_FIELDS,
    );
    assert.deepEqual(
      abi
        .filter((entry) => entry.type === "constructor")
        .map((entry) => [
          entry.stateMutability,
          (entry.inputs ?? []).map((input) => `${input.type} ${input.name}`),
        ]),
      [["nonpayable", ["address trigger_"]]],
    );
    assert.deepEqual(
      [...new Set(abi.map((entry) => entry.type))].sort(),
      ["constructor", "error", "event", "function"],
      "no receive or fallback function: it takes no ETH",
    );
  });

  it("logs OpenZeppelin's three ERC-721 events and ReceiptIssued, with all three of its parameters indexed", async () => {
    const { abi } = await artifacts.readArtifact("FillReceipt");

    assert.deepEqual(inputsOf(abi, "event"), [
      [
        "Approval",
        [
          ["owner", "address", true],
          ["approved", "address", true],
          ["tokenId", "uint256", true],
        ],
      ],
      [
        "ApprovalForAll",
        [
          ["owner", "address", true],
          ["operator", "address", true],
          ["approved", "bool", false],
        ],
      ],
      [
        "ReceiptIssued",
        [
          ["tokenId", "uint256", true],
          ["orderId", "uint256", true],
          ["owner", "address", true],
        ],
      ],
      [
        "Transfer",
        [
          ["from", "address", true],
          ["to", "address", true],
          ["tokenId", "uint256", true],
        ],
      ],
    ]);
  });

  it("has three errors of its own, ZeroTrigger, NotTrigger(caller) and ReceiptNotTransferable(tokenId), besides OpenZeppelin's ERC-721 errors", async () => {
    const { abi } = await artifacts.readArtifact("FillReceipt");

    assert.deepEqual(inputsOf(abi, "error"), [
      [
        "ERC721IncorrectOwner",
        [
          ["sender", "address"],
          ["tokenId", "uint256"],
          ["owner", "address"],
        ],
      ],
      [
        "ERC721InsufficientApproval",
        [
          ["operator", "address"],
          ["tokenId", "uint256"],
        ],
      ],
      ["ERC721InvalidApprover", [["approver", "address"]]],
      ["ERC721InvalidOperator", [["operator", "address"]]],
      ["ERC721InvalidOwner", [["owner", "address"]]],
      ["ERC721InvalidReceiver", [["receiver", "address"]]],
      ["ERC721InvalidSender", [["sender", "address"]]],
      ["ERC721NonexistentToken", [["tokenId", "uint256"]]],
      ["NotTrigger", [["caller", "address"]]],
      ["ReceiptNotTransferable", [["tokenId", "uint256"]]],
      ["ZeroTrigger", []],
    ]);
  });

  it("supports the ERC-721 and ERC-721 metadata interfaces, not the enumerable one", async () => {
    const { fillReceipt } = await setUpReceipt();

    assert.equal(
      await fillReceipt.read.supportsInterface(["0x01ffc9a7"]),
      true,
    );
    assert.equal(
      await fillReceipt.read.supportsInterface(["0x80ac58cd"]),
      true,
    );
    assert.equal(
      await fillReceipt.read.supportsInterface(["0x5b5e139f"]),
      true,
    );
    assert.equal(
      await fillReceipt.read.supportsInterface(["0x780e9d63"]),
      false,
    );
  });

  it("IFillReceipt has exactly two functions, trigger and mint, and the six receipt fields in order", async () => {
    const { abi } = await artifacts.readArtifact("IFillReceipt");

    assert.deepEqual(functionSignatures(abi), [
      "mint(address to, tuple data) nonpayable returns (uint256 tokenId)",
      "trigger() view returns (address)",
    ]);
    assert.deepEqual(
      tupleFields(abi, "mint", "inputs", "data"),
      RECEIPT_FIELDS,
    );
    assert.deepEqual(
      abi.filter((entry) => entry.type !== "function"),
      [],
      "the interface declares nothing but functions",
    );
  });
});

describe("FillReceipt: issuing receipts", () => {
  it("refuses to deploy bound to the zero address with ZeroTrigger", async () => {
    const { viem, fillReceipt } = await setUpReceipt();

    await viem.assertions.revertWithCustomError(
      viem
        .deployContract("FillReceipt", [zeroAddress])
        .then((deployed) => deployed.address),
      fillReceipt,
      "ZeroTrigger",
    );
  });

  it("the account it is bound to issues receipts numbered 1, 2, ... to anyone, each logged as a Transfer from the zero address and then ReceiptIssued, and receiptOf returns what was recorded", async () => {
    const { publicClient, issuer, alice, bob, fillReceipt } =
      await setUpReceipt();
    assert.equal(
      await fillReceipt.read.trigger(),
      getAddress(issuer.account.address),
    );
    assert.equal(await fillReceipt.read.name(), "Ledger Trigger Fill Receipt");
    assert.equal(await fillReceipt.read.symbol(), "LTFR");

    const issued = [
      {
        to: getAddress(alice.account.address),
        data: {
          orderId: 7n,
          fillNumber: 1n,
          usdcIn: 100_000_000n,
          ethOut: 50_000_000_000_000_000n,
          price: 200_000_000_000n,
          filledAt: 1_800_000_000n,
        },
      },
      {
        to: getAddress(bob.account.address),
        data: {
          orderId: 3n,
          fillNumber: 2n,
          usdcIn: 150_000_000n,
          ethOut: 78_947_368_421_052_631n,
          price: 190_000_000_000n,
          filledAt: 1_800_000_600n,
        },
      },
    ];

    for (const [index, { to, data }] of issued.entries()) {
      const tokenId = BigInt(index + 1);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: await fillReceipt.write.mint([to, data], {
          account: issuer.account,
        }),
      });
      assert.equal(receipt.status, "success");
      const logs = parseEventLogs({
        abi: fillReceipt.abi,
        logs: receipt.logs.filter(
          (log) => getAddress(log.address) === getAddress(fillReceipt.address),
        ),
      });
      assert.equal(receipt.logs.length, 2);
      assert.deepEqual(
        logs.map((log) => log.eventName),
        ["Transfer", "ReceiptIssued"],
      );
      assert.deepEqual(logs[0]?.args, { from: zeroAddress, to, tokenId });
      assert.deepEqual(logs[1]?.args, {
        tokenId,
        orderId: data.orderId,
        owner: to,
      });

      assert.equal(await fillReceipt.read.ownerOf([tokenId]), to);
      assert.deepEqual(await fillReceipt.read.receiptOf([tokenId]), data);
    }
    assert.equal(await fillReceipt.read.balanceOf([alice.account.address]), 1n);
    assert.equal(await fillReceipt.read.balanceOf([bob.account.address]), 1n);
  });

  it("refuses mint from any account but the one it is bound to with NotTrigger naming the caller, and uses up no receipt ID", async () => {
    const { viem, publicClient, issuer, alice, stranger, fillReceipt } =
      await setUpReceipt();
    const data = {
      orderId: 1n,
      fillNumber: 1n,
      usdcIn: 100_000_000n,
      ethOut: 50_000_000_000_000_000n,
      price: 200_000_000_000n,
      filledAt: 1_800_000_000n,
    };

    for (const caller of [stranger, alice]) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        fillReceipt.write.mint([caller.account.address, data], {
          account: caller.account,
        }),
        fillReceipt,
        "NotTrigger",
        [getAddress(caller.account.address)],
      );
      assert.equal(
        await fillReceipt.read.balanceOf([caller.account.address]),
        0n,
      );
    }
    await viem.assertions.revertWithCustomErrorWithArgs(
      fillReceipt.read.ownerOf([1n]),
      fillReceipt,
      "ERC721NonexistentToken",
      [1n],
    );

    await publicClient.waitForTransactionReceipt({
      hash: await fillReceipt.write.mint([alice.account.address, data], {
        account: issuer.account,
      }),
    });
    assert.equal(
      await fillReceipt.read.ownerOf([1n]),
      getAddress(alice.account.address),
    );
    await viem.assertions.revertWithCustomErrorWithArgs(
      fillReceipt.read.ownerOf([2n]),
      fillReceipt,
      "ERC721NonexistentToken",
      [2n],
    );
  });
});
