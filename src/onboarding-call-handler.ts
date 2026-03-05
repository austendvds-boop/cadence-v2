import WebSocket from "ws";
import { ListenLiveClient } from "@deepgram/sdk";
import { createLiveSTT } from "./stt";
import { chat } from "./llm";
import { speak } from "./tts";
import { send_signup_link } from "./onboarding-tools";
import { onboardingSessionStore } from "./onboarding-session-store";
import type { ClientConfig } from "./call-handler";

type HistoryMessage = { role: "user" | "assistant"; content: string };

type TwilioMessage = {
  event: "connected" | "start" | "media" | "stop";
  streamSid?: string;
  media?: { payload?: string };
  start?: {
    streamSid?: string;
    callSid?: string;
    customParameters?: Record<string, string>;
  };
};

type OnboardingStage = "greeting" | "demo";

const SALES_DEMO_GREETING =
  "Hey! Thanks for calling Automate. I'm Cadence — I'm actually an AI receptionist, and I'm here to show you exactly what I can do for your business. Got any questions for me?";

const SALES_DEMO_SIGNUP_LINE =
  "Awesome! I'll text you a link to get set up — it takes about 5 minutes. You'll fill out some info about your business and we'll have your own Cadence up and running.";

const SIGNUP_INTENT_REGEX =
  /\b(sign\s?up|signup|get started|let'?s do it|i\s*'?m in|ready to start|ready to sign up|send (me )?(the )?link|text (me )?(the )?link|where do i start|how do i start|how do i sign up|set me up)\b/i;

const SALES_DEMO_SYSTEM_PROMPT = `You are Cadence, a live SALES DEMO voice agent for the company Autom8.
In spoken conversation, always say "Automate" (never "Autom8").
You are NOT collecting intake details anymore.

Conversation rules:
- 2-3 short sentences max per turn.
- Casual, friendly, confident, and natural.
- No markdown, bullets, JSON, or stage directions.
- Handle objections conversationally without sounding scripted.
- Your personality is the product demo — be helpful, sharp, and warm.

What to explain:
- You answer calls 24/7.
- You handle common customer questions.
- You text customers links to the business website.
- You forward important calls to the owner/team.

Pricing response (say this when asked about price):
"$199 a month, includes call handling, SMS to your customers, and call forwarding. Booking integration is available as an add-on."

If the caller says they're ready to sign up, respond exactly with:
"${SALES_DEMO_SIGNUP_LINE}"`;

function normalizeSpeech(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "Sorry, I missed that. Could you say that one more time?";
  }

  return collapsed.replace(/\bautom8\b/gi, "Automate");
}

function isSignupIntent(text: string): boolean {
  return SIGNUP_INTENT_REGEX.test(text);
}

export class OnboardingCallHandler {
  private streamSid = "";
  private callSid = "";
  private callerPhone = "unknown";
  private dgConnection: ListenLiveClient | null = null;
  private conversationHistory: HistoryMessage[] = [];
  private isSpeaking = false;
  private stage: OnboardingStage = "greeting";
  private signupLinkSent = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly client: ClientConfig
  ) {}

  async handleMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as TwilioMessage;

    switch (msg.event) {
      case "start":
        await this.onStart(msg);
        break;
      case "media":
        this.onMedia(msg);
        break;
      case "stop":
        await this.onStop();
        break;
      default:
        break;
    }
  }

  private async onStart(msg: TwilioMessage): Promise<void> {
    this.streamSid = msg.start?.streamSid || msg.streamSid || "unknown";
    this.callSid = msg.start?.callSid || this.streamSid;

    const params = msg.start?.customParameters || {};
    this.callerPhone = params.from || params.From || params.caller || "unknown";

    await onboardingSessionStore.ensureSession({
      clientId: this.client.clientId,
      callSid: this.callSid,
      streamSid: this.streamSid,
      callerPhone: this.callerPhone
    });

    await onboardingSessionStore.setStatus(this.callSid, "greeting");

    this.dgConnection = createLiveSTT(async (transcript) => {
      await this.onTranscript(transcript);
    });

    this.stage = "demo";
    await onboardingSessionStore.setStatus(this.callSid, "interview");

    await this.speakText(SALES_DEMO_GREETING);
  }

  private onMedia(msg: TwilioMessage): void {
    if (this.isSpeaking || !this.dgConnection) return;

    const payload = msg.media?.payload;
    if (!payload) return;

    const audioBytes = Buffer.from(payload, "base64");
    const arrayBuffer = audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength);
    this.dgConnection.send(arrayBuffer);
  }

  private async onTranscript(transcript: string): Promise<void> {
    const callerText = transcript.trim();
    if (!callerText) return;

    this.conversationHistory.push({ role: "user", content: callerText });

    if (this.stage !== "demo") {
      return;
    }

    if (isSignupIntent(callerText)) {
      await this.handleSignupLink();
      return;
    }

    const response = await chat(SALES_DEMO_SYSTEM_PROMPT, this.conversationHistory.slice(-12));
    await this.speakText(response);
  }

  private async handleSignupLink(): Promise<void> {
    if (this.signupLinkSent) {
      await this.speakText("I already sent it over. Check your texts, and if you want, I can answer anything else right now.");
      return;
    }

    const result = await send_signup_link({
      callSid: this.callSid,
      callerPhone: this.callerPhone,
      fromPhone: this.client.twilioNumber
    });

    if (!result.ok) {
      if (result.status === "missing_caller_phone") {
        await this.speakText(
          "I'm ready to text the signup link, but caller ID didn't come through on this line. Send a quick text to this number and we'll reply with your setup link right away."
        );
        return;
      }

      await this.speakText("I hit a quick SMS hiccup. Try again in a moment and I'll send it right away.");
      return;
    }

    this.signupLinkSent = true;
    await this.speakText(SALES_DEMO_SIGNUP_LINE);
  }

  private async onStop(): Promise<void> {
    try {
      this.dgConnection?.finish();
      this.dgConnection = null;
    } catch (err) {
      console.error(`[ONBOARDING:${this.streamSid}] stt close failed`, err);
    }
  }

  private async speakText(text: string): Promise<void> {
    const spoken = normalizeSpeech(text);
    this.conversationHistory.push({ role: "assistant", content: spoken });

    this.isSpeaking = true;
    try {
      await speak(spoken, (audio) => this.sendAudio(audio));
    } catch (err) {
      console.error(`[ONBOARDING:${this.streamSid}] tts failed`, err);
    } finally {
      this.isSpeaking = false;
    }
  }

  private sendAudio(base64Payload: string): void {
    if (!this.streamSid || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: base64Payload }
      })
    );
  }
}
