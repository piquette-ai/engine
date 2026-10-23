/**
 * Receipt store key rules, node-free so Worker-path code (the receipts
 * viewer) can share them with `receipt_store.ts`, which re-exports `assertKey`.
 */

/** Throws on any key that could escape the store's root, or that S3 and a filesystem would read differently. */
export function assertKey(key: string, what = "key"): string {
  if (typeof key !== "string" || key.length === 0) throw new Error(`receipt store ${what} is empty`);
  if (key.startsWith("/")) throw new Error(`receipt store ${what} ${JSON.stringify(key)} must be relative (no leading "/")`);
  if (key.includes("\\")) throw new Error(`receipt store ${what} ${JSON.stringify(key)} must use "/" separators, not "\\"`);
  if (key.length > 1024) throw new Error(`receipt store ${what} is longer than 1024 characters`);
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`receipt store ${what} ${JSON.stringify(key)} has an empty, "." or ".." segment`);
    }
  }
  return key;
}
