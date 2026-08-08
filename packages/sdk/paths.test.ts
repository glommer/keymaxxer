import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultVaultDir, defaultVaultPath } from "./src/paths.js";

const tmp = join(import.meta.dir, ".paths-test-tmp");
const home = join(tmp, "home");
const xdg = join(tmp, "xdg");
const override = join(tmp, "override");

const saved = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  KEYMAXXER_DB_DIR: process.env.KEYMAXXER_DB_DIR,
};

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.KEYMAXXER_DB_DIR;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
  if (saved.KEYMAXXER_DB_DIR === undefined) delete process.env.KEYMAXXER_DB_DIR;
  else process.env.KEYMAXXER_DB_DIR = saved.KEYMAXXER_DB_DIR;
});

describe("defaultVaultDir", () => {
  test("defaults to ~/.keymaxxer", () => {
    expect(defaultVaultDir()).toBe(join(home, ".keymaxxer"));
    expect(defaultVaultPath()).toBe(join(home, ".keymaxxer", "vault.db"));
  });

  test("uses XDG_CONFIG_HOME/keymaxxer when that directory exists", () => {
    mkdirSync(join(xdg, "keymaxxer"), { recursive: true });
    process.env.XDG_CONFIG_HOME = xdg;
    expect(defaultVaultDir()).toBe(join(xdg, "keymaxxer"));
  });

  test("falls back to ~/.keymaxxer when XDG path does not exist", () => {
    process.env.XDG_CONFIG_HOME = xdg;
    expect(defaultVaultDir()).toBe(join(home, ".keymaxxer"));
  });

  test("KEYMAXXER_DB_DIR overrides even when XDG dir exists", () => {
    mkdirSync(join(xdg, "keymaxxer"), { recursive: true });
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.KEYMAXXER_DB_DIR = override;
    expect(defaultVaultDir()).toBe(override);
    expect(defaultVaultPath()).toBe(join(override, "vault.db"));
  });

  test("KEYMAXXER_DB_DIR has no existence fallback", () => {
    process.env.KEYMAXXER_DB_DIR = override;
    expect(defaultVaultDir()).toBe(override);
  });
});
