import { v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { chatJson } from "./llm";

const firecrawl = new FirecrawlClient(components.firecrawl);

type LadderPlan = {
  rungs: Array<{
    order: number;
    name: string;
    authority: string;
    action: string;
    contact?: string;
    clockDays?: number;
    clockLabel?: string;
    sourceUrl?: string;
  }>;
  findings: Array<{
    claim: string;
    sourceUrl: string;
    quote?: string;
    kind: "regulator" | "scheme_membership" | "deadline" | "contact" | "other";
  }>;
};

const SYSTEM = `You map escalation ladders for people whose complaint is being ignored.

You are NOT a lawyer and you never give legal advice. You report what official pages
say, and you always attribute a claim to the page it came from.

You are given the text of real web pages that were just crawled. Build an ordered
escalation ladder from ONLY what those pages support.

Hard rules:
- Every rung's sourceUrl MUST be one of the URLs supplied. Never invent a URL.
- Every findings[].quote MUST be a substring that genuinely appears in the supplied
  page text. If you cannot quote it, omit the quote rather than paraphrasing into one.
- clockDays is the published window in DAYS, converted from whatever unit the page
  used, and clockLabel says where it comes from, e.g. "8 weeks before the Ombudsman
  will look at it". If no page states a window, omit both. Never guess a deadline.
- Order rungs from the cheapest, earliest, most internal step (order 0) to the final
  external authority. Typically 3 to 5 rungs.
- "contact" is a real email address or a form URL found in the pages. Omit if absent.
- If the pages do not identify a regulator, say so in a finding of kind "other"
  rather than inventing one.

Return JSON: { "rungs": [...], "findings": [...] }`;

export const mapLadder = internalAction({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const kase = await ctx.runQuery(internal.cases.getInternal, { caseId });
    if (!kase) return;

    const pages: Array<{ url: string; text: string }> = [];

    const note = async (working: string) =>
      await ctx.runMutation(internal.cases.setWorking, { caseId, working });

    try {
      // 1. The counterparty's own site. This is where accreditation badges and the
      // real complaints desk live, and it is the lookup users describe by hand:
      // "check the footer of the agency website to see which body they belong to".
      if (kase.counterpartyUrl) {
        await note(`Reading ${kase.counterparty}'s own site`);
        try {
          const doc = await firecrawl.scrape(ctx, kase.counterpartyUrl, {
            onlyMainContent: false,
            maxAge: 3_600_000,
          });
          if (doc?.markdown) {
            pages.push({
              url: kase.counterpartyUrl,
              text: doc.markdown.slice(0, 12000),
            });
          }
        } catch (e) {
          console.warn("counterparty scrape failed", String(e).slice(0, 200));
        }
      }

      // 2. Who regulates them, and what the published window is. Two searches
      // rather than one, because the regulator and the deadline are usually on
      // different sites.
      const queries = [
        `${kase.counterparty} complaints ombudsman redress scheme how to complain`,
        `${kase.counterparty} ${kase.summary ?? ""} escalate complaint deadline weeks`,
      ];

      for (const q of queries) {
        await note("Finding who regulates them");
        try {
          const found = await firecrawl.search(ctx, q, { limit: 4 });
          const results = (found as any)?.web ?? (found as any)?.data ?? [];
          for (const r of results.slice(0, 4)) {
            const url = r.url ?? r.link;
            if (!url || pages.some((p) => p.url === url)) continue;
            const text = r.markdown ?? r.description ?? r.snippet ?? "";
            if (text) pages.push({ url, text: String(text).slice(0, 4000) });
          }
        } catch (e) {
          console.warn("search failed", String(e).slice(0, 200));
        }
      }

      // 3. Scrape the two most promising official pages in full, because a search
      // snippet is not enough to read a statutory window off.
      const official = pages
        .filter((p) => /ombud|gov\.|\.gov|redress|scheme|complain/i.test(p.url))
        .slice(0, 2);

      for (const p of official) {
        await note(`Reading ${new URL(p.url).hostname}`);
        try {
          const doc = await firecrawl.scrape(ctx, p.url, {
            onlyMainContent: true,
            maxAge: 3_600_000,
          });
          if (doc?.markdown) p.text = doc.markdown.slice(0, 12000);
        } catch (e) {
          console.warn("official scrape failed", String(e).slice(0, 200));
        }
      }

      if (pages.length === 0) {
        await ctx.runMutation(internal.cases.writeLadder, {
          caseId,
          rungs: [
            {
              order: 0,
              name: "Put the complaint in writing",
              authority: kase.counterparty,
              action:
                "Send a dated written complaint and keep the thread. Ladder could not reach any page for this counterparty, so no regulator has been identified yet.",
            },
          ],
          findings: [
            {
              claim:
                "No pages could be retrieved for this counterparty, so no regulator or deadline has been verified.",
              sourceUrl: kase.counterpartyUrl ?? "https://ladder.local/no-source",
              kind: "other" as const,
            },
          ],
        });
        return;
      }

      await note("Working out the ladder");
      const corpus = pages
        .map((p, i) => `--- PAGE ${i + 1} URL: ${p.url} ---\n${p.text}`)
        .join("\n\n");

      const plan = await chatJson<LadderPlan>({
        system: SYSTEM,
        user: `Counterparty: ${kase.counterparty}
What happened: ${kase.summary ?? kase.title}

Crawled pages follow. Build the ladder from these only.

${corpus}`,
      });

      // Drop anything the model sourced to a URL we never crawled. This is the
      // check that stops a confident hallucinated regulator reaching the UI.
      const allowed = new Set(pages.map((p) => p.url));
      const rungs = (plan.rungs ?? [])
        .map((r, i) => ({
          ...r,
          order: typeof r.order === "number" ? r.order : i,
          sourceUrl:
            r.sourceUrl && allowed.has(r.sourceUrl) ? r.sourceUrl : undefined,
        }))
        .sort((a, b) => a.order - b.order)
        .map((r, i) => ({ ...r, order: i }));

      const findings = (plan.findings ?? []).filter((f) =>
        allowed.has(f.sourceUrl),
      );

      if (rungs.length === 0) {
        throw new Error("model returned no rungs");
      }

      await ctx.runMutation(internal.cases.writeLadder, {
        caseId,
        rungs,
        findings,
      });
    } catch (e) {
      console.error("mapLadder failed", e);
      await ctx.runMutation(internal.cases.setWorking, {
        caseId,
        working: `Could not map the ladder: ${String(e).slice(0, 160)}`,
      });
    }
  },
});
