# Social posts

The measured bar: the highest engagement on any builder post in this hackathon is
8 likes (https://x.com/tangvu_dev/status/2094678746427199663). An
`AllGasHackathon min_faves:8` search returned zero non-organiser results, so 15 likes
would make this the most-engaged build post in the competition.

Highest-leverage distribution surface found: Wayne Sutton's launch thread did 329 likes
and 33.8k views (https://x.com/waynesutton/status/2092345067210219531). A reply or quote
into the organiser threads reaches more people than a standalone post.

---

## X / Twitter

Most people lose a complaint on the calendar, not the argument.

Ladder: name the company ignoring you. It crawls to find who actually regulates them,
tracks the deadline they published, and escalates the day it expires.

Foxtons routes to The Property Ombudsman. American Airlines routes to the DOT. Nothing
hardcoded, both crawled live, every deadline links to the page it came from.

It reads the replies too. "We've received your complaint and will look into it" gets
tagged a holding reply, because that is a company running your clock down.

Built on @convex_dev with @firecrawl_dev, @AgentMail and @OpenAI.

<LIVE URL>
<VIDEO URL>

---

## LinkedIn

I spent the Convex All Gas Hackathon on something I kept finding in other people's
words: when an organisation stops replying to you, the thing that beats you is rarely
the argument. It is the calendar, and not knowing who above them is obliged to listen.

One case we found: a passenger had £520 of flight compensation confirmed in writing,
sent his bank details as instructed, and then got three months of silence. The published
contact address was not the desk that pays, and nobody told him.

So we built Ladder. You name whoever has gone quiet. Firecrawl reads their own
complaints page and the regulator's, OpenAI turns that into an ordered escalation ladder
with each published deadline attached, AgentMail gives the case a real inbox, and Convex
holds every clock and escalates when one runs out.

Two things I care about more than the demo:

Every claim carries the page it was read from, and any rung the model sourced to a URL
we did not actually crawl is dropped before it reaches the screen. A confidently invented
ombudsman is the worst thing this product could produce.

And it never claims to be legal advice. DoNotPay took a $193,000 FTC final order in
February 2025 for exactly that. Ladder reports what official pages say, and links them.

Live: <LIVE URL>
Code: https://github.com/kamalbuilds/ladder
Demo: <VIDEO URL>

Built with Convex, Firecrawl, AgentMail and OpenAI.

---

## Reddit

Subreddit: r/SideProject (promotional posts are allowed there; most UK legal and renting
subs ban self-promotion outright, so do not post it to r/LegalAdviceUK or
r/TenantsInTheUK even though that is where the users are).

**Title:** I built a tool that finds which ombudsman actually has jurisdiction over the
company ignoring you, and escalates when their published deadline runs out

**Body:**

I kept reading the same two sentences in complaint threads. "Do I go to an ombudsman?"
and "it's been 33 weeks and the legal deadline was 20."

Those are two different failures and both of them are fatal. You do not know who has
authority over the specific company ignoring you, and the clock runs out while you work
it out.

So I built Ladder. You give it the name of whoever has gone quiet. It crawls their own
complaints page and the relevant official pages, works out which redress scheme or
regulator actually covers them, and builds an escalation ladder with each published
deadline attached to the step it governs.

Two real examples it produced, both crawled at request time rather than looked up in a
table:

- A UK letting agent routed to The Property Ombudsman, 15 working days for their final
  response, 12 months to refer onward, with the sentence from their own page quoted.
- An American airline routed to the US Department of Transportation instead, with the
  60-day response and 30-day acknowledgement rules.

It also gives the case a real email address, so replies come back in and get read. The
distinction it cares about is a holding acknowledgement versus a final response. "We have
received your complaint and will look into it" feels like progress, changes nothing, and
does not start the clock that unlocks the ombudsman.

Things I deliberately did not do: it never says it is legal advice, and it will not show
you a regulator it did not actually read on a page. Anything the model sourced to a URL
that was not crawled gets dropped before it renders.

Free, live, open source. Built for the Convex hackathon with Convex, Firecrawl, AgentMail
and OpenAI.

Live: <LIVE URL>
Code: https://github.com/kamalbuilds/ladder

Happy to take it apart if anyone here has fought a redress scheme and thinks the ladder
is wrong.
