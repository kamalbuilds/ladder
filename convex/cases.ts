import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { caseStatus, rungState } from "./schema";
import { requireEmail, requireCaseAccess, normaliseEmail } from "./auth";

/**
 * Cases the signed-in person owns, plus any they have been invited onto.
 * Identity comes from the session, never from an argument.
 */
export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const email = await requireEmail(ctx, token);

    const owned = await ctx.db
      .query("cases")
      .withIndex("by_owner", (q) => q.eq("ownerEmail", email))
      .order("desc")
      .collect();

    const memberships = await ctx.db
      .query("members")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();

    const shared = [];
    for (const m of memberships) {
      const k = await ctx.db.get(m.caseId);
      if (k && normaliseEmail(k.ownerEmail) !== email) {
        shared.push({ ...k, sharedWithMe: true as const });
      }
    }

    return [...owned.map((c) => ({ ...c, sharedWithMe: false as const })), ...shared].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  },
});

/** Everything the board renders, in one reactive read. */
export const board = query({
  args: { token: v.string(), caseId: v.id("cases") },
  handler: async (ctx, { token, caseId }) => {
    const { role } = await requireCaseAccess(ctx, token, caseId);
    const kase = await ctx.db.get(caseId);
    if (!kase) return null;

    const [rungs, findings, messages, watches] = await Promise.all([
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
      ctx.db
        .query("watches")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect(),
    ]);

    const members = await ctx.db
      .query("members")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();

    return {
      case: kase,
      role,
      rungs: rungs.sort((a, b) => a.order - b.order),
      findings,
      messages,
      watches,
      members,
      now: Date.now(),
    };
  },
});

export const create = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    counterparty: v.string(),
    counterpartyUrl: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, { token, ...args }) => {
    const ownerEmail = await requireEmail(ctx, token);
    const caseId = await ctx.db.insert("cases", {
      ...args,
      ownerEmail,
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

/** Re-reads this case's source pages now rather than waiting for the 6-hour cron. */
export const recheckSources = mutation({
  args: { token: v.string(), caseId: v.id("cases") },
  handler: async (ctx, { token, caseId }) => {
    await requireCaseAccess(ctx, token, caseId);
    await ctx.db.patch(caseId, { working: "Re-reading the pages it relied on" });
    await ctx.scheduler.runAfter(0, internal.watch.checkNow, { caseId });
  },
});

/**
 * The document you attach to an ombudsman filing: dated, cited, and containing
 * every reply with what Ladder made of it. Built server-side so it is one
 * reactive read rather than assembled in the browser.
 */
export const evidencePack = query({
  args: { token: v.string(), caseId: v.id("cases") },
  handler: async (ctx, { token, caseId }) => {
    await requireCaseAccess(ctx, token, caseId);
    const kase = await ctx.db.get(caseId);
    if (!kase) return null;

    const [rungs, findings, messages, watches] = await Promise.all([
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
        .collect(),
      ctx.db
        .query("watches")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect(),
    ]);

    const d = (t: number) =>
      new Date(t).toISOString().slice(0, 16).replace("T", " ");
    const L: string[] = [];

    L.push(`# Complaint record: ${kase.counterparty}`);
    L.push("");
    L.push(`**Subject:** ${kase.title}`);
    L.push(`**Complainant:** ${kase.ownerEmail}`);
    L.push(`**Correspondence address:** ${kase.inboxEmail ?? "not set"}`);
    L.push(`**Opened:** ${d(kase.createdAt)}`);
    L.push(`**Prepared:** ${d(Date.now())}`);
    L.push("");
    if (kase.summary) {
      L.push("## What happened");
      L.push("");
      L.push(kase.summary);
      L.push("");
    }

    L.push("## Escalation steps and the published windows");
    L.push("");
    for (const r of rungs.sort((a, b) => a.order - b.order)) {
      const mark =
        r.state === "expired"
          ? "OVERDUE"
          : r.state === "cleared"
            ? "done"
            : r.state === "active"
              ? "in progress"
              : "not yet reached";
      L.push(`### ${r.order + 1}. ${r.name} (${mark})`);
      L.push("");
      L.push(`Authority: ${r.authority}`);
      if (r.contact) L.push(`Contact: ${r.contact}`);
      if (r.clockLabel) L.push(`Published window: ${r.clockLabel}`);
      if (r.startedAt) L.push(`Started: ${d(r.startedAt)}`);
      if (r.dueAt) {
        const over = Date.now() > r.dueAt;
        L.push(`Due: ${d(r.dueAt)}${over ? " (passed)" : ""}`);
      }
      if (r.sourceUrl) L.push(`Source: ${r.sourceUrl}`);
      L.push("");
    }

    L.push("## Correspondence");
    L.push("");
    for (const m of messages.sort((a, b) => a.receivedAt - b.receivedAt)) {
      const dir = m.direction === "inbound" ? "Received from" : "Sent to";
      const who = m.direction === "inbound" ? m.from : m.to;
      L.push(`### ${d(m.receivedAt)} — ${dir} ${who}`);
      L.push("");
      L.push(`Subject: ${m.subject}`);
      if (m.replyKind) {
        L.push("");
        L.push(`Assessment: ${m.replyKind.replace(/_/g, " ")}.${m.replyReason ? ` ${m.replyReason}` : ""}`);
      }
      L.push("");
      L.push(
        m.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      L.push("");
    }

    if (findings.length) {
      L.push("## Sources relied on");
      L.push("");
      for (const f of findings) {
        L.push(`- ${f.claim}`);
        if (f.quote) L.push(`  - Quoted: "${f.quote}"`);
        L.push(`  - ${f.sourceUrl}`);
      }
      L.push("");
    }

    const moved = watches.filter((w) => w.lastChangedAt);
    if (moved.length) {
      L.push("## Changes to the published rules since this complaint opened");
      L.push("");
      for (const w of moved) {
        L.push(
          `- ${d(w.lastChangedAt!)}: ${w.changeSummary ?? "page changed"} (${w.url})`,
        );
      }
      L.push("");
    }

    L.push("---");
    L.push("");
    L.push(
      "Prepared by Ladder. Ladder is not a law firm and gives no legal advice. Every statement above about a published procedure or deadline is quoted from the linked source and was read on the date shown.",
    );

    return { filename: `ladder-${kase.counterparty.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`, markdown: L.join("\n") };
  },
});

/** Removes a case and everything hanging off it. Used to clear test data. */
export const purge = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    for (const table of [
      "rungs",
      "findings",
      "messages",
      "watches",
      "members",
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    await ctx.db.delete(caseId);
  },
});

/**
 * Invites someone else onto this case. They see the same board, updating live.
 * A renter and the advice worker helping them are the case we built it for.
 */
export const share = mutation({
  args: { token: v.string(), caseId: v.id("cases"), email: v.string() },
  handler: async (ctx, { token, caseId, email }) => {
    const { email: inviter, role } = await requireCaseAccess(ctx, token, caseId);
    if (role !== "owner") throw new Error("Only the case owner can invite people.");

    const addr = normaliseEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      throw new Error("That does not look like an email address.");
    }
    const kase = await ctx.db.get(caseId);
    if (kase && normaliseEmail(kase.ownerEmail) === addr) {
      throw new Error("That is already the owner of this case.");
    }

    const existing = await ctx.db
      .query("members")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    if (existing.some((m) => normaliseEmail(m.email) === addr)) return null;

    return await ctx.db.insert("members", {
      caseId,
      email: addr,
      role: "collaborator",
      invitedBy: inviter,
      createdAt: Date.now(),
    });
  },
});

export const unshare = mutation({
  args: { token: v.string(), memberId: v.id("members") },
  handler: async (ctx, { token, memberId }) => {
    const member = await ctx.db.get(memberId);
    if (!member) return;
    const { role } = await requireCaseAccess(ctx, token, member.caseId);
    if (role !== "owner") throw new Error("Only the case owner can remove people.");
    await ctx.db.delete(memberId);
  },
});

/** Demo affordance: wind a rung's clock back so an expiry can be watched live. */
export const fastForwardClock = mutation({
  args: { token: v.string(), caseId: v.id("cases") },
  handler: async (ctx, { token, caseId }) => {
    await requireCaseAccess(ctx, token, caseId);
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
