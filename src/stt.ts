import { createClient, LiveTranscriptionEvents, ListenLiveClient } from "@deepgram/sdk";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

export function createLiveSTT(onTranscript: (text: string) => Promise<void> | void): ListenLiveClient {
  const client = createClient(requireEnv("DEEPGRAM_API_KEY"));
  const connection = client.listen.live({
    model: "nova-2",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    punctuate: true,
    smart_format: true,
    utterance_end_ms: 1000
  });

  let finalBuffer = "";

  connection.on(LiveTranscriptionEvents.Transcript, async (event) => {
    const text = event.channel.alternatives[0]?.transcript?.trim();
    if (!text) return;
    if (event.is_final) {
      finalBuffer = finalBuffer ? `${finalBuffer} ${text}` : text;
    }
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
    const utterance = finalBuffer.trim();
    finalBuffer = "";
    if (!utterance) return;
    await onTranscript(utterance);
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("[STT] deepgram error", err);
  });

  return connection;
}
