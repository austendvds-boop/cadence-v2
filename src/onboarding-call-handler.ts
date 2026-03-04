import WebSocket from "ws";
import { ListenLiveClient } from "@deepgram/sdk";
import { createLiveSTT } from "./stt";
import { chat } from "./llm";
import { speak } from "./tts";
import { complete_onboarding, save_onboarding_field } from "./onboarding-tools";
import {
  onboardingSessionStore,
  type OnboardingFieldName,
  ONBOARDING_FIELD_NAMES
} from "./onboarding-session-store";
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

type OnboardingStage = "greeting" | "interview" | "confirm" | "provision" | "done";

const INTERVIEW_FIELD_ORDER: OnboardingFieldName[] = [
  "business_name",
  "type",
  "hours",
  "services",
  "faqs",
  "transfer_number",
  "email"
];

const FIELD_LABELS: Record<OnboardingFieldName, string> = {
  business_name: "business name",
  type: "business type",
  hours: "hours",
  services: "services",
  faqs: "frequently asked questions",
  transfer_number: "transfer number",
  email: "email"
};

const FIELD_PROMPTS: Record<OnboardingFieldName, string> = {
  business_name: "What is your business name?",
  type: "What type of business do you run?",
  hours: "What are your normal business hours?",
  services: "What are the main services you want callers to hear about?",
  faqs: "What are the top questions callers ask and how should Cadence answer them?",
  transfer_number: "What number should calls transfer to when someone asks for a human? You can say skip if you don't want transfers.",
  email: "What's the best email for setup updates and receipts?"
};

const CONFIRM_YES_REGEX = /\b(yes|yep|yeah|correct|sounds good|looks good|confirm|proceed|do it|go ahead)\b/i;
const CONFIRM_NO_REGEX = /\b(no|nope|change|edit|update|fix|wrong|not right)\b/i;
const TRANSFER_SKIP_REGEX = /\b(skip|none|no transfer|don't transfer|do not transfer|n\/a)\b/i;

const ONBOARDING_TONE_PROMPT = `You are Cadence, a friendly onboarding specialist helping a business owner set up a phone receptionist.
Speak casually, warm, and confident.
Keep every reply to one or two short sentences.
Always end with a clear next question or action.
Never output markdown, JSON, bullet points, or stage directions.`;

function normalizeSpeech(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed || "Sorry, I missed that. Could you say it one more time?";
}

function detectFieldMention(text: string): OnboardingFieldName | null {
  const input = text.toLowerCase();

  if (/business name|company name|name of (the )?business/.test(input)) return "business_name";
  if (/business type|industry|type of business/.test(input)) return "type";
  if (/hours|open|schedule|availability/.test(input)) return "hours";
  if (/services|offerings|what we do/.test(input)) return "services";
  if (/faq|questions|common questions/.test(input)) return "faqs";
  if (/transfer|forward|live person|human/.test(input)) return "transfer_number";
  if (/email|e-mail/.test(input)) return "email";

  return null;
}

export class OnboardingCallHandler {
  private streamSid = "";
  private callSid = "";
  private callerPhone = "unknown";
  private dgConnection: ListenLiveClient | null = null;
  private conversationHistory: HistoryMessage[] = [];
  private isSpeaking = false;
  private stage: OnboardingStage = "greeting";
  private fieldCursor = 0;
  private pendingCorrectionField: OnboardingFieldName | null = null;

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

    this.stage = "interview";
    await onboardingSessionStore.setStatus(this.callSid, "interview");

    await this.speakText(
      "Hey! Thanks for calling Cadence onboarding. I'll ask a few quick questions so we can set up your line. " +
        FIELD_PROMPTS.business_name
    );
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

    if (this.stage === "done" || this.stage === "provision") {
      return;
    }

    if (this.stage === "confirm") {
      await this.handleConfirmTurn(callerText);
      return;
    }

    await this.handleInterviewTurn(callerText);
  }

  private async handleInterviewTurn(callerText: string): Promise<void> {
    const currentField = INTERVIEW_FIELD_ORDER[this.fieldCursor];
    if (!currentField) {
      this.stage = "confirm";
      await onboardingSessionStore.setStatus(this.callSid, "confirm");
      await this.promptConfirmation();
      return;
    }

    const normalizedValue = this.normalizeCapturedValue(currentField, callerText);
    const saveResult = await save_onboarding_field({
      callSid: this.callSid,
      field: currentField,
      value: normalizedValue
    });

    if (!saveResult.ok) {
      await this.speakText(`I didn't catch your ${FIELD_LABELS[currentField]}. ${FIELD_PROMPTS[currentField]}`);
      return;
    }

    this.fieldCursor += 1;

    const nextField = INTERVIEW_FIELD_ORDER[this.fieldCursor];
    if (!nextField) {
      this.stage = "confirm";
      await onboardingSessionStore.setStatus(this.callSid, "confirm");
      await this.promptConfirmation();
      return;
    }

    const followUp = await this.generateInterviewFollowUp(callerText, currentField, normalizedValue, nextField);
    await this.speakText(followUp);
  }

  private async generateInterviewFollowUp(
    callerText: string,
    capturedField: OnboardingFieldName,
    capturedValue: string,
    nextField: OnboardingFieldName
  ): Promise<string> {
    const systemPrompt = `${ONBOARDING_TONE_PROMPT}
You just captured ${FIELD_LABELS[capturedField]} as: "${capturedValue}".
Now ask for ${FIELD_LABELS[nextField]}.
Use natural conversational language.`;

    const response = await chat(systemPrompt, this.conversationHistory.slice(-6));
    const spoken = normalizeSpeech(response);

    if (/could you repeat/i.test(spoken) || spoken.length < 8) {
      return FIELD_PROMPTS[nextField];
    }

    const hasQuestion = spoken.includes("?");
    if (hasQuestion) return spoken;

    return `${spoken} ${FIELD_PROMPTS[nextField]}`;
  }

  private async handleConfirmTurn(callerText: string): Promise<void> {
    if (this.pendingCorrectionField) {
      const normalizedValue = this.normalizeCapturedValue(this.pendingCorrectionField, callerText);
      await save_onboarding_field({
        callSid: this.callSid,
        field: this.pendingCorrectionField,
        value: normalizedValue
      });
      this.pendingCorrectionField = null;
      await this.promptConfirmation();
      return;
    }

    if (CONFIRM_YES_REGEX.test(callerText)) {
      await this.startProvisioning();
      return;
    }

    const requestedField = detectFieldMention(callerText);
    if (requestedField) {
      this.pendingCorrectionField = requestedField;
      await this.speakText(`Got it. What's the updated ${FIELD_LABELS[requestedField]}?`);
      return;
    }

    if (CONFIRM_NO_REGEX.test(callerText)) {
      await this.speakText(
        "No problem. Tell me which detail to change: business name, type, hours, services, FAQs, transfer number, or email."
      );
      return;
    }

    await this.speakText("Say yes to start provisioning, or tell me which detail you'd like to change.");
  }

  private async promptConfirmation(): Promise<void> {
    const session = await onboardingSessionStore.getSession(this.callSid);
    if (!session) {
      await this.speakText("I lost the onboarding details. Let's restart with your business name.");
      this.stage = "interview";
      this.fieldCursor = 0;
      return;
    }

    const summaryParts = ONBOARDING_FIELD_NAMES.map((field) => {
      const value = session.fields[field] || "not provided";
      return `${FIELD_LABELS[field]}: ${value}`;
    }).join("; ");

    const systemPrompt = `${ONBOARDING_TONE_PROMPT}
You're at the confirmation step.
Read back these captured details naturally and ask for yes/no confirmation to start provisioning.
Captured details: ${summaryParts}`;

    const response = await chat(systemPrompt, this.conversationHistory.slice(-6));
    const spoken = normalizeSpeech(response);

    if (/could you repeat/i.test(spoken) || spoken.length < 12) {
      await this.speakText(
        `Awesome, here's what I captured: ${summaryParts}. Say yes to start provisioning now, or tell me what to change.`
      );
      return;
    }

    await this.speakText(spoken);
  }

  private async startProvisioning(): Promise<void> {
    this.stage = "provision";

    const result = await complete_onboarding({ callSid: this.callSid });

    if (!result.ok) {
      if (result.status === "missing_fields" && result.missingFields && result.missingFields.length > 0) {
        const nextMissing = result.missingFields[0];
        const nextIndex = INTERVIEW_FIELD_ORDER.indexOf(nextMissing);

        this.stage = "interview";
        this.fieldCursor = nextIndex >= 0 ? nextIndex : 0;
        await onboardingSessionStore.setStatus(this.callSid, "interview");

        await this.speakText(
          `I still need one more detail before provisioning. ${FIELD_PROMPTS[nextMissing]}`
        );
        return;
      }

      this.stage = "confirm";
      await onboardingSessionStore.setStatus(this.callSid, "failed", {
        provisionError: result.message
      });
      await this.speakText("I hit a snag starting provisioning. Let's confirm the details and try again.");
      return;
    }

    this.stage = "done";
    await this.speakText(
      "Perfect, I've started provisioning your Cadence setup now. We'll follow up with updates as it completes."
    );
  }

  private normalizeCapturedValue(field: OnboardingFieldName, value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "unknown";

    if (field === "transfer_number" && TRANSFER_SKIP_REGEX.test(trimmed)) {
      return "none";
    }

    if (field === "email") {
      return trimmed.toLowerCase();
    }

    return trimmed;
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
