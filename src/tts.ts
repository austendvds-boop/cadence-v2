import WebSocket from "ws";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

const AURA_WS_URL = "wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none";

export async function speak(text: string, sendAudio: (base64Payload: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(AURA_WS_URL, {
      headers: { Authorization: `Token ${requireEnv("DEEPGRAM_API_KEY")}` }
    });

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "Speak", text }));
      ws.send(JSON.stringify({ type: "Flush" }));
      ws.send(JSON.stringify({ type: "Close" }));
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const payload = Buffer.from(data as Buffer).toString("base64");
      sendAudio(payload);
    });

    ws.on("error", (err) => reject(err));
    ws.on("close", () => resolve());
  });
}
