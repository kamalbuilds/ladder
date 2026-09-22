import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A rung is one step on an escalation ladder: "stage 1 complaint", "the ombudsman".
// state moves locked -> active -> (cleared | expired). A rung unlocks when the rung
// below it expires or is answered unsatisfactorily.
export const rungState = v.union(
  v.literal("locked"),
  v.literal("active"),
  v.literal("cleared"),
  v.literal("expired"),
);

export const caseStatus = v.union(
  v.literal("mapping"),
  v.literal("waiting"),
  v.literal("ready_to_escalate"),
  v.literal("escalated"),
  v.literal("resolved"),
);

export default defineSchema({
  // Sign-in codes, posted to the address being claimed. Stored hashed so a database
  // read does not hand someone a working code.
  loginCodes: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
  }).index("by_email", ["email"]),

  sessions: defineTable({
    token: v.string(),
    email: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_email", ["email"]),

  // Someone else invited onto a case: a partner, a flatmate, an advice worker.
  // They see the same board update live.
  members: defineTable({
    caseId: v.id("cases"),
    email: v.string(),
    role: v.union(v.literal("owner"), v.literal("collaborator")),
    invitedBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_case", ["caseId"])
    .index("by_email", ["email"]),

  cases: defineTable({
    title: v.string(),
    counterparty: v.string(),
    counterpartyUrl: v.optional(v.string()),
    // The user's own address, so we can keep them copied in.
    ownerEmail: v.string(),
    // AgentMail inbox dedicated to this case. Every reply lands here.
    inboxId: v.optional(v.string()),
    inboxEmail: v.optional(v.string()),
    status: caseStatus,
    summary: v.optional(v.string()),
    // Set while a crawl or a model call is in flight, so the UI can show it live.
    working: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerEmail"])
    .index("by_inbox", ["inboxId"]),

  // The escalation ladder itself, discovered per case rather than hardcoded.
  rungs: defineTable({
    caseId: v.id("cases"),
    order: v.number(),
    name: v.string(),
    authority: v.string(),
    // What the user has to do, in their own words.
    action: v.string(),
    // Where to send it, when we found a real address.
    contact: v.optional(v.string()),
    // The statutory or published window, in days, and where we read it.
    clockDays: v.optional(v.number()),
    clockLabel: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    state: rungState,
    startedAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
  })
    .index("by_case", ["caseId", "order"])
    .index("by_due", ["state", "dueAt"]),

  // Evidence log. Every jurisdiction claim carries the page it was read from,
  // so nothing in the UI is an unsourced assertion.
  findings: defineTable({
    caseId: v.id("cases"),
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
    createdAt: v.number(),
  }).index("by_case", ["caseId"]),

  // Pages Ladder relied on when it built the ladder. Organisations rewrite their
  // complaints procedure quietly, and when they do the deadline you are relying on
  // changes underneath you. These get re-read and diffed.
  watches: defineTable({
    caseId: v.id("cases"),
    url: v.string(),
    label: v.string(),
    contentHash: v.string(),
    excerpt: v.string(),
    lastCheckedAt: v.number(),
    lastChangedAt: v.optional(v.number()),
    changeSummary: v.optional(v.string()),
    changeMatters: v.optional(v.boolean()),
  })
    .index("by_case", ["caseId"])
    .index("by_checked", ["lastCheckedAt"]),

  messages: defineTable({
    caseId: v.id("cases"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    from: v.string(),
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    agentmailMessageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    outboundId: v.optional(v.string()),
    // Which rung this message belongs to, once we know.
    rungId: v.optional(v.id("rungs")),
    // Filled by the classifier for inbound mail.
    replyKind: v.optional(
      v.union(
        v.literal("substantive_answer"),
        v.literal("holding_acknowledgement"),
        v.literal("final_response"),
        v.literal("fob_off"),
        v.literal("auto_reply"),
        v.literal("unrelated"),
      ),
    ),
    replyReason: v.optional(v.string()),
    startsClock: v.optional(v.boolean()),
    receivedAt: v.number(),
  })
    .index("by_case", ["caseId", "receivedAt"])
    .index("by_agentmail_id", ["agentmailMessageId"])
    // Inbound routing key. Cases can share one AgentMail inbox on the free plan,
    // so the thread is what actually identifies which case a reply belongs to.
    .index("by_thread", ["threadId"]),
});
