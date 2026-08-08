import { zenityEscapeText } from "./src/linux-dialog.js";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

check(
  "preserves secret-name underscores in Zenity labels",
  zenityEscapeText("Value for GITHUB_TOKEN_PROCESSFOCUS_MONOREPO") ===
    "Value for GITHUB__TOKEN__PROCESSFOCUS__MONOREPO",
);
check("leaves ordinary text unchanged", zenityEscapeText("Value for TOKEN") === "Value for TOKEN");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
