// Installs the stand-in wallet as `window.ethereum` on the development page,
// unless the browser already has a wallet: a real wallet is never replaced.
// The note at the top of the page says which of the two happened.

import { createStandIn, standInOptionsFrom } from "./standIn.ts";

const note = document.getElementById("dev-note");
const show = (text: string): void => {
  if (note !== null) note.textContent = text;
};
const page = window as unknown as Record<string, unknown>;

if (page["ethereum"] !== undefined) {
  show(
    "Development page: a wallet is already present; the stand-in is not installed.",
  );
} else {
  const parsed = standInOptionsFrom(window.location.search);
  if (!parsed.ok) {
    show(`Development page: the stand-in is not installed. ${parsed.message}`);
  } else {
    const standIn = createStandIn(parsed.options);
    page["ethereum"] = standIn;
    show(
      `Development page: the stand-in wallet acts as test account #${parsed.options.accountIndex} of the local node${parsed.options.reject ? " and rejects every transaction" : ""}. It holds no key; the node signs.`,
    );
    standIn.checkChain().catch((error: unknown) => {
      show(
        `Development page: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
