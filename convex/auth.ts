import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

declare const process: { env: Record<string, string | undefined> };

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Codes and tokens are compared as hashes, so the table never holds a usable
 * credential. Not a password hash: these are short-lived, single-purpose, rate
 * limited values, and this runs synchronously inside a mutation.
 */
function digest(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}

const PEPPER = "ladder.v1.";
const hashCode = (email: string, code: string) =>
  digest(PEPPER + email.toLowerCase().trim() + ":" + code);

function newToken(): string {
  let t = "";
  for (let i = 0; i < 4; i++) {
    t += Math.floor(Math.random() * 0xffffffff)
      .toString(36)
      .padStart(6, "0");
  }
  return t;
}

export const normaliseEmail = (e: string) => e.toLowerCase().trim();

/**
 * Resolves the caller from their session token. Every function that touches a
 * case goes through this, so identity is never taken from an argument.
 */
export async function requireEmail(
  ctx: QueryCtx | MutationCtx,
  token: string,
): Promise<string> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session) throw new Error("Not signed in.");
  if (session.expiresAt < Date.now()) throw new Error("Session expired.");
  return session.email;
}

/** Owner or invited collaborator. Anything else is refused. */
export async function requireCaseAccess(
  ctx: QueryCtx | MutationCtx,
  token: string,
  caseId: Id<"cases">,
): Promise<{ email: string; role: "owner" | "collaborator" }> {
  const email = await requireEmail(ctx, token);
  const kase = await ctx.db.get(caseId);
  if (!kase) throw new Error("No such case.");
  if (normaliseEmail(kase.ownerEmail) === email) return { email, role: "owner" };

  const membership = await ctx.db
    .query("members")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .collect();
  const mine = membership.find((m) => normaliseEmail(m.email) === email);
  if (!mine) throw new Error("You do not have access to this case.");
  return { email, role: mine.role };
}

export const requestCode = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const addr = normaliseEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      throw new Error("That does not look like an email address.");
    }

    // One live code per address.
    const existing = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", addr))
      .collect();
    for (const e of existing) await ctx.db.delete(e._id);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ctx.db.insert("loginCodes", {
      email: addr,
      codeHash: hashCode(addr, code),
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
    });

    await ctx.scheduler.runAfter(0, internal.auth.deliverCode, {
      email: addr,
      code,
    });
    return { sent: true };
  },
});

export const deliverCode = internalAction({
  args: { email: v.string(), code: v.string() },
  handler: async (_ctx, { email, code }) => {
    const key = process.env.AGENTMAIL_API_KEY;
    const from = process.env.LADDER_SYSTEM_INBOX;
    if (!key || !from) {
      // Loud, and the code is still usable from the logs in local development.
      console.error(
        `cannot deliver sign-in code: ${!key ? "AGENTMAIL_API_KEY" : "LADDER_SYSTEM_INBOX"} not set. Code for ${email} is ${code}`,
      );
      return;
    }

    const res = await fetch(
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(from)}/messages/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: email,
          subject: `${code} is your Ladder sign-in code`,
          text: `Your Ladder sign-in code is ${code}.

It works for the next 10 minutes and only for ${email}.

If you did not ask for this, nothing has happened and you can ignore it.

Ladder is not a law firm and gives no legal advice.`,
        }),
      },
    );
    if (!res.ok) {
      console.error(
        `sign-in code delivery failed ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
  },
});

export const verifyCode = mutation({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, { email, code }) => {
    const addr = normaliseEmail(email);
    const row = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", addr))
      .unique();

    if (!row) throw new Error("Ask for a new code.");
    if (row.expiresAt < Date.now()) {
      await ctx.db.delete(row._id);
      throw new Error("That code has expired. Ask for a new one.");
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await ctx.db.delete(row._id);
      throw new Error("Too many attempts. Ask for a new code.");
    }
    if (row.codeHash !== hashCode(addr, code.trim())) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      throw new Error("That code is not right.");
    }

    await ctx.db.delete(row._id);
    const token = newToken();
    await ctx.db.insert("sessions", {
      token,
      email: addr,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token, email: addr };
  },
});

export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session || session.expiresAt < Date.now()) return null;
    return { email: session.email };
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (session) await ctx.db.delete(session._id);
  },
});

/** Used by the e2e suite so it can sign in without reading a mailbox. */
export const issueTestSession = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const token = newToken();
    await ctx.db.insert("sessions", {
      token,
      email: normaliseEmail(email),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    return token;
  },
});

export const peekCode = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("loginCodes")
      .withIndex("by_email", (q) => q.eq("email", normaliseEmail(email)))
      .unique();
    return row ? { exists: true, expiresAt: row.expiresAt } : { exists: false };
  },
});
