#!/usr/bin/env bash
# Cross-seed differential oracle + a check that the crash fix is load-bearing.
set -u
cd "$(dirname "$0")/.." || exit 1

BAK=$(mktemp -d)
cp src/formatter.js "$BAK"/ || exit 1
trap 'cp "$BAK"/formatter.js src/formatter.js; rm -rf "$BAK"' EXIT

echo "== oracle across independent seeds (fixed code) =="
bad=0
for s in 1592594996 3812015800 2654435761 1140071481 1736733999; do
  out=$(node scripts/oracle-proto-keys.js "$s" 8000 2>&1)
  n=$(printf '%s\n' "$out" | grep -E '^mismatches' | grep -oE '[0-9]+')
  c=$(printf '%s\n' "$out" | grep -E '^documents checked' | grep -oE '[0-9]+')
  printf '  seed %-12s documents=%-6s mismatches=%s\n' "$s" "${c:-?}" "${n:-CRASH}"
  [ "${n:-1}" = "0" ] || bad=$((bad + 1))
done

echo
echo "== the same seeds against the un-fixed pretty() (must crash or mismatch) =="
cp "$BAK"/formatter.js src/formatter.js
# Restore the raw interpolation that threw on a record whose field has no
# callable toString.
sed -i "s/      const rendered = displayValue(name);/      const rendered = \`\${name}\`;/" src/formatter.js
sed -i "s/      const rendered = displayValue(msg);/      const rendered = \`\${msg}\`;/" src/formatter.js
detected=0
for s in 1592594996 3812015800 2654435761; do
  out=$(node scripts/oracle-proto-keys.js "$s" 8000 2>&1)
  if printf '%s\n' "$out" | grep -q 'TypeError'; then
    printf '  seed %-12s DETECTED (TypeError on the un-fixed formatter)\n' "$s"
    detected=$((detected + 1))
  else
    printf '  seed %-12s missed\n' "$s"
  fi
done

echo
echo "oracle_bad=$bad crash_fix_detected=$detected/3"
[ "$bad" -eq 0 ] && [ "$detected" -eq 3 ]