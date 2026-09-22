# Submission pack — paste-ready

Form: https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit
Deadline: 2026-09-22, 12:00 PM PT.

---

## App Title

```
Ladder
```

## Tagline (140 char hard cap — this is 118)

```
Find who actually regulates the company ignoring you, track the published deadline, and escalate the day it runs out.
```

## App Website Link

```
https://focused-mink-234.convex.site
```

## GitHub Repo

```
https://github.com/kamalbuilds/ladder
```

## Radio: uses a convex.site or chatgpt.site url

```
convex.site
```

## Tags (max 6, max 20 chars each)

```
consumer-rights
complaints
ombudsman
email-agent
everyday-app
allgashackathon
```

## Screenshot

`docs/screenshot.png` in the repo.

## Video Demo

Under 3 minutes. Suggested run of show, click through the real product and talk less:

1. Open the live URL. Point at the disclaimer line: not a law firm, links every source.
2. New case: "Damp and mould, no inspection arranged", counterparty Foxtons, paste their
   URL, describe it in one line. Hit **Map the ladder**.
3. While it works, say the sentence that matters: *fourteen apps in this hackathon chase
   the company that is already ignoring you. Ladder goes over their head.*
4. The ladder appears. Three rungs, real clocks, and every deadline links to the page it
   was read from. Click one source link so judges see it is a real page.
5. Scroll to **What Ladder read, and where**, and read the Property Ombudsman quote out
   loud. Say: this is the fact people guess wrong and lose their case on.
6. Hit **Wind the clock past its deadline**. Say the windows are genuinely weeks long, so
   this is a labelled control, and the clock, the draft and the send are all real.
7. Show the drafted escalation.
8. Switch to the American Airlines case. Show it routed to the US Department of
   Transportation instead, with 60-day and 30-day clocks. Nothing is hardcoded.
9. Show **Correspondence**: two real inbound emails tagged **holding reply**, with
   Ladder's reason. Close on that: *this is what a company sends when it wants your
   clock to run out.*

---

## Description (Markdown, for the long description field)

### Problem you're solving

When an organisation stops replying to you, the thing that beats you is rarely the
argument. It is the calendar, plus not knowing who above them is obliged to listen.

Before writing code we ran four research lanes looking for people describing this in
their own words. They converged on two failures.

Nobody knows who has jurisdiction:

> "there must be a higher authority that supervises the work (or lack thereof) of
> councils. Help?" (r/london, 2024-04-29)

> "Yes, i **think** its The Property Ombudsman" (a renter about to file with a scheme
> they have guessed at, r/TenantsInTheUK, 2024-12-17)

And the clock runs silently:

> "we're now coming up to 33 weeks, even though the legal deadline is 20 weeks" (a parent
> awaiting an EHCP assessment, r/LegalAdviceUK, 2025-08-23)

The sharpest case we found: an American Airlines passenger had £520 compensation
confirmed in writing, sent their bank details as instructed, then got three months of
silence. The published customer-relations address was not the desk that pays. A
confirmed claim died for three months on a wrong-but-published email address.

### How the app works

1. **Firecrawl** reads the counterparty's own site, then searches and scrapes the pages
   that say who regulates them and what window applies.
2. **OpenAI** turns those crawled pages into an ordered escalation ladder, with each
   published deadline attached to the rung it governs.
3. **AgentMail** gives the case a real inbox. Escalations go out from it and replies land
   back in it through an svix-signed webhook.
4. When a reply arrives, **OpenAI** decides what kind of reply it actually is. The
   distinction that costs people their rights is a holding acknowledgement versus a final
   response. One feels like progress and changes nothing. The other usually unlocks the
   ombudsman.
5. **Convex** holds every clock, sweeps for expired ones on a cron, drafts the escalation
   to the next rung, and sends it.

### Notable features

**Nothing is hardcoded.** Two live runs on different counterparties produced completely
different ladders. Foxtons routed to The Property Ombudsman with a 15-working-day window
and a 12-month referral limit. American Airlines routed to the US Department of
Transportation with 60-day and 30-day windows. Both were crawled at request time.

**Every claim carries its source.** The interface has a section called "What Ladder read,
and where", with the quote and the URL.

**A hallucinated regulator cannot reach the screen.** The mapper keeps the set of URLs it
genuinely fetched, and any rung or finding sourced outside that set is dropped before
writing. Model output is rebuilt field by field rather than spread.

**No invented deadlines.** A clock is set only when a fetched page states a window. A rung
with no stated deadline carries no clock and never auto-escalates.

### Why did you build this

Because the free official route already exists and almost nobody can find it. AviationADR
handles claims free and binding, averaging 29 days, while AirHelp takes 35% including VAT
for the same work. Resolver has 5 million users and 8.1 million cases. The gap is not
appetite, it is that people cannot tell which body has authority over the specific
company ignoring them, and they miss the window while they work it out.

We also checked we were not building the 93rd version of the same thing. 55 of the 93
submissions on the hackathon tag are the same machine: crawl, extract, email, display.
14 are buyer-side quote chasers. Our own first idea was a vendor quote chaser, and we
killed it on that evidence.

### Tech stack

- Convex: database, queries, mutations, actions, scheduler, crons, live queries, components
- Convex components: `@agentmail/convex`, `@firecrawl/firecrawl-convex`, `@convex-dev/static-hosting`
- Firecrawl: `scrape` and `search`, inline in actions
- AgentMail: inbox, outbound send, svix-signed inbound webhook
- OpenAI `gpt-4o-mini`, routed via OpenRouter
- React and Vite, served from Convex static hosting at a convex.site URL

### Challenges we ran into

Two upstream bugs in `@agentmail/convex` 0.1.0 against Convex 1.46, both patched in
`patches/` and applied on install. The component reads `process.env.AGENTMAIL_API_KEY`
inside itself but declares no `env` block, so the key never arrives and every send fails.
And `createInbox` is an `internalAction`, which a mounting app cannot call, so inbox
creation goes direct to AgentMail's REST API instead.

The Firecrawl component throws when a scrape response contains a non-ASCII object key,
because Convex field names must be ASCII. We hit it live on an en-dash in a foxtons.co.uk
heading. A REST fallback keeps full page text available, which measurably improved ladder
quality: before it we were building from search snippets.

Our own worst bug was subtle. In Convex, `undefined` sorts before every number, so the
index range `.lte("dueAt", now)` also matched every active rung with no deadline at all.
The sweep escalated clockless rungs and ran until the 1800 second action timeout. Fixed by
bounding the range with `.gte("dueAt", 1)`, and verified by confirming a clockless active
rung is no longer returned.

### Honest notes

AgentMail's free plan caps inboxes at 3 and the account already had 3, so Ladder reuses an
existing inbox and routes inbound mail by thread. The address in the demo therefore carries
an unrelated project's name. Inbound routing falls back to the newest open case when the
outbound thread id has not been captured yet. Firecrawl's `/monitor` and `/interact` are not
exposed by the Convex component, so Ladder uses `scrape` and `search`. The demand evidence
we gathered is UK-heavy.

---

## Social post (X)

> Most people lose a complaint on the calendar, not the argument.
>
> Built Ladder: name the company ignoring you, and it crawls to find who actually
> regulates them, tracks the published deadline, and escalates the day it expires.
>
> Foxtons routes to The Property Ombudsman. American Airlines routes to the DOT. Nothing
> hardcoded, both crawled live, every deadline links to the page it came from.
>
> It reads the replies too. "We've received your complaint and will look into it" gets
> tagged a holding reply, because that is a company running your clock down.
>
> Built on @convex with @firecrawl, @AgentMail and @OpenAI.
>
> https://focused-mink-234.convex.site

The measured bar: the highest engagement on any build post in this hackathon is 8 likes
(https://x.com/tangvu_dev/status/2094678746427199663). An `AllGasHackathon min_faves:8`
search returned zero non-organiser results, so 15 likes would make this the most-engaged
build post in the competition.
