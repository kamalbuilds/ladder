#!/usr/bin/env bash
# End-to-end test against the LIVE deployment, driven through a real browser.
#
# Usage:  ./test/e2e.sh [base_url] [browser_profile]
#
# Requires the `bhn` browser harness. Every assertion is against what the page
# actually rendered, not against an API response, because the thing being tested
# is that a judge opening the URL sees a working product.
#
# Exits non-zero on the first failed assertion.

set -uo pipefail

BASE="${1:-https://focused-mink-234.convex.site}"
PROFILE="${2:-deepsurge}"
EMAIL="e2e+$(date +%s)@ladder.test"

PASS=0
FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

page_text() {
  local out
  for _ in 1 2 3; do
    out="$(timeout 90 bhn "$PROFILE" text 2>/dev/null)"
    # bhn returns a JSON envelope; an empty or missing text field means the page
    # was mid-navigation, so retry rather than assert against nothing.
    if [ ${#out} -gt 120 ]; then printf '%s' "$out"; return 0; fi
    sleep 3
  done
  printf '%s' "$out"
}

assert_contains() {
  local needle="$1" label="$2" hay
  hay="$(page_text)"
  if printf '%s' "$hay" | grep -qiF -- "$needle"; then ok "$label"; else
    bad "$label (missing: $needle)"
  fi
}

assert_absent() {
  local needle="$1" label="$2" hay
  hay="$(page_text)"
  if printf '%s' "$hay" | grep -qiF -- "$needle"; then
    bad "$label (unexpectedly present: $needle)"
  else ok "$label"; fi
}

click_text() {
  timeout 90 bhn "$PROFILE" eval \
    "(()=>{const t=[...document.querySelectorAll('button')].find(b=>/$1/i.test(b.textContent));if(!t)return 'NOTFOUND';t.click();return 'OK'})()" \
    2>/dev/null
}

say "Ladder E2E against $BASE"

# ---------------------------------------------------------------- 1. it loads
say "1. The site loads and serves real assets"
code=$(curl -s -o /tmp/e2e.html -w '%{http_code}' "$BASE/")
[ "$code" = "200" ] && ok "GET / is 200" || bad "GET / returned $code"
grep -q '<div id="root">' /tmp/e2e.html && ok "root element present" || bad "no root element"

js=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' /tmp/e2e.html | head -1)
jstype=$(curl -s -o /dev/null -w '%{content_type}' "$BASE$js")
case "$jstype" in
  application/javascript*) ok "JS served as $jstype" ;;
  *) bad "JS served as $jstype" ;;
esac

spa=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/some/deep/link")
[ "$spa" = "200" ] && ok "SPA fallback serves deep links" || bad "SPA fallback returned $spa"

# The webhook must reject an unsigned POST. A 404 means the route is gone; a 200
# would mean signature verification is off.
wh=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agentmail/webhook" \
      -H 'Content-Type: application/json' -d '{"spoofed":true}')
[ "$wh" = "401" ] && ok "inbound webhook rejects unsigned POST (401)" \
                  || bad "webhook returned $wh, expected 401"

# --------------------------------------------- 2. authorization, from the API
# These are the assertions that matter most: this product holds people's disputes.
# Identity is taken from a session, never from an argument, so a forged or absent
# token must be refused and a stranger must not be able to read a case.
say "2. Authorization refuses what it should"

CONVEX="./node_modules/.bin/convex"
# Capture into a variable before matching. Piping straight into `grep -q` makes
# grep exit on the first match, which closes the pipe and sends SIGPIPE to the
# convex CLI; with pipefail set that surfaced as "Abort trap: 6" and made the
# assertion fail for a reason that had nothing to do with the product.
run() { timeout 90 "$CONVEX" run "$1" "$2" 2>&1 || true; }

expect_in() {   # expect_in <needle> <label> <text>
  if printf '%s' "$3" | grep -qF -- "$1"; then ok "$2"; else bad "$2"; fi
}

OUT="$(run cases:list '{"token":"forged-token-does-not-exist"}')"
expect_in "Not signed in" "a forged session token is refused" "$OUT"

OWNER=$(run auth:issueTestSession "{\"email\":\"$EMAIL\"}" | tr -d '"' | tail -1)
STRANGER=$(run auth:issueTestSession '{"email":"nosy@stranger.test"}' | tr -d '"' | tail -1)
[ ${#OWNER} -gt 10 ] && ok "a real session token was issued" || bad "no session token issued"

CASE_ID=$(run cases:create "{\"token\":\"$OWNER\",\"title\":\"E2E authz probe\",\"counterparty\":\"Foxtons\",\"counterpartyUrl\":\"https://www.foxtons.co.uk/help/complaints/tenancy\",\"summary\":\"Authorization probe case.\"}" | tr -d '"' | tail -1)
[ ${#CASE_ID} -gt 10 ] && ok "owner can create a case" || bad "case creation failed"

OUT="$(run cases:board "{\"token\":\"$STRANGER\",\"caseId\":\"$CASE_ID\"}")"
expect_in "do not have access" "a stranger cannot read someone else's case" "$OUT"

OUT="$(run cases:evidencePack "{\"token\":\"$STRANGER\",\"caseId\":\"$CASE_ID\"}")"
expect_in "do not have access" "a stranger cannot pull the evidence pack" "$OUT"

run cases:share "{\"token\":\"$OWNER\",\"caseId\":\"$CASE_ID\",\"email\":\"nosy@stranger.test\"}" >/dev/null
OUT="$(run cases:board "{\"token\":\"$STRANGER\",\"caseId\":\"$CASE_ID\"}")"
expect_in "collaborator" "an invited collaborator can read the case" "$OUT"

OUT="$(run cases:share "{\"token\":\"$STRANGER\",\"caseId\":\"$CASE_ID\",\"email\":\"third@party.test\"}")"
expect_in "Only the case owner" "a collaborator cannot invite further people" "$OUT"

# ------------------------------------------------------------ 3. sign-in gate
say "3. The gate asks for a code, and the app opens with a session"
timeout 180 bhn "$PROFILE" open "$BASE" >/dev/null 2>&1
timeout 90 bhn "$PROFILE" eval "localStorage.clear(); location.reload(); 'ok'" >/dev/null 2>&1
sleep 9
assert_contains "It is the calendar" "gate copy renders"
assert_contains "EMAIL ME A CODE" "gate asks to email a code rather than trusting typed identity"

# Sign in with the issued session rather than reading a mailbox.
timeout 90 bhn "$PROFILE" eval \
  "(()=>{localStorage.setItem('ladder.token','$OWNER');location.reload();return 'ok'})()" >/dev/null 2>&1
sleep 10
assert_contains "WHO HAS GONE QUIET ON YOU" "case form appears once signed in"
assert_contains "not a law firm" "legal disclaimer is visible in the product"
assert_contains "Signed in as" "the signed-in identity is shown"

# --------------------------------------------------------- 4. create a case
say "4. Creating a case builds a sourced ladder"
timeout 90 bhn "$PROFILE" eval \
  "(()=>{const set=(el,v)=>{const p=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement:window.HTMLInputElement;Object.getOwnPropertyDescriptor(p.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
  const f=document.querySelector('form.new');const ins=f.querySelectorAll('input');
  set(ins[0],'E2E: repair ignored for six weeks');
  set(ins[1],'Foxtons');
  set(ins[2],'https://www.foxtons.co.uk/help/complaints/tenancy');
  set(f.querySelector('textarea'),'Reported a repair six weeks ago with photos. No inspection arranged and no meaningful reply since.');
  return 'ok'})()" >/dev/null 2>&1
click_text "MAP THE LADDER" >/dev/null

# The crawl plus two searches plus a model call. Poll rather than guess.
say "   waiting for the crawl and the model (up to 150s)"
for i in $(seq 1 30); do
  sleep 5
  if page_text | grep -qi "ombudsman\|Property Ombudsman\|Customer Relations"; then break; fi
done

assert_contains "WHAT LADDER READ, AND WHERE" "evidence section rendered"
assert_contains "https://" "at least one source URL is shown"
assert_contains "THIS CASE'S INBOX" "a real case inbox was provisioned"

# Anti-hallucination: every source link shown must be a real http(s) URL.
badlinks=$(timeout 90 bhn "$PROFILE" eval \
  "(()=>{const a=[...document.querySelectorAll('a.src')];return a.filter(x=>!/^https?:\/\//.test(x.getAttribute('href')||'')).length})()" 2>/dev/null | grep -oE '[0-9]+' | head -1)
[ "${badlinks:-0}" = "0" ] && ok "every source link is a real http(s) URL" \
                           || bad "$badlinks source links are not real URLs"

# ------------------------------------------------------ 5. the evidence pack
say "5. Evidence pack builds from the case"
click_text "EVIDENCE PACK" >/dev/null
sleep 3
assert_contains "Complaint record" "evidence pack renders a complaint record"
assert_contains "Escalation steps" "evidence pack lists the escalation steps"
assert_contains "not a law firm" "evidence pack carries the disclaimer"
click_text "HIDE EVIDENCE PACK" >/dev/null
sleep 1

# ---------------------------------------------------- 6. source re-reading
say "6. Re-reading the watched sources"
assert_contains "WHO ELSE CAN SEE THIS" "sharing panel is present"
assert_contains "PAGES LADDER IS WATCHING" "watch list is present"
click_text "RE-READ THE SOURCES" >/dev/null
sleep 12
assert_absent "Could not" "re-read did not error"

# ------------------------------------------------ 7. clock expiry escalates
say "7. Clock expiry drafts and sends an escalation"
before=$(timeout 90 bhn "$PROFILE" eval \
  "(()=>document.body.innerText.split('OUT').length-1)()" 2>/dev/null | grep -oE '[0-9]+' | head -1)
click_text "WIND THE CLOCK PAST ITS DEADLINE" >/dev/null
say "   waiting for sweep, draft and send (up to 120s)"
for i in $(seq 1 24); do
  sleep 5
  after=$(timeout 90 bhn "$PROFILE" eval \
    "(()=>document.body.innerText.split('OUT').length-1)()" 2>/dev/null | grep -oE '[0-9]+' | head -1)
  if [ "${after:-0}" -gt "${before:-0}" ]; then break; fi
done
if [ "${after:-0}" -gt "${before:-0}" ]; then
  ok "an outbound escalation appeared on the board"
else
  bad "no outbound escalation appeared (before=${before:-?} after=${after:-?})"
fi
assert_contains "OVERDUE" "the expired rung is marked overdue"

# ------------------------------------------------------- 8. no page errors
say "8. The page is free of runtime errors"
errs=$(timeout 90 bhn "$PROFILE" state compact 2>/dev/null \
        | grep -oE '"exceptions":[0-9]+' | grep -oE '[0-9]+' | head -1)
[ "${errs:-0}" = "0" ] && ok "zero uncaught exceptions" || bad "$errs uncaught exceptions"

netf=$(timeout 90 bhn "$PROFILE" state compact 2>/dev/null \
        | grep -oE '"network_failures":[0-9]+' | grep -oE '[0-9]+' | head -1)
[ "${netf:-0}" = "0" ] && ok "zero network failures" || bad "$netf network failures"

say "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
