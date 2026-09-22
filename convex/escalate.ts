import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

declare const process: { env: Record<string, string | undefined> };
import { chatJson } from "./llm";

type Draft = { subject: string; body: string };

const SYSTEM = `You write the escalation email for someone whose complaint has been
ignored past a published deadline. You are not a lawyer and you must never say or
imply that you are, never claim a guaranteed outcome, and never cite a statute or a
scheme that was not supplied to you.

Write as the person themselves, in plain first-person English. British spelling when
the authority is British.

The email must:
- open with what was asked and when, and state plainly that the published window has
  now passed
- name the authority and the window ONLY as given in the supplied facts, and quote the
  source line where one is supplied
- ask for one specific thing, and give a date by which
- stay under 220 words
- have no placeholders, no square brackets, no "[your name]". Use the real name given.

Return JSON: { "subject": string, "body": string }`;

type DueRung = { rungId: Id<"rungs">; caseId: Id<"cases"> };

export const sweepExpiredClocks = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const due: DueRung[] = await ctx.runQuery(internal.escalate.dueRungs, {});
    for (const item of due) {
      await ctx.runAction(internal.escalate.escalateRung, {
        rungId: item.rungId,
        caseId: item.caseId,
      });
    }
    return due.length;
  },
});

export const dueRungs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // The lower bound is load-bearing. In Convex, undefined sorts before every
    // number, so a bare .lte("dueAt", now) also matches every active rung whose
    // dueAt is undefined, i.e. every rung with no published deadline. That made
    // the sweep escalate rungs that had no clock at all, and it ran until the
    // 1800s action timeout. gte(1) excludes the undefined bucket.
    const active = await ctx.db
      .query("rungs")
      .withIndex("by_due", (q) =>
        q.eq("state", "active").gte("dueAt", 1).lte("dueAt", now),
      )
      .take(25);
    return active
      .filter((r) => typeof r.dueAt === "number")
      .map((r) => ({ rungId: r._id, caseId: r.caseId }));
  },
});

export const escalateRung = internalAction({
  args: { rungId: v.id("rungs"), caseId: v.id("cases") },
  handler: async (ctx, { rungId, caseId }): Promise<void> => {
    const ctxBundle = await ctx.runQuery(internal.escalate.escalationContext, {
      rungId,
      caseId,
    });
    if (!ctxBundle) return;
    const { kase, rung, nextRung, findings } = ctxBundle;

    // Mark it expired first so a second sweep cannot double-send.
    await ctx.runMutation(internal.cases.setRungState, {
      rungId,
      state: "expired",
      startedAt: rung.startedAt,
      dueAt: rung.dueAt,
    });

    const target = nextRung ?? rung;

    // Re-assert the address shape at the send boundary rather than trusting what
    // was written, and never send to a regulator from the demo control. Falling
    // back to the case owner means a misread page costs a wasted email to
    // yourself, not a burnt first contact with an ombudsman.
    const looksLikeEmail = (s: string | undefined): s is string =>
      !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
    const demo = process.env.LADDER_DEMO === "1";
    const recipient =
      !demo && looksLikeEmail(target.contact) ? target.contact : kase.ownerEmail;

    try {
      const draft = await chatJson<Draft>({
        system: SYSTEM,
        user: `Person's name: ${kase.ownerEmail.split("@")[0]}
Their email: ${kase.ownerEmail}
Counterparty: ${kase.counterparty}
Complaint: ${kase.summary ?? kase.title}
First contacted: ${new Date(kase.createdAt).toDateString()}

The step that has just run out of time:
  ${rung.name} (${rung.authority})
  window: ${rung.clockLabel ?? `${rung.clockDays ?? "unstated"} days`}
  source: ${rung.sourceUrl ?? "not sourced"}

The step this email is for:
  ${target.name} (${target.authority})
  what it is: ${target.action}
  source: ${target.sourceUrl ?? "not sourced"}

Sourced facts you may cite, and nothing else:
${
          findings
            .map(
              (f: { claim: string; quote?: string; sourceUrl: string }) =>
                `- ${f.claim}${f.quote ? ` (quoted: "${f.quote}")` : ""} [${f.sourceUrl}]`,
            )
            .join("\n") || "- none"
        }`,
      });

      await ctx.runMutation(internal.email.sendFromCase, {
        caseId,
        to: recipient,
        subject: draft.subject,
        text: `${draft.body}\n\n---\nSent by Ladder on behalf of ${kase.ownerEmail}. Ladder is not a law firm and does not give legal advice.`,
        rungId: target._id,
      });

      if (nextRung) {
        await ctx.runMutation(internal.cases.setRungState, {
          rungId: nextRung._id,
          state: "active",
          startedAt: Date.now(),
          dueAt: nextRung.clockDays
            ? Date.now() + nextRung.clockDays * 24 * 60 * 60 * 1000
            : undefined,
        });
      }

      await ctx.runMutation(internal.cases.setStatus, {
        caseId,
        status: nextRung ? "escalated" : "ready_to_escalate",
      });
    } catch (e) {
      // The rung was marked expired before the send so two sweeps cannot both
      // fire it. If the draft or send then failed, leaving it expired would
      // remove it from dueRungs forever and the clock would silently stop being
      // watched, which is the one thing this product must never do. Put it back
      // in the queue with a short retry window instead.
      console.error("escalateRung failed, requeueing", e);
      await ctx.runMutation(internal.cases.setRungState, {
        rungId,
        state: "active",
        startedAt: rung.startedAt,
        dueAt: Date.now() + 15 * 60 * 1000,
      });
      await ctx.runMutation(internal.cases.setWorking, {
        caseId,
        working: `Could not send yet, will retry: ${String(e).slice(0, 140)}`,
      });
    }
  },
});

export const escalationContext = internalQuery({
  args: { rungId: v.id("rungs"), caseId: v.id("cases") },
  handler: async (ctx, { rungId, caseId }) => {
    const kase = await ctx.db.get(caseId);
    const rung = await ctx.db.get(rungId);
    if (!kase || !rung) return null;

    const all = await ctx.db
      .query("rungs")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const nextRung =
      all.sort((a, b) => a.order - b.order).find((r) => r.order === rung.order + 1) ??
      null;

    const findings = await ctx.db
      .query("findings")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .take(12);

    return { kase, rung, nextRung, findings };
  },
});
