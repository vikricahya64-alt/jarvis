#!/usr/bin/env bash
# Push to origin/main using a token stored in a file, then destroy the file.
#
# The token must never be pasted into a chat, a shell argument, or a commit: a
# shell argument shows up in `ps` for every user on the box, and a chat is a
# permanent, exportable record. Reading it from a 0600 file and shredding the
# file afterwards keeps it out of both.
#
# Usage:
#   1) create a FINE-GRAINED PAT: GitHub -> Settings -> Developer settings ->
#      Personal access tokens -> Fine-grained
#      repository: vikricahya64-alt/jarvis (only this one)
#      permission: Contents -> Read and write
#   2) store it WITHOUT the token appearing in your shell history:
#        read -rs GHTOK && printf '%s' "$GHTOK" > /tmp/gh_pat && unset GHTOK
#        chmod 600 /tmp/gh_pat
#   3) run: bash scripts/secure_push.sh
set -euo pipefail

REPO_DIR="${REPO_DIR:-/tmp/repo}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/gh_pat}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"

if [ ! -f "$TOKEN_FILE" ]; then
  cat >&2 <<EOF
secure_push: no token file at $TOKEN_FILE

See the usage comment at the top of this script. Do NOT pass the token as an
argument - it would be visible in 'ps' and in this command's own history.
EOF
  exit 2
fi

chmod 600 "$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"

cleanup() { shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"; }
trap cleanup EXIT

echo "secure_push: validating token identity + scopes"
SCOPES="$(curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("login") or "INVALID")')"
if [ "$SCOPES" = "INVALID" ] || [ -z "$SCOPES" ]; then
  echo "secure_push: token rejected by GitHub" >&2
  exit 3
fi
echo "secure_push: authenticated as $SCOPES"

HDRS="$(curl -s -o /dev/null -D - -H "Authorization: Bearer $TOKEN" https://api.github.com/user \
  | tr -d '\r' | grep -i '^x-oauth-scopes:' || true)"
if [ -n "$HDRS" ]; then
  # A classic PAT always reports scopes. A fine-grained one reports none.
  if echo "$HDRS" | grep -qE 'delete_repo|admin:org|admin:enterprise'; then
    echo "secure_push: WARNING - this token has repo-deleting / org-admin rights." >&2
    echo "           Revoke it right after this push." >&2
  fi
fi

cd "$REPO_DIR"
BRANCH_SHA="$(git rev-parse "$BRANCH")"
PUSH_SHA="$(git rev-parse HEAD)"
if [ "$BRANCH_SHA" != "$PUSH_SHA" ]; then
  echo "secure_push: pushing HEAD ($(git rev-parse --short HEAD)) -> $REMOTE/$BRANCH"
  # GIT_ASKPASS keeps the token out of argv, out of the remote URL (and so out of
  # .git/config and any error output), and out of the reflog.
  ASKPASS="$(mktemp)"
  trap 'cleanup; rm -f "$ASKPASS"' EXIT
  cat > "$ASKPASS" <<'EOS'
#!/bin/sh
case "$1" in
  *sername*) echo x-access-token ;;
  *) cat "$GH_PAT_FILE" ;;
esac
EOS
  chmod 700 "$ASKPASS"
  GH_PAT_FILE="$TOKEN_FILE" GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 \
    git push "$REMOTE" HEAD:"$BRANCH"
else
  echo "secure_push: $REMOTE/$BRANCH already up to date"
fi

git fetch "$REMOTE" --quiet || true
if [ "$(git rev-parse "$REMOTE/$BRANCH")" = "$(git rev-parse HEAD)" ]; then
  echo "secure_push: OK - $REMOTE/$BRANCH == HEAD ($(git rev-parse --short HEAD))"
else
  echo "secure_push: FAILED - $REMOTE/$BRANCH is not at HEAD" >&2
  exit 4
fi