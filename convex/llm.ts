// The Convex runtime exposes process.env without pulling in all of @types/node.
declare const process: { env: Record<string, string | undefined> };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Cheap on purpose. Classification and ladder-building are both short structured
// tasks, and this keeps a full end-to-end test in the low cents.
const DEFAULT_MODEL = "openai/gpt-4o-mini";

export type ChatOpts = {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
};

/**
 * Single place every model call goes through, so a missing key fails loudly and
 * identically everywhere rather than silently degrading into invented content.
 *
 * Routed through OpenRouter to an OpenAI model. The generation is OpenAI's; the
 * billing and routing are OpenRouter's.
 */
export async function chatJson<T>(opts: ChatOpts): Promise<T> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set on this deployment. Set it with: npx convex env set OPENROUTER_API_KEY ...",
    );
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://ladder.convex.site",
      "X-Title": "Ladder",
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 1600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(
      `OpenRouter ${res.status}: ${(await res.text()).slice(0, 400)}`,
    );
  }

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Model returned no content: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    // Some models fence the JSON even in json_object mode.
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Model did not return JSON: ${content.slice(0, 200)}`);
    return JSON.parse(m[0]) as T;
  }
}
