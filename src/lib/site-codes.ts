/**
 * Codes that differ from one Priority installation to the next. They are read once from the
 * environment when the server starts; the defaults are placeholders, so a real installation sets
 * its own values (see .env.example).
 */
const fromEnv = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

/** WARHSNAME of the bonded warehouse that import files are received into. */
export const BONDED_WAREHOUSE = fromEnv('PRIORITY_BONDED_WAREHOUSE', 'BONDED');

/** WARHSNAME a bonded release goes to when the caller names no warehouse. */
export const DEFAULT_RELEASE_WAREHOUSE = fromEnv('PRIORITY_RELEASE_WAREHOUSE', 'Main');
