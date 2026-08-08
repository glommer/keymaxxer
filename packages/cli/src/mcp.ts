import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SecretStore } from "keymaxxer-sdk";
import { z } from "zod";
import { promptAddSecret } from "./addsecret.js";
import { openVaultServe, runGated } from "./client.js";

/**
 * Start the keymaxxer MCP server on stdio. This process IS the session's
 * keyholder: it unlocks the vault once (on first use, via a native passphrase
 * dialog), holds the key in its own memory, and clears it when the session ends.
 * "Allow for the session" therefore lasts exactly as long as this server, and
 * approvals are never shared with other sessions. Secret values never reach the
 * model — keymaxxer_list returns names only, keymaxxer_run returns scrubbed output.
 */
export async function serve(): Promise<void> {
  let store: SecretStore | null = null;
  const approved = new Set<string>();
  let lastActivity = Date.now();

  // Optional: re-lock (drop the key) after N minutes idle. Off by default — the
  // vault stays unlocked for the whole session.
  const idleMs = Math.max(0, Number(process.env.KEYMAXXER_IDLE_MINUTES) || 0) * 60_000;
  if (idleMs > 0) {
    const timer = setInterval(() => {
      if (store && Date.now() - lastActivity > idleMs) {
        void store.close().catch(() => {});
        store = null;
        approved.clear();
      }
    }, 5_000);
    timer.unref();
  }

  async function vault(): Promise<SecretStore> {
    lastActivity = Date.now();
    if (!store) {
      store = await openVaultServe(
        "An agent wants to use a secret. Enter your keymaxxer passphrase to unlock the vault:",
      );
    }
    return store;
  }

  const server = new McpServer({ name: "keymaxxer", version: "0.2.2" });

  server.registerTool(
    "keymaxxer_list",
    {
      description:
        "List the secrets in the vault with their attributes — name, provider (e.g. github/orb/stripe), account, environment (prod/dev/staging), access level (read-only/read-write/admin), tags, and description. Returns NO secret values. Call this first to discover which secrets exist AND to choose the correct one: match the provider/account the task targets, prefer the right environment, and prefer the least-privileged credential that can do the job (e.g. a read-only key when you're only reading).",
      inputSchema: {},
    },
    async () => {
      try {
        const metas = await (await vault()).list();
        return { content: [{ type: "text", text: JSON.stringify(metas, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: errText(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "keymaxxer_run",
    {
      description:
        "Run a shell command with secrets injected as environment variables. Reference each secret as $NAME (e.g. \"gh api /user\" with GITHUB_TOKEN, or curl -H \"Authorization: Bearer $TOKEN\"). Secret values are injected into the child process only; they are scrubbed from the returned output and never exposed to you. Use keymaxxer_list to find available names. Note: if the vault is locked the human is prompted to unlock it (the call may pause). Read-write or production secrets are gated — the human approves the use and may allow it just once or for the whole session; the call may pause and can be denied. If denied, pick a less-privileged secret or ask the user. Don't tell the user to unlock manually — just make the call and it will prompt them.",
      inputSchema: {
        command: z.string().describe("Shell command to run. Reference secrets as $NAME."),
        secrets: z.array(z.string()).describe("Names of secrets to inject as environment variables."),
        cwd: z.string().optional().describe("Working directory. Defaults to the server's cwd."),
        timeoutMs: z.number().optional().describe("Kill the command after this many milliseconds."),
      },
    },
    async (args) => {
      try {
        const res = await runGated(await vault(), args, approved);
        const lines = [
          `exit_code: ${res.exitCode}`,
          res.redactions > 0 ? `[keymaxxer] redacted ${res.redactions} secret occurrence(s)` : null,
          `--- stdout ---`,
          res.stdout,
          `--- stderr ---`,
          res.stderr,
        ].filter((l) => l !== null);
        return { content: [{ type: "text", text: lines.join("\n") }], isError: res.exitCode !== 0 };
      } catch (err) {
        return { content: [{ type: "text", text: errText(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "keymaxxer_add",
    {
      description:
        "Ask the human to add a new secret to the vault. Suggest the name and any attributes you can infer (provider, account, environment, access, description, tags); the human reviews/edits them in a dialog and types the secret VALUE. The value is saved straight to the encrypted vault and is NEVER returned to you. Use this when a task needs a credential that isn't in keymaxxer_list yet — never ask the user to paste a secret into the chat.",
      inputSchema: {
        name: z.string().describe("Suggested secret name, e.g. GITHUB_TOKEN or ORB_PROD_TOKEN."),
        provider: z.string().optional().describe("e.g. github, orb, stripe"),
        account: z.string().optional().describe("which account/org the credential belongs to"),
        environment: z.string().optional().describe("prod / dev / staging / test"),
        access: z.string().optional().describe("read-only / read-write / admin"),
        description: z.string().optional(),
        tags: z.string().optional().describe("comma-separated"),
      },
    },
    async (args) => {
      try {
        const store = await vault();
        const result = await promptAddSecret(args);
        if (!result) {
          return { content: [{ type: "text", text: "The user cancelled — no secret was added." }] };
        }
        await store.set(result.name, result.value, result.fields);
        return {
          content: [
            {
              type: "text",
              text: `Stored '${result.name}'. The value was entered by the user and is not shown to you — use it with keymaxxer_run as $${result.name}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: errText(err) }], isError: true };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

function errText(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}
