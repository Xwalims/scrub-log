#!/usr/bin/env bash
# Prove the new __proto__ regression tests actually detect the old behaviour.
#
# Every scenario restores src/ from a pristine $BAK BEFORE running the suite,
# then re-applies exactly one reverted fix. Never call revert() twice in the
# same scenario: it re-copies $BAK first, so a second call would silently undo
# the first and the harness would be testing the FIXED code while reporting a
# pass.
set -u
cd "$(dirname "$0")/.." || exit 1

BAK=$(mktemp -d)
cp src/formatter.js src/redact.js src/logger.js "$BAK"/ || exit 1
restore() { cp "$BAK"/formatter.js src/formatter.js; cp "$BAK"/redact.js src/redact.js; cp "$BAK"/logger.js src/logger.js; }
trap 'restore; rm -rf "$BAK"' EXIT

pass=0; fail=0
# $1 = label, rest = sed expressions to revert one fix at a time
scenario() {
  local label="$1"; shift
  restore
  for e in "$@"; do
    sed -i "$e" src/formatter.js
    sed -i "$e" src/redact.js
    sed -i "$e" src/logger.js
  done
  local out
  out=$(node --test 2>&1)
  local n
  n=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | grep -oE '[0-9]+')
  if [ "${n:-0}" -gt 0 ]; then
    printf '  DETECTED  %-46s (%s failing)\n' "$label" "$n"
    pass=$((pass + 1))
  else
    printf '  MISSED    %-46s (suite still green!)\n' "$label"
    fail=$((fail + 1))
  fi
}

echo "Reverting each fix individually; every row must fail."

# 1. Full revert of all three modules: assignKey bodies back to plain assignment.
scenario "all four sites reverted" \
  's/if (key === .__proto__.) {/if (false) {/'

# 2. Revert only the formatter writer (orderRecord) -> ndjson/pretty lose it.
restore
sed -i "s/assignKey(ordered, key, rest\[key\]);/ordered[key] = rest[key];/" src/formatter.js
out=$(node --test 2>&1); n=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | grep -oE '[0-9]+')
printf '  %-10s %-46s (%s failing)\n' "$([ "${n:-0}" -gt 0 ] && echo DETECTED || echo MISSED)" "formatter.orderRecord only" "${n:-0}"
[ "${n:-0}" -gt 0 ] && pass=$((pass+1)) || fail=$((fail+1))

# 3. Revert only redact()'s object walk: make assignKey a plain assignment.
restore
sed -i "s/  if (key === '__proto__') {/  if (key === '__never_matches__') {/" src/redact.js
out=$(node --test 2>&1); n=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | grep -oE '[0-9]+')
printf '  %-10s %-46s (%s failing)\n' "$([ "${n:-0}" -gt 0 ] && echo DETECTED || echo MISSED)" "redact object walk only" "${n:-0}"
[ "${n:-0}" -gt 0 ] && pass=$((pass+1)) || fail=$((fail+1))

# 4. Revert only the logger's field copy (Object.assign back).
restore
sed -i 's/for (const key of Object.keys(extra)) {/for (const key of []) {/' src/logger.js
sed -i 's/assignKey(record, key, extra\[key\]);/Object.assign(record, extra);/' src/logger.js
out=$(node --test 2>&1); n=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | grep -oE '[0-9]+')
printf '  %-10s %-46s (%s failing)\n' "$([ "${n:-0}" -gt 0 ] && echo DETECTED || echo MISSED)" "logger Object.assign restore" "${n:-0}"
[ "${n:-0}" -gt 0 ] && pass=$((pass+1)) || fail=$((fail+1))

# 5. Revert the pretty() crash fix: put string interpolation back for every
#    header field. All four must be reverted together, because reverting only
#    one leaves the others as the safety net.
restore
sed -i 's/      const rendered = displayValue(time);/      const rendered = `${time}`;/' src/formatter.js
sed -i 's/      const rendered = displayValue(level);/      const rendered = String(level);/' src/formatter.js
sed -i 's/      parts.push(`\[${displayValue(name)}\]`);/      parts.push(`[${name}]`);/' src/formatter.js
sed -i 's/      const rendered = displayValue(msg);/      const rendered = `${msg}`;/' src/formatter.js
out=$(node --test 2>&1); n=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | grep -oE '[0-9]+')
printf '  %-10s %-46s (%s failing)\n' "$([ "${n:-0}" -gt 0 ] && echo DETECTED || echo MISSED)" "pretty interpolation restored" "${n:-0}"
[ "${n:-0}" -gt 0 ] && pass=$((pass+1)) || fail=$((fail+1))

# 6. Sanity: the FIXED code must be green, otherwise the rows above mean nothing.
restore
out=$(node --test 2>&1); n=$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | grep -oE '[0-9]+')
if [ "${n:-0}" -eq 0 ]; then
  printf '  BASELINE  %-46s (fixed code green)\n' "restored src/"
  pass=$((pass+1))
else
  printf '  BASELINE-FAIL %-44s (%s failing)\n' "restored src/" "${n:-0}"
  fail=$((fail + 1))
fi

echo
echo "detected=$pass missed=$fail"
[ "$fail" -eq 0 ] || exit 1