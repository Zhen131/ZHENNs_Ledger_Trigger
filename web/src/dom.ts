// Small helpers for the page's elements.

/** The element with `id`; the page's own markup always has it. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`The page has no element #${id}.`);
  return element as T;
}

/** Sets the text only when it changed, so nothing flickers on a refresh. */
export function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Shows or hides an element. */
export function setShown(element: HTMLElement, shown: boolean): void {
  if (element.hidden === shown) element.hidden = !shown;
}

/** A new element with a class and, optionally, text. */
export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== "") element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Local date and time of a Unix time in seconds: 2026-10-11 18:45:12. */
export function formatDateTime(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${formatClock(seconds)}`;
}

/** Local time of day of a Unix time in seconds: 18:45:12. */
export function formatClock(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Reads a remembered value; undefined when the browser keeps none. */
export function remembered(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remembers a value in the browser, when the browser allows it. */
export function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be off (private windows); the page works without it.
  }
}
