#!/usr/bin/env bash
# Full release/deploy gate for mark-it-down (AGENTS.md "Before completion").
#
# Runs every required check in order and prints an honest PASS/FAIL/SKIP
# summary. Exits non-zero if any required step FAILS or could not be run, so it
# is safe to gate a merge/deploy on `scripts/deploy-gate.sh`.
#
# Steps (AGENTS.md:28-34), plus the frontend typecheck/lint the review folds in:
#   1. frontend typecheck   2. frontend lint      3. frontend tests
#   4. backend tests        5. build container    6. DOCX smoke
#   7. PPTX smoke           8. PDF smoke
#
# Usage:  bash scripts/deploy-gate.sh
# Env:    SKIP_CONTAINER=1 to skip the Docker build deliberately (still reported
#         as SKIP, which counts as gate-incomplete, never as PASS).
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$REPO/frontend"
PY="$REPO/converter/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$REPO/converter/.venv/bin/python"

declare -a NAMES STATUSES
overall_fail=0
incomplete=0

record() { NAMES+=("$1"); STATUSES+=("$2"); }

step() {
  # step "<name>" <cmd...>
  local name="$1"; shift
  echo ""
  echo "################################################################"
  echo "# GATE STEP: $name"
  echo "################################################################"
  if "$@"; then
    echo "-- $name: PASS"
    record "$name" "PASS"
  else
    echo "-- $name: FAIL (exit $?)"
    record "$name" "FAIL"
    overall_fail=1
  fi
}

fe()  { ( cd "$FRONTEND" && "$@" ); }
be()  { ( cd "$REPO/converter" && PYTHONPATH="$REPO/converter" "$PY" "$@" ); }

# 1-3 frontend
step "frontend typecheck" fe npm run typecheck
step "frontend lint"      fe npm run lint
step "frontend tests"     fe npm test

# 4 backend
step "backend tests" bash -c "cd '$REPO' && PYTHONPATH='$REPO/converter' '$PY' -m pytest tests/converter -q"

# 5 container build (honest SKIP when Docker is unavailable — never a fake PASS)
echo ""
echo "################################################################"
echo "# GATE STEP: build container"
echo "################################################################"
if [ "${SKIP_CONTAINER:-0}" = "1" ]; then
  echo "-- build container: SKIP (SKIP_CONTAINER=1 requested)"
  record "build container" "SKIP"; incomplete=1
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "-- build container: SKIP (Docker not available/running in this environment)"
  echo "   Run on a machine with Docker: docker build -f converter/Dockerfile.vercel converter"
  record "build container" "SKIP"; incomplete=1
else
  if docker build -f "$REPO/converter/Dockerfile.vercel" "$REPO/converter"; then
    echo "-- build container: PASS"; record "build container" "PASS"
  else
    echo "-- build container: FAIL"; record "build container" "FAIL"; overall_fail=1
  fi
fi

# 6-8 smoke tests
step "DOCX smoke" be scripts/smoke_docx.py
step "PPTX smoke" be scripts/smoke_pptx.py
step "PDF smoke"  be scripts/smoke_pdf.py

# summary
echo ""
echo "================================================================"
echo "  DEPLOY GATE SUMMARY"
echo "================================================================"
for i in "${!NAMES[@]}"; do
  printf "  %-20s %s\n" "${NAMES[$i]}" "${STATUSES[$i]}"
done
echo "----------------------------------------------------------------"
if [ "$overall_fail" -ne 0 ]; then
  echo "  RESULT: FAIL — at least one required step did not pass."
  exit 1
elif [ "$incomplete" -ne 0 ]; then
  echo "  RESULT: INCOMPLETE — all executed steps passed, but a required"
  echo "          step was skipped (see SKIP above). Not clear to deploy"
  echo "          until it runs where the tool is available."
  exit 2
else
  echo "  RESULT: PASS — all gate steps green."
  exit 0
fi
