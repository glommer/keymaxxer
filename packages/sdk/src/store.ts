import { connect } from "@tursodatabase/database";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultVaultPath } from "./paths.js";
import { runWithSecrets } from "./runner.js";
import type { AuditEntry, RunRequest, RunResult, SecretFields, SecretMeta } from "./types.js";

export { defaultVaultDir, defaultVaultPath } from "./paths.js";

/** The cipher used for whole-database encryption at rest. */
export const DEFAULT_CIPHER = "aes256gcm";

export interface OpenOptions {
  path?: string;
  /** 64-char hex encryption key. Required — the caller resolves key custody. */
  hexkey: string;
  cipher?: string;
}

/** Thrown when the vault cannot be decrypted with the supplied key. */
export class WrongKeyError extends Error {
  constructor() {
    super("Could not decrypt the vault — wrong passphrase or key.");
    this.name = "WrongKeyError";
  }
}

/**
 * The encrypted secret store. Wraps a Turso database opened with whole-file
 * AES-256-GCM encryption. Secret values are readable only through `run()`,
 * which injects them into a child process — they are never returned to callers.
 */
/**
 * Runtime-accurate view of the Turso driver: `prepare` is synchronous and the
 * statement methods are async. (The shipped .d.ts types `prepare` as async,
 * which doesn't match the engine, so we model what actually runs.)
 */
interface TursoStatement {
  run(params?: unknown): Promise<unknown>;
  get(params?: unknown): Promise<unknown>;
  all(params?: unknown): Promise<unknown[]>;
}
interface TursoDb {
  prepare(sql: string): TursoStatement;
  close?(): Promise<void> | void;
}

export class SecretStore {
  private constructor(private readonly db: TursoDb) {}

  static async open(opts: OpenOptions): Promise<SecretStore> {
    const path = opts.path ?? defaultVaultPath();
    mkdirSync(dirname(path), { recursive: true });
    try {
      chmodSync(dirname(path), 0o700); // only the owner may reach the vault
    } catch {
      /* best-effort */
    }
    try {
      const db = (await connect(path, {
        encryption: { cipher: opts.cipher ?? DEFAULT_CIPHER, hexkey: opts.hexkey },
        // Shared multi-process WAL so the agent daemon and a CLI/init open can
        // coexist without an exclusive WAL lock; busy-wait briefly for locks.
        experimental: ["multiprocess_wal"],
        timeout: 5000,
      } as Parameters<typeof connect>[1])) as unknown as TursoDb;
      const store = new SecretStore(db);
      await store.migrate();
      return store;
    } catch (err) {
      // An existing vault opened with the wrong key fails to decrypt its pages
      // (AES-256-GCM auth tag mismatch), surfaced by connect() or the first read.
      const msg = err instanceof Error ? err.message : String(err);
      if (/decrypt/i.test(msg)) throw new WrongKeyError();
      throw err;
    }
  }

  /** Close the underlying database handle (best-effort). */
  async close(): Promise<void> {
    try {
      await this.db.close?.();
    } catch {
      /* already closed or no close method */
    }
  }

  /** Optional structured columns added after the initial release. */
  private static readonly META_COLUMNS = ["provider", "account", "environment", "access", "description"];

  private async migrate(): Promise<void> {
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS secrets (
           name         TEXT PRIMARY KEY,
           value        TEXT NOT NULL,
           tags         TEXT NOT NULL DEFAULT '',
           provider     TEXT,
           account      TEXT,
           environment  TEXT,
           access       TEXT,
           description  TEXT,
           created_at   TEXT NOT NULL,
           last_used_at TEXT
         )`,
      )
      .run();
    // Forward-compatible migration: add metadata columns to vaults created
    // before they existed. Duplicate-column errors mean it's already there.
    for (const col of SecretStore.META_COLUMNS) {
      try {
        await this.db.prepare(`ALTER TABLE secrets ADD COLUMN ${col} TEXT`).run();
      } catch {
        /* column already exists */
      }
    }
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS audit_log (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           ts         TEXT NOT NULL,
           secrets    TEXT NOT NULL,
           command    TEXT NOT NULL,
           cwd        TEXT NOT NULL,
           exit_code  INTEGER,
           outcome    TEXT
         )`,
      )
      .run();
    try {
      await this.db.prepare(`ALTER TABLE audit_log ADD COLUMN outcome TEXT`).run();
    } catch {
      /* column already exists */
    }
  }

  /**
   * Create or update a secret. The value is always replaced; metadata fields
   * are preserved when not supplied (so rotating a value keeps its attributes).
   */
  async set(name: string, value: string, fields: SecretFields = {}): Promise<void> {
    const tags = fields.tags ? fields.tags.join(",") : "";
    await this.db
      .prepare(
        `INSERT INTO secrets
           (name, value, tags, provider, account, environment, access, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           value       = excluded.value,
           tags        = COALESCE(NULLIF(excluded.tags, ''), secrets.tags),
           provider    = COALESCE(excluded.provider, secrets.provider),
           account     = COALESCE(excluded.account, secrets.account),
           environment = COALESCE(excluded.environment, secrets.environment),
           access      = COALESCE(excluded.access, secrets.access),
           description = COALESCE(excluded.description, secrets.description)`,
      )
      .run([
        name,
        value,
        tags,
        fields.provider ?? null,
        fields.account ?? null,
        fields.environment ?? null,
        fields.access ?? null,
        fields.description ?? null,
        new Date().toISOString(),
      ]);
  }

  /** Delete a secret. Returns true if a row was removed. */
  async remove(name: string): Promise<boolean> {
    const before = await this.db.prepare(`SELECT 1 FROM secrets WHERE name = ?`).get([name]);
    await this.db.prepare(`DELETE FROM secrets WHERE name = ?`).run([name]);
    return before != null;
  }

  /** List metadata for every secret. Never includes values. */
  async list(): Promise<SecretMeta[]> {
    const rows = (await this.db
      .prepare(
        `SELECT name, tags, provider, account, environment, access, description, created_at, last_used_at
         FROM secrets ORDER BY name`,
      )
      .all()) as Array<{
      name: string;
      tags: string | null;
      provider: string | null;
      account: string | null;
      environment: string | null;
      access: string | null;
      description: string | null;
      created_at: string;
      last_used_at: string | null;
    }>;
    return rows.map((r) => ({
      name: r.name,
      tags: r.tags ? r.tags.split(",") : [],
      provider: r.provider,
      account: r.account,
      environment: r.environment,
      access: r.access,
      description: r.description,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /** True if a secret with this name exists. */
  async has(name: string): Promise<boolean> {
    return (await this.db.prepare(`SELECT 1 FROM secrets WHERE name = ?`).get([name])) != null;
  }

  /** Read a raw value. Kept private to the SDK — callers use run(). */
  private async value(name: string): Promise<string | null> {
    const row = (await this.db.prepare(`SELECT value FROM secrets WHERE name = ?`).get([name])) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Resolve the named secrets, inject them as environment variables, run the
   * command, scrub the output, then record the access. Throws if any named
   * secret is unknown — fail closed rather than run with a missing credential.
   */
  async run(req: RunRequest): Promise<RunResult> {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of req.secrets) {
      const v = await this.value(name);
      if (v == null) missing.push(name);
      else env[name] = v;
    }
    if (missing.length > 0) {
      throw new Error(`Unknown secret(s): ${missing.join(", ")}. Run \`keymaxxer list\` to see names.`);
    }

    const result = await runWithSecrets({
      command: req.command,
      env,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
    });

    await this.touch(req.secrets);
    await this.audit({
      ts: new Date().toISOString(),
      secrets: req.secrets,
      command: req.command,
      cwd: req.cwd ?? process.cwd(),
      exitCode: result.exitCode,
      outcome: "ran",
    });
    return result;
  }

  /** Record an attempt that was refused before running (approval denied). */
  async auditDenied(secrets: string[], command: string, cwd: string): Promise<void> {
    await this.audit({
      ts: new Date().toISOString(),
      secrets,
      command,
      cwd,
      exitCode: null,
      outcome: "denied",
    });
  }

  private async touch(names: string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const name of names) {
      await this.db.prepare(`UPDATE secrets SET last_used_at = ? WHERE name = ?`).run([now, name]);
    }
  }

  private async audit(entry: AuditEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_log (ts, secrets, command, cwd, exit_code, outcome) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run([entry.ts, entry.secrets.join(","), entry.command, entry.cwd, entry.exitCode, entry.outcome]);
  }

  /**
   * Export all secrets including values. For local maintenance only (e.g. key
   * rotation) — never wired to the CLI's read paths or the MCP server.
   */
  async exportSecrets(): Promise<
    Array<{ name: string; value: string; tags: string[] }>
  > {
    const rows = (await this.db.prepare(`SELECT name, value, tags FROM secrets`).all()) as Array<{
      name: string;
      value: string;
      tags: string;
    }>;
    return rows.map((r) => ({ name: r.name, value: r.value, tags: r.tags ? r.tags.split(",") : [] }));
  }

  /** Most recent audit entries, newest first. */
  async recentAudit(limit = 20): Promise<AuditEntry[]> {
    const rows = (await this.db
      .prepare(
        `SELECT ts, secrets, command, cwd, exit_code, outcome FROM audit_log ORDER BY id DESC LIMIT ?`,
      )
      .all([limit])) as Array<{
      ts: string;
      secrets: string;
      command: string;
      cwd: string;
      exit_code: number | null;
      outcome: string | null;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      secrets: r.secrets ? r.secrets.split(",") : [],
      command: r.command,
      cwd: r.cwd,
      exitCode: r.exit_code,
      outcome: r.outcome === "denied" ? "denied" : "ran",
    }));
  }
}
