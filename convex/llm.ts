"use node";
// Kept out of the default runtime only for clarity of intent; fetch works in both.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export type ChatOpts = {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
};

/**
 * Single place every OpenAI call goes through, so a missing key fails loudly and
 * identically everywhere rather than silently degrading into invented content.
 */
export async function chatJson<T>(opts: ChatOpts): Promise<T> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set on this deployment. Set it with: npx convex env set OPENAI_API_KEY sk-...",
    );
  }

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      max_tokens: opts.maxTokens ?? 1600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("OpenAI returned no message content");
  }
  return JSON.parse(content) as T;
}
