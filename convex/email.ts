import { v } from "convex/values";
import { AgentMail } from "@agentmail/convex";

declare const process: { env: Record<string, string | undefined> };
import { components, internal } from "./_generated/api";
import { internalMutation, internalAction, action } from "./_generated/server";

// One instance, exported, because the onMessageReceived handle is baked in when
// handleWebhook runs. Constructing a second bare AgentMail elsewhere and mounting
// that one would silently drop every inbound message.
// The explicit annotation breaks the inference cycle: the instance references
// internal.email.onMessageReceived, which lives in this same module.
export const agentmail: AgentMail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.email.onMessageReceived,
});

/**
 * Inbox creation goes straight to the AgentMail REST API rather than through the
 * component client.
 *
 * Why: @agentmail/convex 0.1.0 declares createInbox as an `internalAction` inside
 * the component (src/component/lib.ts:43). A component's internal functions are not
 * callable from the mounting app, so `agentmail.createInbox(ctx, ...)` fails at
 * runtime with "Couldn't resolve agentmail.lib.createInbox". Firecrawl declares its
 * equivalents as public `action`, which is why those resolve fine.
 *
 * Sending and the inbound webhook still go through the component, because
 * enqueueSend and handleEvent are both public mutations.
 */
export const createCaseInbox = internalAction({
  args: { caseId: v.id("cases"), slug: v.string() },
  handler: async (ctx, { caseId, slug }): Promise<string> => {
    const key = process.env.AGENTMAIL_API_KEY;
    if (!key) throw new Error("AGENTMAIL_API_KEY is not set on this deployment");

    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };

    // A pinned inbox always wins, so the deployment is stable across cases.
    const pinned = process.env.LADDER_INBOX_ID;
    if (pinned) {
      await ctx.runMutation(internal.cases.attachInbox, {
        caseId,
        inboxId: pinned,
        inboxEmail: pinned.includes("@") ? pinned : `${pinned}@agentmail.to`,
      });
      return pinned;
    }

    const username = `ladder-${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await fetch("https://api.agentmail.to/v0/inboxes", {
      method: "POST",
      headers,
      body: JSON.stringify({ username, display_name: "Ladder" }),
    });

    if (res.ok) {
      const inbox = (await res.json()) as { inbox_id: string; email: string };
      await ctx.runMutation(internal.cases.attachInbox, {
        caseId,
        inboxId: inbox.inbox_id,
        inboxEmail: inbox.email,
      });
      return inbox.email;
    }

    const errBody = await res.text();
    // The free plan caps inboxes at 3. Rather than dying, fall back to an inbox
    // that already exists and route inbound mail by thread instead of by inbox.
    if (res.status === 403 && errBody.includes("limit_exceeded")) {
      const listRes = await fetch("https://api.agentmail.to/v0/inboxes", {
        headers,
      });
      if (listRes.ok) {
        const body = (await listRes.json()) as {
          inboxes?: Array<{ inbox_id: string; email: string }>;
        };
        const reuse = body.inboxes?.[0];
        if (reuse) {
          console.warn(
            `AgentMail inbox limit reached; reusing ${reuse.email}. Set LADDER_INBOX_ID to pin one.`,
          );
          await ctx.runMutation(internal.cases.attachInbox, {
            caseId,
            inboxId: reuse.inbox_id,
            inboxEmail: reuse.email,
          });
          return reuse.email;
        }
      }
    }

    throw new Error(`AgentMail createInbox ${res.status}: ${errBody.slice(0, 300)}`);
  },
});

// The component calls this with exactly { message, thread, eventId }.
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  handler: async (ctx, { message }) => {
    const inboxId: string | undefined = message.inbox_id;
    if (!inboxId) return;

    // Thread first. An inbox can serve several cases, but a thread belongs to one.
    let kase = null;
    const threadId: string | undefined = message.thread_id;
    if (threadId) {
      const prior = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first();
      if (prior) kase = await ctx.db.get(prior.caseId);
    }

    // Otherwise the newest still-open case on this inbox. Stated plainly because
    // it is a heuristic, not an identification.
    if (!kase) {
      const candidates = await ctx.db
        .query("cases")
        .withIndex("by_inbox", (q) => q.eq("inboxId", inboxId))
        .order("desc")
        .take(10);
      kase = candidates.find((c) => c.status !== "resolved") ?? null;
    }
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

    const messageId = await ctx.db.insert("messages", {
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

    // The send is enqueued, so the thread id does not exist yet. Poll for it:
    // without it, a reply to this thread cannot be matched back to this case and
    // would fall through to the newest-open-case heuristic.
    await ctx.scheduler.runAfter(15_000, internal.email.captureThread, {
      messageId,
      outboundId: outboundId as unknown as string,
      attempt: 0,
    });

    return outboundId;
  },
});

export const captureThread = internalAction({
  args: {
    messageId: v.id("messages"),
    outboundId: v.string(),
    attempt: v.number(),
  },
  handler: async (ctx, { messageId, outboundId, attempt }): Promise<void> => {
    const status = await agentmail.status(
      ctx as any,
      outboundId as unknown as Parameters<typeof agentmail.status>[1],
    );

    if (status?.threadId) {
      await ctx.runMutation(internal.email.attachThread, {
        messageId,
        threadId: status.threadId,
        agentmailMessageId: status.agentmailMessageId ?? undefined,
      });
      return;
    }

    // Sends retry with backoff, so give it a few tries before giving up.
    if (attempt < 5) {
      await ctx.scheduler.runAfter(20_000, internal.email.captureThread, {
        messageId,
        outboundId,
        attempt: attempt + 1,
      });
    } else {
      console.warn(
        `no threadId for outbound ${outboundId} after ${attempt + 1} attempts; replies will fall back to newest-open-case routing`,
      );
    }
  },
});

export const attachThread = internalMutation({
  args: {
    messageId: v.id("messages"),
    threadId: v.string(),
    agentmailMessageId: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, threadId, agentmailMessageId }) => {
    await ctx.db.patch(messageId, { threadId, agentmailMessageId });
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
