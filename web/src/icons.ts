// The page's few icons: inline stroke drawings in the text colour.

function icon(paths: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const WALLET_ICON = icon(
  '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><path d="M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20V9H6.5A2.5 2.5 0 0 1 4 7.5Z"/><circle cx="16" cy="14.5" r="1"/>',
);

export const CHECK_ICON = icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');

export const CROSS_ICON = icon('<path d="M7 7l10 10M17 7L7 17"/>');
