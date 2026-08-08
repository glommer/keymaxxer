import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory holding the vault and its metadata.
 *
 * Resolution order:
 * 1. `KEYMAXXER_DB_DIR` if set - override with no fallback
 * 2. `$XDG_CONFIG_HOME/keymaxxer` if `XDG_CONFIG_HOME` is set and that dir exists
 * 3. `~/.keymaxxer`
 */
export function defaultVaultDir(): string {
  const override = process.env.KEYMAXXER_DB_DIR;
  if (override) return override;

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    const xdgDir = join(xdg, "keymaxxer");
    if (existsSync(xdgDir)) return xdgDir;
  }

  return join(process.env.HOME || homedir(), ".keymaxxer");
}

/** Default vault file path: `<dir>/vault.db`. */
export function defaultVaultPath(): string {
  return join(defaultVaultDir(), "vault.db");
}
