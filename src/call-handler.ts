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

export class CallHandler {
  private streamSid = "";
  private dgConnection: ListenLiveClient | null = null;
  private conversationHistory: HistoryMessage[] = [];
  private isSpeaking = false;
  private callSummary: string[] = [];
  private callerPhone = "unknown";
  private bookingLinkSent = false;

  constructor(private readonly ws: WebSocket) {}

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

    this.dgConnection = createLiveSTT(async (transcript) => {
      await this.onTranscript(transcript);
    });

    this.isSpeaking = true;
    try {
      await speak("Thanks for calling Deer Valley Driving School. How can I help you today?", (audio) => {
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

    const response = await chat(this.conversationHistory);
    this.conversationHistory.push({ role: "assistant", content: response });
    this.callSummary.push(`Cadence: ${response}`);

    if (!this.bookingLinkSent && this.callerPhone !== "unknown" && BOOKING_LINK_REGEX.test(response)) {
      this.bookingLinkSent = true;
      try {
        await sendBookingLink(this.callerPhone);
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

    try {
      await sendCallSummary(this.callerPhone, this.callSummary.slice(-10));
    } catch (err) {
      console.error(`[CALL:${this.streamSid}] summary sms failed`, err);
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
