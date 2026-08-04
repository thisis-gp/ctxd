import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Single source of truth for the reported version: the installed package.json.
 * Hardcoding it here drifted from package.json on every release — a published
 * 0.1.0-beta.0 reported itself as 0.1.0.
 */
export const VERSION: string = (require("../package.json") as { version: string }).version;