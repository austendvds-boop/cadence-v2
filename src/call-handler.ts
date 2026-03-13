import WebSocket from "ws";
import { ListenLiveClient } from "@deepgram/sdk";
import { createLiveSTT } from "./stt";
import { chat } from "./llm";
import { speak } from "./tts";
import { sendBookingLink, sendCallSummary } from "./sms";

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

const BOOKING_LINK_REGEX = /(text|send).*(link)|(link).*(text|send)/i;
const TRANSFER_MARKER = "[TRANSFER]";

export interface ClientConfig {
  clientId: string;
  businessName: string;
  systemPrompt: string;
  transferNumber: string | null;
  greeting: string;
  smsEnabled: boolean;
  bookingUrl: string | null;
  ownerPhone: string | null;
  twilioNumber: string;
}

export class CallHandler {
  private streamSid = "";
  private callSid = "";
  private dgConnection: ListenLiveClient | null = null;
  private conversationHistory: HistoryMessage[] = [];
  private isSpeaking = false;
  private callSummary: string[] = [];
  private callerPhone = "unknown";
  private bookingLinkSent = false;
  private callStartedAt = new Date();

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
    this.callSid = msg.start?.callSid || "";
    const params = msg.start?.customParameters || {};
    this.callerPhone = params.from || params.From || params.caller || "unknown";
    this.callStartedAt = new Date();

    this.dgConnection = createLiveSTT(async (transcript) => {
      await this.onTranscript(transcript);
    });

    this.isSpeaking = true;
    try {
      await speak(this.client.greeting, (audio) => {
        this.sendAudio(audio);
      });
    } catch (err) {
      console.error(`[CALL:${this.streamSid}] greeting tts failed`, err);
    } finally {
      this.isSpeaking = false;
    }

    // Send booking link immediately on pickup — don't wait for LLM to decide
    if (
      !this.bookingLinkSent &&
      this.client.smsEnabled &&
      !!this.client.bookingUrl &&
      this.callerPhone !== "unknown"
    ) {
      this.bookingLinkSent = true;
      try {
        await sendBookingLink(this.callerPhone, this.client.twilioNumber, this.client.bookingUrl);
      } catch (err) {
        console.error(`[CALL:${this.streamSid}] pickup booking link sms failed`, err);
      }
    }
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
    if (!transcript.trim()) return;

    console.log(`[CALL:${this.streamSid}] caller: ${transcript}`);
    this.callSummary.push(`Caller: ${transcript}`);
    this.conversationHistory.push({ role: "user", content: transcript });

    const response = await chat(this.client.systemPrompt, this.conversationHistory);
    this.conversationHistory.push({ role: "assistant", content: response });
    this.callSummary.push(`Cadence: ${response}`);

    if (
      !this.bookingLinkSent &&
      this.client.smsEnabled &&
      !!this.client.bookingUrl &&
      this.callerPhone !== "unknown" &&
      BOOKING_LINK_REGEX.test(response)
    ) {
      this.bookingLinkSent = true;
      try {
        await sendBookingLink(this.callerPhone, this.client.twilioNumber, this.client.bookingUrl);
      } catch (err) {
        console.error(`[CALL:${this.streamSid}] booking link sms failed`, err);
      }
    }

    if (response.includes(TRANSFER_MARKER)) {
      const spokenResponse = response.replace(TRANSFER_MARKER, "").trim();

      this.isSpeaking = true;
      try {
        await speak(spokenResponse, (audio) => this.sendAudio(audio));
      } catch (err) {
        console.error(`[CALL:${this.streamSid}] transfer tts failed`, err);
      } finally {
        this.isSpeaking = false;
      }

      await this.forwardCall();
      return;
    }

    this.isSpeaking = true;
    try {
      await speak(response, (audio) => this.sendAudio(audio));
    } catch (err) {
      console.error(`[CALL:${this.streamSid}] response tts failed`, err);
    } finally {
      this.isSpeaking = false;
    }
  }

  private async onStop(): Promise<void> {
    try {
      this.dgConnection?.finish();
      this.dgConnection = null;
    } catch (err) {
      console.error(`[CALL:${this.streamSid}] stt close failed`, err);
    }

    if (this.client.ownerPhone) {
      try {
        const summaryLines = this.callSummary
          .slice(-8)
          .map(l => l.length > 120 ? l.slice(0, 117) + "..." : l);
        await sendCallSummary(
          this.callerPhone,
          summaryLines,
          this.client.ownerPhone,
          this.client.twilioNumber,
          this.client.businessName
        );
      } catch (err) {
        console.error(`[CALL:${this.streamSid}] summary sms failed`, err);
      }
    }

    await emitCallEnded({
      client: this.client,
      streamSid: this.streamSid,
      callerPhone: this.callerPhone,
      startedAt: this.callStartedAt,
      endedAt: new Date(),
      conversationHistory: [...this.conversationHistory],
      callSummary: [...this.callSummary]
    });
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

  private async forwardCall(): Promise<void> {
    if (!this.callSid) {
      console.error(`[CALL:${this.streamSid}] cannot forward — no callSid`);
      return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      console.error(`[CALL:${this.streamSid}] cannot forward — missing Twilio credentials`);
      return;
    }

    const forwardTo = this.client.transferNumber || "+16026633502";
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${forwardTo}</Dial></Response>`;

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const form = new URLSearchParams({ Twiml: twiml });

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${this.callSid}.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: form.toString()
        }
      );
      if (!res.ok) {
        const body = await res.text();
        console.error(`[CALL:${this.streamSid}] forward failed ${res.status}: ${body}`);
      } else {
        console.log(`[CALL:${this.streamSid}] forwarded to ${forwardTo}`);
      }
    } catch (err) {
      console.error(`[CALL:${this.streamSid}] forward error`, err);
    }
  }
}

export interface CallEndedEvent {
  client: ClientConfig;
  streamSid: string;
  callerPhone: string;
  startedAt: Date;
  endedAt: Date;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  callSummary: string[];
}

export type CallEndedHook = (event: CallEndedEvent) => Promise<void> | void;

let callEndedHook: CallEndedHook | null = null;

export function setCallEndedHook(hook: CallEndedHook | null): void {
  callEndedHook = hook;
}

async function emitCallEnded(event: CallEndedEvent): Promise<void> {
  if (!callEndedHook) return;

  try {
    await callEndedHook(event);
  } catch (err) {
    console.error(`[CALL:${event.streamSid}] call end hook failed`, err);
  }
}
