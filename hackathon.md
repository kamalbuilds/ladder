# Ladder

**Find who actually regulates them. Watch the clock. Escalate the day it runs out.**

- Live URL: _pending deploy_
- Repo: _pending_
- Demo video: _pending_
- Built for the Convex All Gas Hackathon, sponsored by OpenAI, Firecrawl and AgentMail.

Ladder is not a law firm and gives no legal advice. It reports what official pages say
and links every one of them. That line is in the product UI, not just here.

---

## The problem

When an organisation stops replying to you, the thing that beats you is rarely the
argument. It is the calendar, plus not knowing who above them is obliged to listen.

We went looking for people describing this in their own words before we wrote any code.
Four independent research lanes, run in parallel, converged on the same two failures.

**Nobody knows who has jurisdiction.**

> "there must be a higher authority that supervises the work (or lack thereof) of
> councils. Help?"
> — r/london, 2024-04-29

> "Yes, i **think** its The Property Ombudsman"
> — a renter about to file with a scheme they have guessed at, r/TenantsInTheUK, 2024-12-17

> "I didn't know/realise they would be subject to Ombudsman oversight"
> — r/HousingUK, 2024-10-02

The sharpest single case we found: an American Airlines passenger had £520 in
compensation **confirmed in writing**, sent their bank details as instructed, and then
got three months of silence across three separate attempts. The fix, supplied by a
stranger in the thread, was that the published customer-relations address is not the
desk that pays. The live one is `AA.ECClaims@aa.com`. A confirmed claim died for three
months on a wrong-but-published email address. That is the clearest proof we found
anywhere that crawling does real work here.

**And the clock runs silently.**

> "we're now coming up to 33 weeks, even though the legal deadline is 20 weeks"
> — parent of a 3-year-old awaiting an EHCP assessment, r/LegalAdviceUK, 2025-08-23

> "It's been over three months and I haven't received any payment or follow-up. I've
> reached out three separate times to Customer Relations with no response whatsoever."
> — r/americanairlines, 2025-10-17

The tool-maker with the most experience here agrees the send side was never the hard
part. mySociety, who run WhatDoTheyKnow:

> "We're now in the next phase, and turning our attention to improving the functionality
> that helps users deal with incoming responses when they come in."

## What Ladder does

You describe who has gone quiet on you. Then:

1. **Firecrawl** reads their own site, then searches for and scrapes the pages that say
   who regulates them and what the published window is. This is exactly the lookup people
   describe doing by hand, including checking a letting agent's own footer for which
   accreditation body they belong to.
2. **OpenAI** turns those crawled pages into an ordered escalation ladder: which step
   comes first, which authority owns each step, and how many days each published window
   runs. It may only cite pages that were actually fetched.
3. **AgentMail** gives the case its own real inbox. Replies from the other side land in
   it, and escalations go out from it.
4. When a reply arrives, **OpenAI** decides what kind of reply it really is. The
   distinction that matters, and that costs people their rights, is a *holding
   acknowledgement* versus a *final response*. One feels like progress and changes
   nothing. The other usually unlocks the ombudsman.
5. **Convex** holds every clock. A cron sweeps for expired windows, and when one runs
   out Ladder drafts the escalation to the next rung and sends it.

## Why this is not the other 93 apps

We enumerated every submission on the hackathon tag before choosing. 55 of 93 are the
same machine: crawl a source, extract fields with GPT, send an email, show the status.
14 are buyer-side quote chasers. 11 are rental apps, 10 are bills and refunds.

The nearest neighbours to Ladder chase the *counterparty* who is already ignoring you.
Ladder escalates to the **regulator with jurisdiction**, discovered by crawl, on a
**statutory clock**. That is the part nobody built, and it is the part every one of our
sourced complaints is actually asking for.

We killed our own first idea on this evidence. It was a vendor quote chaser, which would
have been the 15th entry in the most crowded cluster in the competition.

## Guardrails we built on purpose

**Hallucinated regulators cannot reach the UI.** The mapper keeps the set of URLs it
genuinely crawled, and any rung or finding whose `sourceUrl` is not in that set is
dropped before it is written (`convex/jurisdiction.ts`). A confident invented ombudsman
is the single most dangerous output this product could produce.

**No invented deadlines.** `clockDays` is only set when a fetched page states a window.
If no page says it, the rung carries no clock rather than a plausible one.

**No legal-advice claims.** DoNotPay took a $193,000 FTC final order in February 2025 for
exactly that. Ladder says what pages say, cites them, and says so in the interface.

## Stack

- **Convex** — database, queries, mutations, actions, scheduler, crons, live subscriptions
- **Convex components** — `@agentmail/convex`, `@firecrawl/firecrawl-convex`,
  `@convex-dev/static-hosting`
- **AgentMail** — per-case inbox, svix-signed inbound webhook, outbound send
- **Firecrawl** — `scrape` and `search`, inline in actions
- **OpenAI** — ladder construction, reply classification, escalation drafting
- **React + Vite**, served from Convex static hosting

## Convex depth

- Reactive `cases.board` query drives the whole screen, so a webhook landing moves the
  board with no polling.
- `crons.ts` sweeps expired clocks on an interval; `by_due` is a compound index on
  `["state", "dueAt"]` so the sweep is a range scan, not a table scan.
- Scheduler chains the work: create case → create inbox → map ladder, and
  webhook → classify → advance rung.
- Three components mounted in one `convex.config.ts`.

## Honest notes

- The statutory windows are genuinely weeks long, so the interface has a visible control
  that winds the current clock past its deadline. It is labelled as what it is. The clock
  itself, the sweep, the draft and the send are all real.
- Firecrawl `/monitor` and `/interact` are not exposed by the Convex component, so Ladder
  uses `scrape` and `search` only.
- The demand evidence we gathered is UK-heavy. No Australian or US renter thread cleared
  our sourcing bar.
