import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { chatJson } from "./llm";

type Verdict = {
  replyKind:
    | "substantive_answer"
    | "holding_acknowledgement"
    | "final_response"
    | "fob_off"
    | "auto_reply"
    | "unrelated";
  reason: string;
  startsClock: boolean;
  clockDays?: number;
  clockLabel?: string;
};

const SYSTEM = `You read replies sent to someone whose complaint is being ignored, and
you decide what kind of reply it actually is. You are not a lawyer and you give no
legal advice.

The distinction that matters, and that people get wrong:

- "substantive_answer": actually addresses the complaint, with a decision or an outcome.
- "holding_acknowledgement": confirms receipt, promises to look into it, gives a
  reference number or a target date. It feels like progress and is not. This is the
  single most common reply and it is the reason people miss their deadline.
- "final_response": the organisation's last word, sometimes called a final response
  letter, deadlock letter, or final viewpoint. This usually UNLOCKS an ombudsman,
  so it matters enormously.
- "fob_off": redirects the person elsewhere, denies responsibility, or answers a
  question that was not asked, without resolving anything.
- "auto_reply": out of office, no-reply autoresponder, mailbox notice.
- "unrelated": nothing to do with this complaint.

startsClock is true when the reply itself starts or resets a published window the
person now has to act within, for example a final response opening an ombudsman
window, or a stated response target. Only set clockDays when the reply or the case
states a real number. Never invent one.

Return JSON: { "replyKind", "reason", "startsClock", "clockDays"?, "clockLabel"? }
"reason" is one plain sentence a non-lawyer would understand.`;

export const classifyReply = internalAction({
  args: { caseId: v.id("cases"), messageId: v.id("messages") },
  handler: async (ctx, { caseId, messageId }) => {
    const bundle = await ctx.runQuery(internal.classify.messageContext, {
      caseId,
      messageId,
    });
    if (!bundle) return;

    try {
      const verdict = await chatJson<Verdict>({
        system: SYSTEM,
        user: `The complaint is against: ${bundle.counterparty}
What it is about: ${bundle.summary ?? bundle.title}
The rung they are currently on: ${bundle.activeRung ?? "unknown"}

The reply that just arrived:
From: ${bundle.from}
Subject: ${bundle.subject}

${bundle.text.slice(0, 6000)}`,
      });

      await ctx.runMutation(internal.classify.applyVerdict, {
        caseId,
        messageId,
        replyKind: verdict.replyKind,
        replyReason: verdict.reason,
        startsClock: !!verdict.startsClock,
        clockDays: verdict.clockDays,
        clockLabel: verdict.clockLabel,
      });
    } catch (e) {
      console.error("classifyReply failed", e);
      await ctx.runMutation(internal.cases.setWorking, {
        caseId,
        working: `Could not read that reply: ${String(e).slice(0, 140)}`,
      });
    }
  },
});

export const messageContext = internalQuery({
  args: { caseId: v.id("cases"), messageId: v.id("messages") },
  handler: async (ctx, { caseId, messageId }) => {
    const kase = await ctx.db.get(caseId);
    const msg = await ctx.db.get(messageId);
    if (!kase || !msg) return null;

    const rungs = await ctx.db
      .query("rungs")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    const active = rungs
      .sort((a, b) => a.order - b.order)
      .find((r) => r.state === "active");

    return {
      counterparty: kase.counterparty,
      title: kase.title,
      summary: kase.summary,
      activeRung: active ? `${active.name} (${active.authority})` : undefined,
      from: msg.from,
      subject: msg.subject,
      text: msg.text,
    };
  },
});

export const applyVerdict = internalMutation({
  args: {
    caseId: v.id("cases"),
    messageId: v.id("messages"),
    replyKind: v.union(
      v.literal("substantive_answer"),
      v.literal("holding_acknowledgement"),
      v.literal("final_response"),
      v.literal("fob_off"),
      v.literal("auto_reply"),
      v.literal("unrelated"),
    ),
    replyReason: v.string(),
    startsClock: v.boolean(),
    clockDays: v.optional(v.number()),
    clockLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rungs = await ctx.db
      .query("rungs")
      .withIndex("by_case", (q) => q.eq("caseId", args.caseId))
      .collect();
    const ordered = rungs.sort((a, b) => a.order - b.order);
    const active = ordered.find((r) => r.state === "active");

    await ctx.db.patch(args.messageId, {
      replyKind: args.replyKind,
      replyReason: args.replyReason,
      startsClock: args.startsClock,
      rungId: active?._id,
    });

    // A final response is the thing that unlocks the next authority. A holding
    // acknowledgement deliberately changes nothing, which is the whole point.
    if (args.replyKind === "final_response" && active) {
      await ctx.db.patch(active._id, { state: "cleared" });
      const next = ordered.find((r) => r.order === active.order + 1);
      if (next) {
        const days = args.clockDays ?? next.clockDays;
        await ctx.db.patch(next._id, {
          state: "active",
          startedAt: Date.now(),
          dueAt: days ? Date.now() + days * 24 * 60 * 60 * 1000 : undefined,
          clockLabel: args.clockLabel ?? next.clockLabel,
        });
      }
      await ctx.db.patch(args.caseId, {
        status: "ready_to_escalate",
        working: undefined,
      });
      return;
    }

    if (args.replyKind === "substantive_answer") {
      await ctx.db.patch(args.caseId, { status: "resolved", working: undefined });
      if (active) await ctx.db.patch(active._id, { state: "cleared" });
      return;
    }

    await ctx.db.patch(args.caseId, { working: undefined });
  },
});
