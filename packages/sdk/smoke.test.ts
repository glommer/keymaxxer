import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "./src/index.js";

const dir = mkdtempSync(join(tmpdir(), "keymaxxer-smoke-"));
const path = join(dir, "vault.db");
const hexkey = "b1bbfda4f589dc9daaf004fe21111e00dc00c98237102f5c7002a5669fc76327";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

try {
  const store = await SecretStore.open({ path, hexkey });

  await store.set("GITHUB_TOKEN", "ghp_supersecretvalue123", {
    tags: ["github"],
    provider: "github",
    account: "acme",
    environment: "prod",
    access: "read-write",
    description: "CI deploy token",
  });
  await store.set("API_KEY", "sk-abcdef0123456789");

  const metas = await store.list();
  check("list returns 2 secrets", metas.length === 2);
  check("list never leaks values", !JSON.stringify(metas).includes("supersecret"));
  const gh = metas.find((m) => m.name === "GITHUB_TOKEN");
  check("tags round-trip", gh?.tags[0] === "github");
  check("provider round-trip", gh?.provider === "github");
  check("environment round-trip", gh?.environment === "prod");
  check("access round-trip", gh?.access === "read-write");
  check("description round-trip", gh?.description === "CI deploy token");

  // Rotating the value preserves metadata (COALESCE on update).
  await store.set("GITHUB_TOKEN", "ghp_rotatedvalue456", {});
  const gh2 = (await store.list()).find((m) => m.name === "GITHUB_TOKEN");
  check("metadata preserved on value rotation", gh2?.environment === "prod" && gh2?.access === "read-write");

  // env injection: command references $NAME, value comes from the vault
  const r1 = await store.run({ command: 'echo "token is $GITHUB_TOKEN"', secrets: ["GITHUB_TOKEN"] });
  check("exit code 0", r1.exitCode === 0);
  check("scrubbed with ***", r1.stdout.includes("***"));
  check("current value absent from stdout", !r1.stdout.includes("ghp_rotatedvalue456"));
  check("redaction counted", r1.redactions >= 1);
  const postRunMetas = await store.list();
  check("metadata remains readable after an audited run", postRunMetas.length === 2);

  // stderr is scrubbed just like stdout
  const r1e = await store.run({ command: 'echo "err: $GITHUB_TOKEN" 1>&2', secrets: ["GITHUB_TOKEN"] });
  check("stderr is scrubbed", r1e.stderr.includes("***") && !r1e.stderr.includes("ghp_rotatedvalue456"));
  // every occurrence is replaced, not just the first
  const r1m = await store.run({ command: 'echo "$GITHUB_TOKEN-$GITHUB_TOKEN"', secrets: ["GITHUB_TOKEN"] });
  check("every occurrence replaced", r1m.stdout.includes("***-***") && r1m.redactions >= 2);

  // unknown secret fails closed
  let threw = false;
  try {
    await store.run({ command: "true", secrets: ["NOPE"] });
  } catch {
    threw = true;
  }
  check("unknown secret fails closed", threw);

  // env var is NOT present when not requested
  const r2 = await store.run({ command: 'echo "[$API_KEY]"', secrets: [] });
  check("unrequested secret absent from env", r2.stdout.includes("[]"));

  // audit recorded
  const audit = await store.recentAudit();
  check("audit recorded the runs", audit.length >= 2);
  check("audit stores command, not value", !JSON.stringify(audit).includes("supersecret"));
  check("runs are recorded as 'ran'", audit.some((e) => e.outcome === "ran"));

  // denied attempts are auditable too
  await store.auditDenied(["GITHUB_TOKEN"], "echo $GITHUB_TOKEN", "/tmp");
  const audit2 = await store.recentAudit();
  check("denied attempt is recorded as 'denied'", audit2.some((e) => e.outcome === "denied"));

  const compacted = await store.compact();
  check("WAL compaction completes while the vault is open", compacted.logPages === 0);
  check("metadata remains readable after WAL compaction", (await store.list()).length === 2);

  // encryption at rest: raw file must not contain plaintext or SQLite header
  const raw = await Bun.file(path).arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(raw).slice(0, 16));
  check("file is not a plaintext SQLite db", !head.startsWith("SQLite format 3"));
  const bytes = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(raw));
  check("secret value not found in raw file bytes", !bytes.includes("ghp_supersecretvalue123"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
