/**
 * The embedding surface (`@gr8ful/spf/receipts`): everything a host Worker
 * needs to serve spf receipts under its OWN auth. Node-free. The JWT verify
 * is deliberately not exported: a host authenticates its own way.
 */
export { receiptRoutes } from "../ui/server/receipt_routes.ts";
export { R2ReceiptReader, type R2BucketLike } from "../ui/server/receipt_reader_r2.ts";
export { selectRun, viewerAssetPath, type ReceiptReader } from "../ui/server/receipt_reader.ts";
export { stripBase, injectShell, shellCsp, chromeFromVars, brandFromVars } from "../cloud/shell.ts";
export { applyBrand, sanitizeBrand, type Brand } from "../ui/shared/brand.ts";
export { accessConfig, TEAM_DOMAIN } from "../cloud/access_config.ts";
export { segmentFromSlug } from "../core/repo_segment_name.ts";
