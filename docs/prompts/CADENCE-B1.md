# CADENCE-B1 — System Prompt Update: Booking, Reschedule, and Call Forwarding

## Thinking level: low

## Context

This is the Cadence v2 repo — an AI voice agent for Deer Valley Driving School (DVDS). It's a Node.js/TypeScript app deployed on Railway via GitHub push. The app uses Twilio WebSocket streaming for calls: incoming calls hit `/incoming-call` which returns TwiML with `<Connect><Stream>`, then audio flows over WebSocket where Deepgram STT transcribes, an LLM generates responses, and ElevenLabs/Deepgram TTS speaks them back.

Key files you need to understand:
- `src/system-prompt.ts` — hardcoded DVDS system prompt (the `SYSTEM_PROMPT` export)
- `src/call-handler.ts` — WebSocket call handler class. Has `conversationHistory`, `streamSid`, `callerPhone`. The `onStart` method receives the Twilio `start` event which includes `callSid` in `msg.start?.callSid`.
- `src/llm.ts` — simple chat completion (Groq primary, OpenAI fallback). No function calling — plain text responses only.
- `src/sms.ts` — uses `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` env vars for Twilio REST API.
- `src/index.ts` — Express app with `/incoming-call` endpoint that returns TwiML. The TwiML passes `clientId` and `from` as stream parameters.

## What to change

### 1. Update the system prompt in `src/system-prompt.ts`

Find the `SYSTEM_PROMPT` export and make these changes to the prompt text:

**A) New booking intent** — Find the section about booking ("Booking is done at www.deervalleydrivingschool.com..."). Replace the booking instructions with a simpler directive: when someone wants to schedule/book a lesson, tell them: "To schedule a lesson, please visit deervalleydrivingschool.com." You can still offer to text the booking link if SMS is relevant. Remove the detailed "pick their region, choose dates" paragraph — just direct them to the website.

**B) Reschedule/cancel intent** — Find the rescheduling section ("For rescheduling or canceling..."). Replace it with: when someone wants to reschedule or cancel, tell them: "Please check your confirmation email — you can reschedule or cancel directly from there." Remove the 48-hour notice and $75 fee details — Cadence doesn't need to explain the policy, just point them to the email.

**C) Caller asks for a human OR shows frustration** — Add a new instruction to the prompt: If the caller asks to speak to a real person, a manager, or a human, OR if the caller sounds frustrated, angry, or upset, Cadence should say something brief like "Let me connect you with someone who can help." and then include the exact marker `[TRANSFER]` at the end of the response. This marker will be detected by code and trigger a call forward. Add this to the hard rules section.

**D) Keep everything else the same** — pricing, packages, eligibility, permit info, competitor handling, hours, etc. all stay exactly as they are.

### 2. Add call forwarding in `src/call-handler.ts`

**A) Capture the CallSid.** In the `CallHandler` class, add a private field `private callSid = "";`. In the `onStart` method, capture it: `this.callSid = msg.start?.callSid || "";`. The Twilio WebSocket `start` event includes `callSid`.

**B) Add a `TRANSFER_MARKER` constant** at the top of the file: `const TRANSFER_MARKER = "[TRANSFER]";`

**C) In `onTranscript`**, after the LLM response is received and before TTS:
- Check if `response` includes `TRANSFER_MARKER`
- If it does:
  1. Strip the marker from the response text: `const spokenResponse = response.replace(TRANSFER_MARKER, "").trim();`
  2. Speak the cleaned response via TTS (the "Let me connect you" part)
  3. After TTS completes, call a new method `this.forwardCall()` 
  4. Return early (don't continue normal flow)
- If it doesn't, continue normal flow as-is.

**D) Add a `forwardCall` method** to the `CallHandler` class:
```typescript
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
```

This uses the Twilio REST API to update the live call with new TwiML containing `<Dial>`, which disconnects the WebSocket stream and connects the caller to the forwarding number.

### 3. Pass CallSid from TwiML to WebSocket

In `src/index.ts`, the `/incoming-call` endpoint builds TwiML. The `callSid` is actually already available in the WebSocket `start` event from Twilio automatically — you do NOT need to pass it as a custom parameter. Twilio's media stream `start` event includes `callSid` natively. Just make sure `call-handler.ts` reads it from `msg.start?.callSid`.

### 4. Build verification

Run `npx tsc --noEmit` to verify TypeScript compiles. Fix any type errors.

## Gate

After all changes, commit and push:
```
git add -A
git commit -m "feat: update DVDS prompt — booking to website, reschedule to email, frustrated callers forward to Austen"
git push origin main
```

Gate passes if `git push` exit code is 0.

## Procurement contract

Every coder batch must terminate immediately after gates are satisfied and code is committed and pushed. No local servers, no open-ended testing. Every batch ends with git commit + push. Codex must NOT run `vercel` CLI or `railway` CLI for deployment — push to git only, Railway auto-deploys via GitHub integration. Coders MUST POST to `http://localhost:18789/hooks/agent` with `Authorization: Bearer KyCiiWTXATTqCayTrPyoE9krcBzXFP7YPtzqEGlA1aA=` and body `{"message":"Batch complete. Gate ready.","agentId":"main","deliver":false}` written to temp file, sent via `curl.exe --data-binary @file`. Coders do NOT set up git credentials — the orchestrator handles this pre-flight.
