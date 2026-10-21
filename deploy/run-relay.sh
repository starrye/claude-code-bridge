#!/bin/sh
# Starts the relay the production way: HTTP only on the loopback (for nginx), tunnels over TLS on their own port.
# Settings come from a KEY=VALUE file (default /etc/agent-bridge/relay.env, or $RELAY_ENV). The file is READ, never
# executed: a value may contain & $ ; and spaces. Write values bare, without quotes.
set -eu

ENV_FILE=${RELAY_ENV:-/etc/agent-bridge/relay.env}
[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE" >&2; exit 1; }

while IFS= read -r line || [ -n "$line" ]; do
  case $line in ''|'#'*) continue ;; esac
  key=${line%%=*}
  value=${line#*=}
  case $key in
    ''|*[!A-Z0-9_]*) echo "bad line in $ENV_FILE (expected NAME=value): $key" >&2; exit 1 ;;
  esac
  export "$key=$value"
done < "$ENV_FILE"

for name in RELAY_STATE FEISHU_REDIRECT_BASE RELAY_TUNNEL_URL RELAY_TLS_CERT RELAY_TLS_KEY; do
  eval "[ -n \"\${$name:-}\" ]" || { echo "$name is not set in $ENV_FILE" >&2; exit 1; }
done
[ -r "$RELAY_TLS_CERT" ] || { echo "cannot read the certificate $RELAY_TLS_CERT" >&2; exit 1; }
[ -r "$RELAY_TLS_KEY" ]  || { echo "cannot read the private key $RELAY_TLS_KEY (the user running the relay needs read access)" >&2; exit 1; }
mkdir -p "$RELAY_STATE"

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec python3 "$here/relay.py" serve \
  --http-listen "${RELAY_HTTP_LISTEN:-127.0.0.1:19011}" \
  --tunnel-listen "${RELAY_TUNNEL_LISTEN:-0.0.0.0:9011}" \
  --tls-cert "$RELAY_TLS_CERT" --tls-key "$RELAY_TLS_KEY"
