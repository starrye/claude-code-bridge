#!/bin/sh
# Checks a deployed relay from the OUTSIDE (run it from your own computer, not on the server).
#   sh deploy/verify.sh relay.example.com [https-port] [tunnel-port] [relay-local-port]
# Prints PASS / FAIL per check and exits non-zero if anything failed.
set -u
HOST=${1:?usage: verify.sh HOST [https-port] [tunnel-port] [relay-local-port]}
WEB=${2:-9010}
TUNNEL=${3:-9011}
LOCAL=${4:-19011}
CA=${VERIFY_CA_FILE:-}
fails=0

say() { printf '%-5s %s\n' "$1" "$2"; [ "$1" = FAIL ] && fails=$((fails + 1)); return 0; }
curl_web() { curl -sS -m 10 ${CA:+--cacert "$CA"} "$@"; }
code() { curl_web -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }

[ "$(code "https://$HOST:$WEB/healthz")" = 200 ] && say PASS "https://$HOST:$WEB/healthz answers 200 with a valid certificate" \
  || say FAIL "https://$HOST:$WEB/healthz did not answer 200 (certificate not trusted, nginx not up, or port closed)"

config=$(curl_web "https://$HOST:$WEB/auth/config" 2>/dev/null || true)
case $config in
  *'"tunnel": "tls://'*) say PASS "/auth/config tells clients the tunnel address: $(printf '%s' "$config" | sed -n 's/.*"tunnel": "\([^"]*\)".*/\1/p')" ;;
  *) say FAIL "/auth/config does not contain a tls:// tunnel address (RELAY_TUNNEL_URL missing?) -> $config" ;;
esac

for path in /internal/approval /history /admin /.env; do
  [ "$(code "https://$HOST:$WEB$path")" = 404 ] && say PASS "$path is 404" || say FAIL "$path is not 404 (the nginx allowlist is not in effect)"
done
[ "$(code -X POST "https://$HOST:$WEB/sessions" )" = 403 ] && say PASS "POST /sessions is refused (403)" || say FAIL "POST /sessions was not refused"
[ "$(code "https://$HOST:$WEB/sessions")" = 401 ] && say PASS "GET /sessions without a token is 401" || say FAIL "GET /sessions without a token is not 401"
[ "$(code "https://$HOST:$WEB/updates/latest.json")" = 200 ] && say PASS "/updates/latest.json is published" || say WARN "/updates/latest.json is not published yet (fine until the first plugin release)"

plain=$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "http://$HOST:$WEB/healthz" 2>/dev/null || true)
[ "$plain" = 400 ] || [ "$plain" = 000 ] && say PASS "plain http on the https port is refused ($plain)" || say FAIL "plain http on port $WEB answered $plain"

# curl exit status: 7 = connection refused, 28 = timed out, 6 = no such host. Anything else means a TCP connection was made.
connects() { curl -s -m 6 -o /dev/null "$1" 2>/dev/null; rc=$?; case $rc in 6|7|28) return 1 ;; *) return 0 ;; esac; }

if connects "http://$HOST:$LOCAL/"; then
  say FAIL "port $LOCAL (the relay's local HTTP) is reachable from outside: close it in the firewall / security group"
else
  say PASS "port $LOCAL is not reachable from outside"
fi

if ! connects "http://$HOST:$TUNNEL/"; then
  say FAIL "the tunnel port $TUNNEL cannot be reached (security group closed, or the relay is not running)"
else
  http_on_tunnel=$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "http://$HOST:$TUNNEL/healthz" 2>/dev/null || true)
  [ "$http_on_tunnel" = 000 ] && say PASS "the tunnel port $TUNNEL is open and never answers http" || say FAIL "the tunnel port $TUNNEL answered http ($http_on_tunnel)"
fi

if command -v openssl >/dev/null 2>&1; then
  info=$(echo | openssl s_client -connect "$HOST:$TUNNEL" -servername "$HOST" -verify_hostname "$HOST" ${CA:+-CAfile "$CA"} 2>&1)
  case $info in
    *'Verification: OK'*|*'Verify return code: 0 (ok)'*) say PASS "the tunnel port presents a certificate that verifies for $HOST" ;;
    *) say FAIL "the tunnel certificate does not verify for $HOST (missing intermediates? use the full chain) -> $(printf '%s' "$info" | grep -m1 'Verify return code')" ;;
  esac
  for v in tls1 tls1_1; do
    if echo | openssl s_client -connect "$HOST:$WEB" -servername "$HOST" "-$v" 2>&1 | grep -q 'BEGIN CERTIFICATE\|Protocol *: TLSv1\.[01]$'; then
      say FAIL "$v is accepted on port $WEB"
    else
      say PASS "$v is refused on port $WEB"
    fi
  done
  echo | openssl s_client -connect "$HOST:$WEB" -servername "$HOST" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/^/INFO  certificate /'
else
  say WARN "openssl is not installed here: the tunnel certificate and TLS version checks were skipped"
fi

echo
[ "$fails" -eq 0 ] && echo "all checks passed" || echo "$fails check(s) FAILED"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
