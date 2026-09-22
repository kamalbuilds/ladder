import { v } from "convex/values";
import { AgentMail } from "@agentmail/convex";
import { components, internal } from "./_generated/api";
import { internalMutation, internalAction, action } from "./_generated/server";

// One instance, exported, because the onMessageReceived handle is baked in when
// handleWebhook runs. Constructing a second bare AgentMail elsewhere and mounting
// that one would silently drop every inbound message.
export const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.email.onMessageReceived,
});

export const createCaseInbox = internalAction({
  args: { caseId: v.id("cases"), slug: v.string() },
  handler: async (ctx, { caseId, slug }) => {
    const inbox = await agentmail.createInbox(ctx, {
      username: `ladder-${slug}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "Ladder",
    });
    await ctx.runMutation(internal.cases.attachInbox, {
      caseId,
      inboxId: inbox.inbox_id,
      inboxEmail: inbox.email,
    });
    return inbox.email;
  },
});

// The component calls this with exactly { message, thread, eventId }.
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  handler: async (ctx, { message }) => {
    const inboxId: string | undefined = message.inbox_id;
    if (!inboxId) return;

    const kase = await ctx.db
      .query("cases")
      .withIndex("by_inbox", (q) => q.eq("inboxId", inboxId))
      .unique();
    if (!kase) return;

    const text: string = message.text ?? message.preview ?? "";
    const messageId = await ctx.db.insert("messages", {
      caseId: kase._id,
      direction: "inbound",
      from: message.from ?? "unknown",
      to: kase.inboxEmail ?? "",
      subject: message.subject ?? "(no subject)",
      text,
      agentmailMessageId: message.message_id,
      threadId: message.thread_id,
      receivedAt: Date.now(),
    });

    await ctx.db.patch(kase._id, { working: "Reading the reply" });
    await ctx.scheduler.runAfter(0, internal.classify.classifyReply, {
      caseId: kase._id,
      messageId,
    });
  },
});

// Sends and records in one place so the timeline never misses an outbound.
export const sendFromCase = internalMutation({
  args: {
    caseId: v.id("cases"),
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    rungId: v.optional(v.id("rungs")),
  },
  handler: async (ctx, { caseId, to, subject, text, rungId }) => {
    const kase = await ctx.db.get(caseId);
    if (!kase?.inboxId) throw new Error("case has no inbox yet");

    const outboundId = await agentmail.sendMessage(ctx, kase.inboxId, {
      to,
      subject,
      text,
      cc: kase.ownerEmail,
    });

    await ctx.db.insert("messages", {
      caseId,
      direction: "outbound",
      from: kase.inboxEmail ?? "",
      to,
      subject,
      text,
      outboundId: outboundId as unknown as string,
      rungId,
      receivedAt: Date.now(),
    });
    return outboundId;
  },
});

// Exposed so the demo can prove inbound works without waiting on a real sender.
export const inboxAddress = action({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }): Promise<string | null> => {
    const kase = await ctx.runQuery(internal.cases.getInternal, { caseId });
    return kase?.inboxEmail ?? null;
  },
});
