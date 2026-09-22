# Ladder

**Find who actually regulates them. Watch the clock. Escalate the day it runs out.**

Live: **https://focused-mink-234.convex.site**

When an organisation stops replying to you, the thing that beats you is rarely the
argument. It is the calendar, plus not knowing who above them is obliged to listen.

Ladder takes the name of whoever has gone quiet, crawls their site and the relevant
official pages to work out which regulator or redress scheme actually has jurisdiction,
builds the escalation ladder with the published deadlines attached, gives the case a
real email inbox, and escalates when a window expires.

Ladder is not a law firm and gives no legal advice. It reports what official pages say
and links every one of them.

## What it actually produced, on live runs

A UK letting agent (Foxtons), from their own complaints page:

| Rung | Authority | Clock |
|---|---|---|
| Formal complaint to the lettings branch | Foxtons | 15 days, "aim to resolve the matter within 15 working days" |
| Escalate to Customer Relations | Foxtons | 15 days, "you'll have our final response within 15 working days" |
| Refer to The Property Ombudsman | The Property Ombudsman | 365 days, "within 12 months of our final response" |

with the supporting quote *"The Property Ombudsman is the free, independent service
looking after real estate customers"* linked to the page it came from.

A US airline (American Airlines), which routes somewhere completely different:

| Rung | Authority | Clock |
|---|---|---|
| Formal complaint to Customer Relations | American Airlines | 60 days, "DOT requires airlines to send consumers written responses addressing complaints within 60 days" |
| File a complaint with the Department of Transportation | U.S. Department of Transportation | 30 days |

Nothing in either ladder is hardcoded. Both were crawled at request time.

## Features

- **Jurisdiction mapping.** Crawls the counterparty's own site plus the official pages
  that name the regulator, then builds an ordered ladder with each published window
  attached to the rung it governs.
- **A real inbox per case.** Escalations go out from it; replies come back into it
  through an svix-signed webhook.
- **Reply classification.** The distinction that costs people their rights is a holding
  acknowledgement versus a final response. One feels like progress and changes nothing.
- **Clock sweep.** A cron finds expired windows, drafts the escalation to the next rung
  and sends it.
- **Source watching.** Re-reads the pages each ladder was built from every six hours and
  reports when a deadline, authority or contact route moves. Cosmetic edits are ignored.
- **Evidence pack.** A dated, cited complaint record with the full correspondence and
  Ladder's assessment of each reply, downloadable as markdown.

## Testing

```bash
./test/e2e.sh [base_url] [browser_profile]
```

Drives the live deployment through a real browser. 21 assertions covering asset
delivery, unsigned-webhook rejection, case creation, ladder rendering, the evidence
pack, source re-reading, clock expiry producing an outbound escalation, and zero
runtime errors. Verified non-vacuous by mutating the UI, confirming red, restoring and
confirming green.

## Architecture

See `docs/architecture.html` for the system diagram, the crawl-to-ladder sequence, and
the clock and reply lifecycle.

## Running it

```bash
npm install                 # postinstall applies patches/ (see Known issues)
npx convex dev              # creates the deployment and pushes the backend

npx convex env set OPENROUTER_API_KEY ...
npx convex env set FIRECRAWL_API_KEY  ...
npx convex env set AGENTMAIL_API_KEY  ...
```

Register the AgentMail webhook against your real deployment URL, then store the secret
it returns. Inbound cannot work against a local deployment, because AgentMail's servers
have to reach the URL:

```bash
curl -X POST https://api.agentmail.to/v0/webhooks \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://<deployment>.convex.site/api/agentmail/webhook",
       "event_types":["message.received","message.sent","message.delivered","message.bounced"]}'

npx convex env set AGENTMAIL_WEBHOOK_SECRET <secret from that response>
```

Optionally pin one inbox, which you will want on AgentMail's free plan:

```bash
npx convex env set LADDER_INBOX_ID your-inbox@agentmail.to
```

Deploy the frontend:

```bash
npm run build
npx @convex-dev/static-hosting upload
```

## How it is put together

```
convex/
  convex.config.ts   three components mounted; app routes under /api so static hosting owns /
  schema.ts          cases, rungs, findings, messages, watches
  jurisdiction.ts    Firecrawl scrape + search -> OpenAI -> a sourced ladder
  classify.ts        what kind of reply just arrived, and which clock that starts
  escalate.ts        the clock sweep, the draft, and the send
  email.ts           inbox, inbound webhook handler, outbound, thread capture
  watch.ts           re-reads the pages a ladder relied on, and diffs what matters
  cases.ts           board query, evidence pack, case lifecycle
  crons.ts           clock sweep every 5 minutes, source re-read every 6 hours
  http.ts            AgentMail svix webhook at /api/agentmail/webhook
test/
  e2e.sh             21 browser assertions against the live deployment
```

Stack: Convex (database, queries, mutations, actions, scheduler, crons, live queries,
components), Firecrawl, AgentMail, OpenAI via OpenRouter, React and Vite served from
Convex static hosting.

## Guardrails

**A hallucinated regulator cannot reach the screen.** The mapper keeps the set of URLs
it genuinely fetched, and any rung or finding whose `sourceUrl` is not in that set is
dropped before it is written. Model output is also rebuilt field by field rather than
spread, so an invented key or a missing required field cannot reach the database.

**No invented deadlines.** `clockDays` is set only when a fetched page states a window.
A rung with no stated deadline carries no clock and never auto-escalates.

**No legal-advice claims.** DoNotPay took a $193,000 FTC final order in February 2025
for exactly that.

## Known issues, and the two upstream bugs this repo works around

`patches/@agentmail+convex+0.1.0.patch` is applied on install. It exists because
`@agentmail/convex` 0.1.0 has two problems against Convex 1.46:

1. **The component never declares its env.** Its code reads
   `process.env.AGENTMAIL_API_KEY` inside the component, but `defineComponent("agentmail")`
   is called with no `env` block, so the key never reaches it and every send fails with
   *"AGENTMAIL_API_KEY is not set on this Convex deployment"*. The patch declares it;
   `convex.config.ts` threads it through.
2. **`createInbox` is an `internalAction`.** A component's internal functions are not
   callable from the mounting app, so the shipped client method fails with *"Couldn't
   resolve agentmail.lib.createInbox"*. Ladder calls the AgentMail REST API directly for
   inbox creation instead. Sending and the webhook still go through the component,
   because `enqueueSend` and `handleEvent` are public mutations.

Also worked around: the Firecrawl component throws when a scrape response contains an
object key with a non-ASCII character, since Convex field names must be ASCII. Observed
live on foxtons.co.uk with an en-dash in a page heading. `scrapeMarkdown()` falls back
to Firecrawl's REST API so full page text is still available.

On AgentMail's free plan the inbox cap is 3. If creation is refused, Ladder reuses an
existing inbox and routes inbound mail by thread rather than by inbox.
