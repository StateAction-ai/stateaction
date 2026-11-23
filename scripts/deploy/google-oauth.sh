#!/usr/bin/env bash
# Operator steps after the Google OAuth web client exists (SA-80). No secret is printed or passed in argv.
#   1. Create the client: redirect URI https://stateaction-web.onrender.com/api/auth/callback/google
#      and store GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=... in ~/.config/stateaction/google-oauth.env (0600).
#   2. scripts/deploy/google-oauth.sh apply          # sets both on the web service and redeploys it
#   3. Sign in once with Google in the browser (shows "Access pending").
#   4. scripts/deploy/google-oauth.sh grant-staff you@example.com   # enables the staff role, then sign in again
set -euo pipefail
cd "$(dirname "$0")/../.."
file="${GOOGLE_OAUTH_ENV_FILE:-$HOME/.config/stateaction/google-oauth.env}"
set -a; . "${RENDER_ENV_FILE:-$HOME/.config/stateaction/render.env}"; set +a
engine=scripts/platform/render-deploy.mjs
case "${1:?usage: google-oauth.sh apply | grant-staff <email>}" in
  apply)
    [[ "$(stat -c %a "$file")" == 600 ]] || { echo "$file must be mode 0600" >&2; exit 2; }
    exec node "$engine" apply-google --environment production --env-file "$file" ;;
  grant-staff)
    exec node "$engine" grant-staff --environment production --email "${2:?email required}" ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
