/**
 * Small, site-neutral DOM and URL primitives shared by the browser adapters.
 *
 * The helpers deliberately accept a DOM element or location object.  They do
 * not query a site-specific selector; that knowledge belongs to an adapter.
 */

export const text = (element) => (element?.innerText || "").replace(/\s+/gu, " ").trim();

export const CONTENT_VERSION = "0.15.1";

export const label = (element) => [element?.getAttribute?.("aria-label"), text(element), element?.title]
  .filter(Boolean)
  .join(" ");

export const visible = (element) =>
  element && !element.disabled && (!element.getClientRects || element.getClientRects().length > 0);

export const pageUrl = (locationLike = globalThis.location) => new URL(locationLike.href);

export const singleQueryValue = (params, key) => {
  const values = params.getAll(key).filter(Boolean);
  if (new Set(values).size > 1) throw new Error(`Conflicting ${key} parameters`);
  return values[0] || null;
};

export const aliasQueryValue = (params, keys, name) => {
  const values = keys.flatMap((key) => params.getAll(key).filter(Boolean));
  if (new Set(values).size > 1) throw new Error(`Conflicting ${name} identifiers`);
  return values[0] || null;
};

export const examCode = (root, bodyText = text(root)) =>
  bodyText.match(/รหัสข้อสอบ\s*:\s*([^\s|]+)/u)?.[1] || null;
