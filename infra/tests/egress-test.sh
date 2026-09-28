#!/bin/sh
# Runs inside a throwaway container on the sandbox network. Exits non-zero on any violation.
set -u
PROXY=http://172.30.0.2:3128
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (expected $2, got $3)"; fail=1; fi
}

# 1. No direct internet.
curl -s -o /dev/null --max-time 5 https://example.com && r=reachable || r=blocked
check "direct internet is blocked" blocked "$r"

# 2. No direct access to platform services.
curl -s -o /dev/null --max-time 5 http://litellm:4000/health/liveliness && r=reachable || r=blocked
check "direct LiteLLM is blocked" blocked "$r"

# 3. Through the proxy, a non-allowlisted domain is refused.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x "$PROXY" http://example.com/)
check "proxy refuses non-allowlisted domain" 403 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x "$PROXY" https://example.com/ 2>/dev/null || echo 403)
[ "$code" = "000" ] && code=403
check "proxy refuses non-allowlisted CONNECT" 403 "$code"

# 4. Through the proxy, LiteLLM is reachable.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x "$PROXY" http://litellm:4000/health/liveliness)
check "proxy allows LiteLLM" 200 "$code"

exit $fail
