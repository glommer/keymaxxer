#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_CIPHER,
  SecretStore,
  deriveKey,
  generateSalt,
  loadMeta,
  newExternalKeyMeta,
  newPassphraseMeta,
  saveMeta,
  type SecretFields,
} from "keymaxxer-sdk";
import { openVaultCli, runGated } from "./client.js";
import { manualSnippet, wireMcpJson } from "./init.js";
import { serve } from "./mcp.js";
import { vaultPath } from "./paths.js";
import { readHiddenLine, readNewPassphrase } from "./prompt.js";

const HELP = `keymaxxer — a secret manager for coding agents

Setup:
  keymaxxer init             Create the encrypted vault (prompts for a passphrase)

Secrets:
  keymaxxer set <NAME> [attrs]   Store a secret; prompts to paste the value (hidden),
                             or pipe it in. attrs: --provider --account --env --access --tag --description
  keymaxxer import <file>        Import KEY=VALUE lines from a .env-style file
  keymaxxer list                 List secret names + metadata (never values)
  keymaxxer rm <NAME>            Delete a secret
  keymaxxer run --secrets a,b -- <cmd>   Run a command with secrets injected as env vars
  keymaxxer audit [--limit N]    Show recent secret-access log
  keymaxxer compact              Checkpoint and truncate accumulated vault WAL data

Agent integration:
  keymaxxer serve                Start the MCP server on stdio (holds the key for the session)

The key is derived from your passphrase and never stored. Each command unlocks on
demand; set KEYMAXXER_PASSPHRASE (or KEYMAXXER_MASTER_KEY, 64-hex) for non-interactive use.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (afterDashDash) rest.push(a);
    else if (a === "--") afterDashDash = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positionals.push(a);
  }
  return { positionals, flags, rest };
}

function die(msg: string): never {
  console.error(`keymaxxer: ${msg}`);
  process.exit(1);
}

/** Build the structured secret attributes from CLI flags. */
function fieldsFromFlags(flags: Record<string, string | boolean>): SecretFields {
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof flags[k] === "string") return flags[k] as string;
    return undefined;
  };
  const fields: SecretFields = {};
  const tag = str("tag", "tags");
  if (tag) fields.tags = tag.split(",");
  const provider = str("provider");
  if (provider) fields.provider = provider;
  const account = str("account");
  if (account) fields.account = account;
  const environment = str("env", "environment");
  if (environment) fields.environment = environment;
  const access = str("access");
  if (access) fields.access = access;
  const description = str("description", "desc");
  if (description) fields.description = description;
  return fields;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { positionals, flags, rest } = parseArgs(argv);

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;

    case "init": {
      if (loadMeta(vaultPath()) && existsSync(vaultPath())) {
        die("a vault already exists at " + vaultPath());
      }
      const envKey = process.env.KEYMAXXER_MASTER_KEY;
      if (envKey) {
        const store = await SecretStore.open({ path: vaultPath(), hexkey: envKey.toLowerCase() });
        await store.close();
        saveMeta(vaultPath(), newExternalKeyMeta(DEFAULT_CIPHER));
        console.log(`✓ Vault created at ${vaultPath()} using KEYMAXXER_MASTER_KEY (AES-256-GCM).`);
      } else {
        const passphrase = await readNewPassphrase();
        const salt = generateSalt();
        const store = await SecretStore.open({ path: vaultPath(), hexkey: deriveKey(passphrase, salt) });
        await store.close();
        saveMeta(vaultPath(), newPassphraseMeta(DEFAULT_CIPHER, salt));
        console.log(`✓ Vault created at ${vaultPath()} (key derived from your passphrase, AES-256-GCM).`);
      }
      console.log(wireMcpJson(process.cwd()));
      console.log("\nFor editors not auto-configured, add this MCP server:");
      console.log(manualSnippet());
      return;
    }

    case "set": {
      const name =
        positionals[0] ??
        die("usage: keymaxxer set <NAME> [--provider p] [--account a] [--env e] [--access a] [--tag t] [--description d]");
      const value = process.stdin.isTTY
        ? await readHiddenLine(`Value for ${name} (paste — input is hidden): `)
        : await readStdin();
      if (!value) die("no value provided.");
      const store = await openVaultCli();
      await store.set(name, value, fieldsFromFlags(flags));
      await store.close();
      console.log(`✓ Stored '${name}'.`);
      return;
    }

    case "import": {
      const file = positionals[0] ?? die("usage: keymaxxer import <file>");
      if (!existsSync(file)) die(`file not found: ${file}`);
      const text = readFileSync(file, "utf8");
      const store = await openVaultCli();
      let count = 0;
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        await store.set(key, val, {});
        count++;
      }
      await store.close();
      console.log(`✓ Imported ${count} secret(s) from ${file}.`);
      return;
    }

    case "list": {
      const store = await openVaultCli();
      const metas = await store.list();
      await store.close();
      if (metas.length === 0) {
        console.log("No secrets yet. Add one: keymaxxer set NAME");
        return;
      }
      for (const m of metas) {
        const used = m.lastUsedAt ? `last used ${m.lastUsedAt}` : "never used";
        const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const attrs = [m.provider, m.account, m.environment, m.access].filter(Boolean).join(" · ");
        const head = `${m.name}${tags}`;
        console.log(attrs ? `${head}  (${attrs})  —  ${used}` : `${head}  —  ${used}`);
        if (m.description) console.log(`    ${m.description}`);
      }
      return;
    }

    case "rm": {
      const name = positionals[0] ?? die("usage: keymaxxer rm <NAME>");
      const store = await openVaultCli();
      const removed = await store.remove(name);
      await store.close();
      console.log(removed ? `✓ Removed '${name}'.` : `'${name}' not found.`);
      return;
    }

    case "run": {
      const command = rest.join(" ");
      if (!command) die("usage: keymaxxer run --secrets a,b -- <command...>");
      const secrets =
        typeof flags.secrets === "string" && flags.secrets.length ? flags.secrets.split(",") : [];
      const timeoutMs = typeof flags.timeout === "string" ? Number(flags.timeout) : undefined;
      const store = await openVaultCli();
      let res;
      try {
        res = await runGated(store, { command, secrets, timeoutMs }, new Set());
      } finally {
        await store.close();
      }
      if (res.stdout) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : res.stdout + "\n");
      if (res.stderr) process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : res.stderr + "\n");
      if (res.redactions > 0) console.error(`[keymaxxer] redacted ${res.redactions} secret occurrence(s)`);
      process.exit(res.exitCode ?? 1);
    }

    case "audit": {
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
      const store = await openVaultCli();
      const entries = await store.recentAudit(limit);
      await store.close();
      if (entries.length === 0) {
        console.log("No audit entries yet.");
        return;
      }
      for (const e of entries) {
        const status = e.outcome === "denied" ? "DENIED" : `exit=${e.exitCode}`;
        console.log(`${e.ts}  ${status}  [${e.secrets.join(", ")}]  ${e.command}`);
      }
      return;
    }

    case "compact": {
      const store = await openVaultCli();
      try {
        await store.compact();
      } finally {
        await store.close();
      }
      console.log("✓ Vault WAL compacted.");
      return;
    }

    case "serve":
    case "mcp":
      await serve();
      return;

    default:
      die(`unknown command '${cmd}'. Run \`keymaxxer help\`.`);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
