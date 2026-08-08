#!/usr/bin/env bash
#
# End-to-end integration test for keymaxxer (no-daemon model): each command opens
# the encrypted vault on demand. Uses KEYMAXXER_MASTER_KEY / KEYMAXXER_PASSPHRASE
# and KEYMAXXER_APPROVE so it runs fully headless. Exits non-zero on any failure.
#
#   bash test/integration.sh

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)
SH="bun $REPO/packages/cli/src/index.ts"
K=b1bbfda4f589dc9daaf004fe21111e00dc00c98237102f5c7002a5669fc76327

T=$(mktemp -d)
export HOME="$T"

OK=0
KO=0
pass() { echo "  ok   $1"; OK=$((OK + 1)); }
fail() { echo "  FAIL $1"; KO=$((KO + 1)); }
contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 -- got: $(printf '%s' "$2" | tr '\n' ' ' | cut -c1-160)" ;; esac; }
absent()   { case "$2" in *"$3"*) fail "$1 -- unexpectedly contains '$3'" ;; *) pass "$1" ;; esac; }
mode()     { ls -ld "$1" | awk '{print substr($1,1,10)}'; }

cleanup() { rm -rf "$T"; }
trap cleanup EXIT

echo "## vault setup (env key, no daemon)"
contains "init creates the vault" "$(KEYMAXXER_MASTER_KEY=$K $SH init 2>&1)" "Vault created"
contains "vault dir is 0700" "$(mode "$T/.keymaxxer")" "drwx------"

echo "## secrets + metadata"
printf %s 'sk_test_abc'    | KEYMAXXER_MASTER_KEY=$K $SH set RO_KEY  --provider stripe --account acme --env dev  --access read-only  --tag pay >/dev/null
printf %s 'prod_secret_v1' | KEYMAXXER_MASTER_KEY=$K $SH set PROD_RW --provider stripe --account acme --env prod --access read-write          >/dev/null
contains "list shows structured attributes" "$(KEYMAXXER_MASTER_KEY=$K $SH list)" "stripe · acme · dev · read-only"

echo "## injection + scrubbing"
contains "literal value is scrubbed (stdout)" "$(KEYMAXXER_MASTER_KEY=$K $SH run --secrets RO_KEY -- 'echo v=$RO_KEY' 2>/dev/null)" "v=***"
contains "stderr is scrubbed too" "$(KEYMAXXER_MASTER_KEY=$K $SH run --secrets RO_KEY -- 'echo e=$RO_KEY 1>&2' 2>&1 1>/dev/null)" "e=***"
contains "every occurrence is replaced" "$(KEYMAXXER_MASTER_KEY=$K $SH run --secrets RO_KEY -- 'echo $RO_KEY-$RO_KEY-$RO_KEY' 2>/dev/null)" "***-***-***"
absent   "raw value never appears in output" "$(KEYMAXXER_MASTER_KEY=$K $SH run --secrets RO_KEY -- 'echo $RO_KEY 1>&2; echo $RO_KEY' 2>&1)" "sk_test_abc"
absent   "transformed value is NOT scrubbed (documented limitation)" "$(KEYMAXXER_MASTER_KEY=$K $SH run --secrets RO_KEY -- 'printf %s \"$RO_KEY\" | base64' 2>/dev/null)" "***"
if KEYMAXXER_MASTER_KEY=$K $SH run --secrets NOPE -- 'true' >/dev/null 2>&1; then fail "unknown secret should fail closed"; else pass "unknown secret fails closed"; fi

echo "## encryption at rest"
if head -c 16 "$T/.keymaxxer/vault.db" | grep -q "SQLite format 3"; then fail "vault must not be plaintext SQLite"; else pass "vault is encrypted at rest"; fi

echo "## multiprocess_wal (two concurrent opens of the same vault)"
conc=$(cd "$REPO" && HOME="$T" KEYMAXXER_MASTER_KEY=$K bun -e '
  import { SecretStore } from "keymaxxer-sdk";
  const v = process.env.HOME + "/.keymaxxer/vault.db";
  const a = await SecretStore.open({ path: v, hexkey: process.env.KEYMAXXER_MASTER_KEY });
  const b = await SecretStore.open({ path: v, hexkey: process.env.KEYMAXXER_MASTER_KEY });
  process.stdout.write("CONC:" + (await a.list()).length + "/" + (await b.list()).length);
  await a.close(); await b.close();
' 2>&1)
contains "two processes open the vault concurrently" "$conc" "CONC:2/2"

echo "## approval (CLI run)"
contains "read-only/dev runs without approval" "$(KEYMAXXER_MASTER_KEY=$K KEYMAXXER_APPROVE=deny $SH run --secrets RO_KEY -- 'echo ro=$RO_KEY' 2>/dev/null)" "ro=***"
contains "read-write/prod is denied" "$(KEYMAXXER_MASTER_KEY=$K KEYMAXXER_APPROVE=deny $SH run --secrets PROD_RW -- 'echo $PROD_RW' 2>&1)" "was not approved"
contains "denial is recorded in the audit log" "$(KEYMAXXER_MASTER_KEY=$K $SH audit --limit 10)" "DENIED"
contains "sensitive runs once approved" "$(KEYMAXXER_MASTER_KEY=$K KEYMAXXER_APPROVE=allow $SH run --secrets PROD_RW -- 'echo rw=$PROD_RW' 2>/dev/null)" "rw=***"

echo "## passphrase path"
T2=$(mktemp -d)
HOME="$T2" KEYMAXXER_PASSPHRASE=passphrase123 $SH init >/dev/null 2>&1
printf %s 'pval' | HOME="$T2" KEYMAXXER_PASSPHRASE=passphrase123 $SH set PK --env dev --access read-only >/dev/null
contains "passphrase-derived key opens the vault" "$(HOME="$T2" KEYMAXXER_PASSPHRASE=passphrase123 $SH list)" "PK"
contains "wrong passphrase is rejected" "$(HOME="$T2" KEYMAXXER_PASSPHRASE=nope $SH list 2>&1)" "wrong passphrase"
rm -rf "$T2"

echo "## vault path overrides"
T3=$(mktemp -d)
TX=$(mktemp -d)
export HOME="$T3"
unset XDG_CONFIG_HOME KEYMAXXER_DB_DIR
# XDG set but dir missing → still ~/.keymaxxer
contains "XDG missing dir falls back" "$(XDG_CONFIG_HOME="$TX" KEYMAXXER_MASTER_KEY=$K $SH init 2>&1)" "Vault created"
if [ -d "$T3/.keymaxxer" ] && [ ! -d "$TX/keymaxxer" ]; then pass "init used ~/.keymaxxer when XDG dir absent"; else fail "init should use ~/.keymaxxer when XDG dir absent"; fi
rm -rf "$T3/.keymaxxer"
# XDG dir exists → use it
mkdir -p "$TX/keymaxxer"
contains "XDG existing dir is used" "$(XDG_CONFIG_HOME="$TX" KEYMAXXER_MASTER_KEY=$K $SH init 2>&1)" "$TX/keymaxxer/vault.db"
# KEYMAXXER_DB_DIR wins, no fallback
TO=$(mktemp -d)
contains "KEYMAXXER_DB_DIR overrides" "$(KEYMAXXER_DB_DIR="$TO" XDG_CONFIG_HOME="$TX" KEYMAXXER_MASTER_KEY=$K $SH init 2>&1)" "$TO/vault.db"
if [ -f "$TO/vault.db" ]; then pass "KEYMAXXER_DB_DIR vault file exists"; else fail "KEYMAXXER_DB_DIR vault file missing"; fi
rm -rf "$T3" "$TX" "$TO"

echo
if [ "$KO" -eq 0 ]; then
  echo "ALL PASSED ($OK checks)"
  exit 0
else
  echo "$KO FAILED ($OK passed)"
  exit 1
fi
