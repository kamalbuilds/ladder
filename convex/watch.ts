import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { scrapeMarkdown } from "./jurisdiction";
import { chatJson } from "./llm";

/**
 * Stable non-cryptographic hash. We only need "did this page change", not a
 * security property, and this avoids making every comparison async.
 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Normalise away the parts of a page that change on every request without the
 * content changing: dates, times, counters, cache-busting ids. Without this every
 * check reports a change and the feature is noise.
 */
function normalise(md: string): string {
  return md
    .replace(/\d{1,2}[:.]\d{2}(:\d{2})?\s*(am|pm)?/gi, "")
    .replace(/\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/gi, "")
    .replace(/\d{4}-\d{2}-\d{2}/g, "")
    .replace(/[?&](v|t|ts|cb|cache)=[^&\s)]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SYSTEM = `You compare two versions of an official complaints or regulator page
for someone who is relying on it to know where to escalate and by when.

You care about exactly three things:
1. a deadline or time window changing, appearing, or disappearing
2. the named regulator, ombudsman or redress scheme changing
3. the contact route changing, for example a new address, form or department

Everything else is noise: reworded marketing, layout, cookie banners, phone numbers
for unrelated teams, news items, staff names.

Return JSON:
{ "matters": true|false,
  "summary": "one plain sentence a non-lawyer understands, naming the old and new value when a deadline or authority changed" }

If nothing in those three categories changed, matters is false and summary says so
in a few words. Never invent a change that is not visible in the text.`;

export const registerWatches = internalMutation({
  args: {
    caseId: v.id("cases"),
    pages: v.array(
      v.object({ url: v.string(), label: v.string(), text: v.string() }),
    ),
  },
  handler: async (ctx, { caseId, pages }) => {
    const existing = await ctx.db
      .query("watches")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const known = new Set(existing.map((w) => w.url));

    for (const p of pages) {
      if (known.has(p.url)) continue;
      await ctx.db.insert("watches", {
        caseId,
        url: p.url,
        label: p.label,
        contentHash: hash(normalise(p.text)),
        excerpt: normalise(p.text).slice(0, 400),
        lastCheckedAt: Date.now(),
      });
    }
  },
});

export const listStale = internalQuery({
  args: { olderThan: v.number(), limit: v.number() },
  handler: async (ctx, { olderThan, limit }) => {
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_checked", (q) => q.lt("lastCheckedAt", olderThan))
      .take(limit);
    return rows.map((w) => ({
      watchId: w._id,
      caseId: w.caseId,
      url: w.url,
      contentHash: w.contentHash,
      excerpt: w.excerpt,
    }));
  },
});

export const recordCheck = internalMutation({
  args: {
    watchId: v.id("watches"),
    contentHash: v.string(),
    excerpt: v.string(),
    changed: v.boolean(),
    changeSummary: v.optional(v.string()),
    changeMatters: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      contentHash: args.contentHash,
      excerpt: args.excerpt,
      lastCheckedAt: Date.now(),
    };
    if (args.changed) {
      patch.lastChangedAt = Date.now();
      patch.changeSummary = args.changeSummary;
      patch.changeMatters = args.changeMatters;
    }
    await ctx.db.patch(args.watchId, patch);

    // A change that moves a deadline or an authority is a finding in its own right.
    if (args.changed && args.changeMatters && args.changeSummary) {
      const w = await ctx.db.get(args.watchId);
      if (w) {
        await ctx.db.insert("findings", {
          caseId: w.caseId,
          claim: `This page changed since Ladder read it: ${args.changeSummary}`,
          sourceUrl: w.url,
          kind: "deadline",
          createdAt: Date.now(),
        });
      }
    }
  },
});

/**
 * Re-reads the pages each ladder was built from and reports what moved.
 * Runs on a cron; deliberately small batches so one sweep cannot run long.
 */
export const sweepWatches = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<number> => {
    const stale = await ctx.runQuery(internal.watch.listStale, {
      // Re-read anything not checked in the last 6 hours.
      olderThan: Date.now() - 6 * 60 * 60 * 1000,
      limit: limit ?? 5,
    });

    let changed = 0;
    for (const w of stale) {
      const md = await scrapeMarkdown(ctx, w.url, true);
      if (!md) {
        await ctx.runMutation(internal.watch.recordCheck, {
          watchId: w.watchId,
          contentHash: w.contentHash,
          excerpt: w.excerpt,
          changed: false,
        });
        continue;
      }

      const clean = normalise(md);
      const next = hash(clean);
      if (next === w.contentHash) {
        await ctx.runMutation(internal.watch.recordCheck, {
          watchId: w.watchId,
          contentHash: next,
          excerpt: clean.slice(0, 400),
          changed: false,
        });
        continue;
      }

      let summary = "The page changed.";
      let matters = false;
      try {
        const verdict = await chatJson<{ matters: boolean; summary: string }>({
          system: SYSTEM,
          user: `URL: ${w.url}

WHAT LADDER READ BEFORE:
${w.excerpt}

WHAT THE PAGE SAYS NOW:
${clean.slice(0, 3000)}`,
        });
        summary = verdict.summary ?? summary;
        matters = !!verdict.matters;
      } catch (e) {
        console.warn("watch diff failed", String(e).slice(0, 160));
      }

      changed++;
      await ctx.runMutation(internal.watch.recordCheck, {
        watchId: w.watchId,
        contentHash: next,
        excerpt: clean.slice(0, 400),
        changed: true,
        changeSummary: summary,
        changeMatters: matters,
      });
    }
    return changed;
  },
});

/** Forces an immediate re-read of one case's sources, for the demo. */
export const checkNow = internalAction({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }): Promise<number> => {
    await ctx.runMutation(internal.watch.markAllStale, { caseId });
    return await ctx.runAction(internal.watch.sweepWatches, { limit: 8 });
  },
});

export const markAllStale = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { lastCheckedAt: 0 });
  },
});
