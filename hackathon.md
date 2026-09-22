# Ladder

**Find who actually regulates them. Watch the clock. Escalate the day it runs out.**

- **Live URL:** https://focused-mink-234.convex.site
- **Repo:** https://github.com/kamalbuilds/ladder
- **Demo video:** _pending_
- Built for the Convex All Gas Hackathon, sponsored by OpenAI, Firecrawl and AgentMail.

Ladder is not a law firm and gives no legal advice. It reports what official pages say
and links every one. That line is in the product interface, not only here.

---

## The problem

When an organisation stops replying to you, the thing that beats you is rarely the
argument. It is the calendar, plus not knowing who above them is obliged to listen.

Before writing any code we ran four parallel research lanes looking for people
describing this in their own words. They converged on the same two failures.

**Nobody knows who has jurisdiction.**

> "there must be a higher authority that supervises the work (or lack thereof) of
> councils. Help?"
> — r/london, 2024-04-29

> "Yes, i **think** its The Property Ombudsman"
> — a renter about to file with a scheme they have guessed at, r/TenantsInTheUK, 2024-12-17

> "I didn't know/realise they would be subject to Ombudsman oversight"
> — r/HousingUK, 2024-10-02

The sharpest case: an American Airlines passenger had £520 compensation **confirmed in
writing**, sent their bank details as instructed, then got three months of silence
across three attempts. The fix, supplied by a stranger in the thread, was that the
published customer-relations address is not the desk that pays. A confirmed claim died
for three months on a wrong-but-published email address.

**And the clock runs silently.**

> "we're now coming up to 33 weeks, even though the legal deadline is 20 weeks"
> — parent of a 3-year-old awaiting an EHCP assessment, r/LegalAdviceUK, 2025-08-23

mySociety, who run WhatDoTheyKnow and have more experience here than anyone, on where
the hard part actually is:

> "We're now in the next phase, and turning our attention to improving the functionality
> that helps users deal with incoming responses when they come in."

## What Ladder does

1. **Firecrawl** reads the counterparty's own site, then searches and scrapes the pages
   that say who regulates them and what the published window is. This is the lookup
   people describe doing by hand, including checking a letting agent's footer for which
   accreditation body they belong to.
2. **OpenAI** turns those crawled pages into an ordered ladder: which step comes first,
   which authority owns it, and how many days each published window runs.
3. **AgentMail** gives the case a real inbox. Replies land in it, escalations go out.
4. When a reply arrives, **OpenAI** decides what kind of reply it is. The distinction
   that costs people their rights is a *holding acknowledgement* versus a *final
   response*. One feels like progress and changes nothing. The other usually unlocks the
   ombudsman.
5. **Convex** holds every clock. A cron sweeps for expired windows, and when one runs
   out Ladder drafts the escalation to the next rung and sends it.

## What actually ran, with results

Two live runs on different counterparties, nothing hardcoded, both crawled at request
time.

**Foxtons**, a UK letting agent, built from their own complaints page:

| Rung | Authority | Clock |
|---|---|---|
| Formal complaint to the lettings branch | Foxtons | 15 days, "aim to resolve the matter within 15 working days" |
| Escalate to Customer Relations | Foxtons | 15 days, "you'll have our final response within 15 working days" |
| Refer to The Property Ombudsman | The Property Ombudsman | 365 days, "within 12 months of our final response" |

Supporting quote captured and linked: *"The Property Ombudsman is the free, independent
service looking after real estate customers"*. That is the exact fact the renter above
was guessing at.

**American Airlines**, which routes to a completely different authority:

| Rung | Authority | Clock |
|---|---|---|
| Formal complaint to Customer Relations | American Airlines | 60 days, "DOT requires airlines to send consumers written responses addressing complaints within 60 days" |
| File a complaint with the Department of Transportation | U.S. Department of Transportation | 30 days |

**An escalation was really sent.** The clock was wound past its deadline, the sweep
caught it, OpenAI drafted the email, and AgentMail's own API confirms it with the label
`sent`. Opening line of the generated draft:

> "I am writing to follow up on my complaint submitted to your lettings branch on
> 6 January. I provided photos and cited the Homes (Fitness for Human Habitation) Act
> 2018, yet I have received no meaningful reply and no inspection has been arranged.
> The published window to resolve this matter within 15 working days has now passed."

## Why this is not the other 93 apps

We enumerated every submission on the hackathon tag before choosing. 55 of 93 are the
same machine: crawl a source, extract with GPT, send an email, show status. 14 are
buyer-side quote chasers, 11 are rental apps, 10 are bills and refunds.

The nearest neighbours chase the *counterparty* who is already ignoring you. Ladder
escalates to the **regulator with jurisdiction**, discovered by crawl, on a **published
clock**. We killed our own first idea on this evidence: it was a vendor quote chaser,
which would have been the 15th entry in the most crowded cluster in the competition.

## Convex depth

- One reactive `cases.board` query drives the entire screen, so a webhook landing moves
  the board with no polling.
- `by_due` is a compound index on `["state", "dueAt"]`, so the sweep is a range scan.
- Scheduler chains the work: create case → create inbox → map ladder, and
  webhook → classify → advance rung.
- Three components in one `convex.config.ts`, with the app's own routes under `/api` so
  static hosting can own `/`.

## Guardrails built on purpose

**A hallucinated regulator cannot reach the screen.** The mapper keeps the set of URLs
it genuinely fetched, and any rung or finding sourced outside that set is dropped before
writing. Model output is rebuilt field by field rather than spread, after a live run
died on a rung the model returned with no `action` and an invented nested key.

**No invented deadlines.** `clockDays` is set only when a fetched page states a window.
A rung with no stated deadline carries no clock and never auto-escalates.

**No legal-advice claims.** DoNotPay took a $193,000 FTC final order in February 2025
for exactly that.

## Bugs we hit and fixed, including two upstream

`@agentmail/convex` 0.1.0 has two problems against Convex 1.46, both patched in
`patches/` and applied on install:

1. The component reads `process.env.AGENTMAIL_API_KEY` inside itself but declares no
   `env` block, so the key never arrives and every send fails.
2. `createInbox` is an `internalAction`, which the mounting app cannot call. Ladder
   calls AgentMail's REST API directly for inbox creation.

The Firecrawl component throws when a scrape response contains a non-ASCII object key,
since Convex field names must be ASCII. Hit live on foxtons.co.uk via an en-dash in a
heading. A REST fallback keeps full page text available, which materially improved
ladder quality.

Our own worst bug: in Convex, `undefined` sorts before every number, so the index range
`.lte("dueAt", now)` also matched active rungs with **no** deadline. The sweep escalated
rungs that had no clock at all and ran until the 1800s action timeout. Fixed by bounding
the range with `.gte("dueAt", 1)`, and verified by confirming a clockless active rung is
no longer returned.

## Honest notes

- **Inbound email is registered and enabled but not yet exercised end to end.** The
  webhook is live at `/api/agentmail/webhook` and the handler, routing and classifier
  are written, but no real external reply has landed at the time of writing. AgentMail
  will not deliver self-addressed mail, so it needs a genuine external sender. Treat the
  inbound path as unproven until the video shows it.
- The statutory windows are genuinely weeks long, so the interface has a clearly
  labelled control that winds the current clock past its deadline. The clock, the sweep,
  the draft and the send are all real.
- AgentMail's free plan caps inboxes at 3 and this account already had 3, so Ladder
  reuses an existing inbox and routes inbound by thread. The address shown in the demo
  therefore belongs to an unrelated project.
- OpenAI calls are routed through OpenRouter to `openai/gpt-4o-mini`. The generation is
  an OpenAI model; the routing and billing are OpenRouter's.
- Firecrawl `/monitor` and `/interact` are not exposed by the Convex component, so
  Ladder uses `scrape` and `search`.
- The demand evidence is UK-heavy. No Australian or US renter thread cleared our
  sourcing bar.
