import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { caseStatus, rungState } from "./schema";

export const list = query({
  args: { ownerEmail: v.string() },
  handler: async (ctx, { ownerEmail }) =>
    await ctx.db
      .query("cases")
      .withIndex("by_owner", (q) => q.eq("ownerEmail", ownerEmail))
      .order("desc")
      .collect(),
});

/** Everything the board renders, in one reactive read. */
export const board = query({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const kase = await ctx.db.get(caseId);
    if (!kase) return null;

    const [rungs, findings, messages] = await Promise.all([
      ctx.db
        .query("rungs")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect(),
      ctx.db
        .query("findings")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect(),
      ctx.db
        .query("messages")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .order("desc")
        .take(50),
    ]);

    return {
      case: kase,
      rungs: rungs.sort((a, b) => a.order - b.order),
      findings,
      messages,
      now: Date.now(),
    };
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    counterparty: v.string(),
    counterpartyUrl: v.optional(v.string()),
    ownerEmail: v.string(),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caseId = await ctx.db.insert("cases", {
      ...args,
      status: "mapping",
      working: "Finding who regulates them",
      createdAt: Date.now(),
    });

    const slug = args.counterparty
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 18) || "case";

    await ctx.scheduler.runAfter(0, internal.email.createCaseInbox, {
      caseId,
      slug,
    });
    await ctx.scheduler.runAfter(0, internal.jurisdiction.mapLadder, { caseId });
    return caseId;
  },
});

export const getInternal = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => await ctx.db.get(caseId),
});

export const attachInbox = internalMutation({
  args: {
    caseId: v.id("cases"),
    inboxId: v.string(),
    inboxEmail: v.string(),
  },
  handler: async (ctx, { caseId, inboxId, inboxEmail }) => {
    await ctx.db.patch(caseId, { inboxId, inboxEmail });
  },
});

export const setWorking = internalMutation({
  args: { caseId: v.id("cases"), working: v.optional(v.string()) },
  handler: async (ctx, { caseId, working }) => {
    await ctx.db.patch(caseId, { working });
  },
});

export const setStatus = internalMutation({
  args: { caseId: v.id("cases"), status: caseStatus },
  handler: async (ctx, { caseId, status }) => {
    await ctx.db.patch(caseId, { status });
  },
});

/** Written by the mapper once the crawl has produced a sourced ladder. */
export const writeLadder = internalMutation({
  args: {
    caseId: v.id("cases"),
    rungs: v.array(
      v.object({
        order: v.number(),
        name: v.string(),
        authority: v.string(),
        action: v.string(),
        contact: v.optional(v.string()),
        clockDays: v.optional(v.number()),
        clockLabel: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
      }),
    ),
    findings: v.array(
      v.object({
        claim: v.string(),
        sourceUrl: v.string(),
        quote: v.optional(v.string()),
        kind: v.union(
          v.literal("regulator"),
          v.literal("scheme_membership"),
          v.literal("deadline"),
          v.literal("contact"),
          v.literal("other"),
        ),
      }),
    ),
  },
  handler: async (ctx, { caseId, rungs, findings }) => {
    const existing = await ctx.db
      .query("rungs")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    for (const r of existing) await ctx.db.delete(r._id);

    for (const r of rungs) {
      await ctx.db.insert("rungs", {
        caseId,
        ...r,
        // The first rung is live immediately; the rest unlock as clocks expire.
        state: r.order === 0 ? "active" : "locked",
        startedAt: r.order === 0 ? Date.now() : undefined,
        dueAt:
          r.order === 0 && r.clockDays
            ? Date.now() + r.clockDays * 24 * 60 * 60 * 1000
            : undefined,
      });
    }

    for (const f of findings) {
      await ctx.db.insert("findings", { caseId, ...f, createdAt: Date.now() });
    }

    await ctx.db.patch(caseId, { status: "waiting", working: undefined });
  },
});

export const setRungState = internalMutation({
  args: {
    rungId: v.id("rungs"),
    state: rungState,
    startedAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
  },
  handler: async (ctx, { rungId, state, startedAt, dueAt }) => {
    await ctx.db.patch(rungId, { state, startedAt, dueAt });
  },
});

/** Removes a case and everything hanging off it. Used to clear test data. */
export const purge = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    for (const table of ["rungs", "findings", "messages"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    await ctx.db.delete(caseId);
  },
});

/** Demo affordance: wind a rung's clock back so an expiry can be watched live. */
export const fastForwardClock = mutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const active = await ctx.db
      .query("rungs")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const current = active
      .sort((a, b) => a.order - b.order)
      .find((r) => r.state === "active");
    if (!current) return null;

    await ctx.db.patch(current._id, { dueAt: Date.now() - 1000 });
    await ctx.scheduler.runAfter(0, internal.escalate.sweepExpiredClocks, {});
    return current._id;
  },
});
