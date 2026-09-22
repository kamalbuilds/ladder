import { v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { chatJson } from "./llm";

declare const process: { env: Record<string, string | undefined> };

const firecrawl = new FirecrawlClient(components.firecrawl);

/**
 * Scrape one page to markdown.
 *
 * The component is tried first. It can throw on pages whose response contains an
 * object key with a non-ASCII character, because Convex field names must be ASCII
 * and the component converts the whole response to a Convex value. Observed live on
 * foxtons.co.uk: "Field name Foxtons Complaints Procedure – Resolving Issues with
 * Care and Transparency has invalid character '–'".
 *
 * Falling back to Firecrawl's REST API keeps full page text available, which
 * materially changes ladder quality: without it we are building from search
 * snippets instead of the page that actually states the deadline.
 */
export async function scrapeMarkdown(
  ctx: any,
  url: string,
  onlyMainContent: boolean,
): Promise<string | null> {
  try {
    const doc = await firecrawl.scrape(ctx, url, {
      formats: ["markdown"],
      onlyMainContent,
      maxAge: 3_600_000,
    });
    if (doc?.markdown) return doc.markdown;
  } catch (e) {
    console.warn(
      `component scrape failed for ${url}, falling back to REST:`,
      String(e).slice(0, 160),
    );
  }

  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent }),
    });
    if (!res.ok) {
      console.warn(`firecrawl REST ${res.status} for ${url}`);
      return null;
    }
    const body = (await res.json()) as { data?: { markdown?: string } };
    return body.data?.markdown ?? null;
  } catch (e) {
    console.warn("firecrawl REST threw", String(e).slice(0, 160));
    return null;
  }
}

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
- IMPORTANT: if the pages state a window that applies to a rung, that window belongs
  on the rung as clockDays, not only in findings. A rung with no clock never triggers
  anything, so a deadline you found and did not attach is a deadline the user misses.
  Convert units: "20 working days" is 28, "8 weeks" is 56, "12 months" is 365.
- Only the rung a person is waiting on needs a clock. A rung describing a window to
  file BY (for example "within 12 months of the final response") still gets clockDays,
  because it is the deadline that matters for that step.
- Order rungs from the cheapest, earliest, most internal step (order 0) to the final
  external authority. Typically 3 to 5 rungs.
- "contact" is a real email address or a form URL found in the pages. Omit if absent.
- If the pages do not identify a regulator, say so in a finding of kind "other"
  rather than inventing one.

Return exactly this JSON shape, with rungs and findings as two SEPARATE top-level
arrays. Never nest findings inside a rung.

{
  "rungs": [
    {
      "order": 0,
      "name": "Formal complaint to the agency",     // required, short
      "authority": "Hastings Letting Agents",        // required, who handles it
      "action": "Send a dated complaint to ...",     // required, one or two sentences
      "contact": "complaints@example.com",           // optional
      "clockDays": 56,                               // optional, DAYS, number only
      "clockLabel": "8 weeks before the Ombudsman will look at it", // optional
      "sourceUrl": "https://..."                     // optional, must be a supplied URL
    }
  ],
  "findings": [
    {
      "claim": "They are a member of The Property Ombudsman",
      "sourceUrl": "https://...",
      "quote": "exact substring from the page",
      "kind": "scheme_membership"
    }
  ]
}

kind is one of: regulator, scheme_membership, deadline, contact, other.
Every rung MUST have name, authority and action. Omit a field entirely rather than
sending null.`;

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
        const md = await scrapeMarkdown(ctx, kase.counterpartyUrl, false);
        if (md) {
          pages.push({ url: kase.counterpartyUrl, text: md.slice(0, 12000) });
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
        const md = await scrapeMarkdown(ctx, p.url, true);
        if (md) p.text = md.slice(0, 12000);
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
      // Rebuild every object field by field. Spreading the model's output passes
      // through whatever extra keys it invented and lets a missing required field
      // reach the validator, which is exactly how the first live run died.
      const allowed = new Set(pages.map((p) => p.url));
      const str = (x: unknown): string | undefined => {
        if (typeof x !== "string") return undefined;
        const t = x.trim();
        return t.length > 0 ? t : undefined;
      };
      const sourced = (x: unknown): string | undefined => {
        const s = str(x);
        return s && allowed.has(s) ? s : undefined;
      };

      const rungs = (Array.isArray(plan.rungs) ? plan.rungs : [])
        .map((r: any) => {
          const name = str(r?.name);
          const authority = str(r?.authority);
          // A rung with no name or no authority is not a rung. Drop it rather
          // than inventing a label for it.
          if (!name || !authority) return null;
          const days = Number(r?.clockDays);
          return {
            order: Number.isFinite(Number(r?.order)) ? Number(r.order) : 999,
            name,
            authority,
            action: str(r?.action) ?? `Contact ${authority} about this complaint.`,
            // Only a real address may become a `contact`. The prompt invites a
            // form URL too, and anything here is later used as an email
            // recipient, so a page in the crawl corpus could otherwise steer
            // where a complaint gets sent.
            contact: (() => {
              const c = str(r?.contact);
              return c && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c) ? c : undefined;
            })(),
            contactUrl: (() => {
              const c = str(r?.contact);
              return c && /^https?:\/\//i.test(c) ? c : undefined;
            })(),
            clockDays: Number.isFinite(days) && days > 0 ? days : undefined,
            clockLabel: str(r?.clockLabel),
            sourceUrl: sourced(r?.sourceUrl),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => a.order - b.order)
        .map((r, i) => ({ ...r, order: i }));

      const validKinds = new Set([
        "regulator",
        "scheme_membership",
        "deadline",
        "contact",
        "other",
      ]);
      const findings = (Array.isArray(plan.findings) ? plan.findings : [])
        .map((f: any) => {
          const claim = str(f?.claim);
          const sourceUrl = sourced(f?.sourceUrl);
          if (!claim || !sourceUrl) return null;
          const kind = str(f?.kind);
          return {
            claim,
            sourceUrl,
            quote: str(f?.quote),
            kind: (kind && validKinds.has(kind) ? kind : "other") as
              | "regulator"
              | "scheme_membership"
              | "deadline"
              | "contact"
              | "other",
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);

      if (rungs.length === 0) {
        throw new Error("model returned no rungs");
      }

      await ctx.runMutation(internal.cases.writeLadder, {
        caseId,
        rungs,
        findings,
      });

      // Everything the ladder leans on gets watched. If one of these pages
      // rewrites its deadline later, the ladder is quietly wrong.
      const relied = new Set(
        [
          ...rungs.map((r) => r.sourceUrl),
          ...findings.map((f) => f.sourceUrl),
        ].filter((u): u is string => !!u),
      );
      await ctx.runMutation(internal.watch.registerWatches, {
        caseId,
        pages: pages
          .filter((p) => relied.has(p.url))
          .map((p) => ({
            url: p.url,
            label: new URL(p.url).hostname.replace(/^www\./, ""),
            text: p.text,
          })),
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
