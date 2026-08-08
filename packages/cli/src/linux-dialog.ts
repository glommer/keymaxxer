import { spawn } from "node:child_process";

type DialogResult = { code: number | null; stdout: string };

function run(command: string, args: string[], input?: string): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout?.on("data", (c) => (stdout += c.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve({ code, stdout }));
    if (input && proc.stdin) {
      proc.stdin.end(input);
    }
  });
}

function pinentryEscape(s: string): string {
  return s.replace(/%/g, "%25").replace(/\n/g, "%0A").replace(/\r/g, "%0D");
}

function parsePinentryData(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("D ")) return line.slice(2).replace(/%0A/g, "\n").replace(/%0D/g, "\r").replace(/%25/g, "%");
  }
  return null;
}

async function promptPassphrasePinentry(message: string): Promise<string | null> {
  const input = [
    "SETTITLE keymaxxer - unlock vault",
    `SETDESC ${pinentryEscape(message)}`,
    "SETPROMPT Passphrase:",
    "GETPIN",
    "BYE",
    "",
  ].join("\n");
  const res = await run("pinentry", [], input);
  if (!res || res.code !== 0) return null;
  return parsePinentryData(res.stdout);
}

async function confirmPinentry(message: string): Promise<boolean | null> {
  const input = [
    "SETTITLE keymaxxer - approve secret use",
    `SETDESC ${pinentryEscape(message)}`,
    "SETOK Allow once",
    "SETCANCEL Deny",
    "CONFIRM",
    "BYE",
    "",
  ].join("\n");
  const res = await run("pinentry", [], input);
  if (!res) return null;
  return res.code === 0;
}

export async function promptPassphraseLinux(message: string): Promise<string | null> {
  if (process.platform !== "linux") return null;

  const zenity = await run("zenity", ["--password", "--title", "keymaxxer - unlock vault"]);
  if (zenity && zenity.code === 0) return zenity.stdout.replace(/\n$/, "");

  return promptPassphrasePinentry(message);
}

export async function promptTextLinux(message: string, prefill: string, saveLabel: string): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const res = await run("zenity", [
    "--entry",
    "--title",
    "keymaxxer - add secret",
    "--text",
    message,
    "--entry-text",
    prefill,
    "--ok-label",
    saveLabel,
    "--cancel-label",
    "Cancel",
  ]);
  if (!res || res.code !== 0) return null;
  return res.stdout.replace(/\n$/, "");
}

export async function confirmSaveLinux(message: string): Promise<"save" | "edit" | null> {
  if (process.platform !== "linux") return null;
  const res = await run("zenity", [
    "--question",
    "--title",
    "keymaxxer - add secret",
    "--text",
    message,
    "--ok-label",
    "Save",
    "--cancel-label",
    "Edit",
  ]);
  if (!res) return null;
  return res.code === 0 ? "save" : "edit";
}

export async function approveLinux(message: string): Promise<"deny" | "once" | "session" | null> {
  if (process.platform !== "linux") return null;
  const zenity = await run("zenity", [
    "--list",
    "--radiolist",
    "--title",
    "keymaxxer - approve secret use",
    "--text",
    message,
    "--column",
    "",
    "--column",
    "Decision",
    "FALSE",
    "Deny",
    "TRUE",
    "Allow once",
    "FALSE",
    "Allow session",
  ]);
  if (zenity && zenity.code === 0) {
    const choice = zenity.stdout.trim();
    if (choice === "Allow session") return "session";
    if (choice === "Allow once") return "once";
    return "deny";
  }

  const allowed = await confirmPinentry(message);
  if (allowed === null) return null;
  return allowed ? "once" : "deny";
}
