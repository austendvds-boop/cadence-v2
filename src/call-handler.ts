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
        await sendCallSummary(
          this.callerPhone,
          this.callSummary.slice(-10),
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
