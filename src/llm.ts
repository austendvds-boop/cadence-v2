type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

async function callChatApi(endpoint: string, apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, messages, max_tokens: 200, temperature: 0.7 }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`chat api failed ${response.status}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty llm response");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export async function chat(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): Promise<string> {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...history];

  try {
    return await callChatApi(
      GROQ_ENDPOINT,
      process.env.GROQ_API_KEY || "",
      process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages
    );
  } catch {
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error("missing OPENAI_API_KEY");
      return await callChatApi(
        OPENAI_ENDPOINT,
        process.env.OPENAI_API_KEY,
        process.env.OPENAI_MODEL || "gpt-4o",
        messages
      );
    } catch {
      return "I'm sorry, I didn't catch that. Could you repeat that?";
    }
  }
}
