# Cadence v2 — Architecture Blueprint (Railway)

> AI voice agent for Deer Valley Driving School. Answers inbound Twilio calls.
> Target: ~300 lines of clean, working TypeScript. Deployed on Railway.

---

## Design Philosophy

The v1 build was ~700 lines and broke because of over-engineering (pre-warming, complex state machines, barge-in logic). v2 strips all of that out:

- **Deepgram SDK WebSocket STT** — Railway supports persistent WebSockets natively (no proxy issues like Render). Using `@deepgram/sdk` `client.listen.live()` gives us proper endpointing, streaming transcription, and built-in keepalive — eliminates the hacky time-based buffer flush from the REST approach.
- **No barge-in** — caller waits for Cadence to finish speaking
- **No state machine** — simple linear flow per call
- **No connection pools or pre-warming** — fresh connections per request
- **Minimal abstractions** — one file per concern, no class hierarchies

### STT Decision: WebSocket SDK vs REST

**Choice: Deepgram SDK WebSocket (`client.listen.live()`)**

Why WebSocket STT wins on Railway:
1. **Proper endpointing** — Deepgram fires `utterance_end` events when the caller stops talking. No more hacky 500ms silence timers or 1-second buffer flushes. This alone makes conversations feel dramatically more natural.
2. **Lower latency** — audio streams continuously; transcripts arrive as the caller speaks. REST requires buffering 1s+ of audio before each API call.
3. **No proxy issues** — Render's HTTP proxy mangled long-lived WebSocket connections, which is why v1 broke. Railway runs raw TCP — WebSockets work natively.
4. **One SDK dependency** — `@deepgram/sdk` handles reconnection, keepalive pings, and the binary protocol. Worth the dependency for STT reliability. TTS stays raw WebSocket (simple enough without SDK).

REST STT would still work, but the buffer-flush approach adds ~500ms-1s latency per turn and requires fragile silence-detection timers. On Railway, there's no reason to accept that tradeoff.

---

## File Structure

```
cadence-v2/
├── src/
│   ├── index.ts              # Express server + WebSocket upgrade (entry point)
│   ├── call-handler.ts       # Per-call state: STT stream, conversation, lifecycle
│   ├── stt.ts                # Deepgram SDK live STT (WebSocket streaming)
│   ├── llm.ts                # Groq chat completion
│   ├── tts.ts                # Deepgram Aura-2 TTS via raw WebSocket
│   ├── sms.ts                # Twilio SMS (booking link + call summary)
│   └── system-prompt.ts      # DVDS script (copied from v1, unchanged)
├── package.json
├── tsconfig.json
├── .env.example
└── docs/
    └── blueprint.md          # This file
```

**7 source files. That's it.**

---

## Module Responsibilities

### `index.ts` (~50 lines)
- Express app on `PORT` (Railway injects this automatically)
- `GET /` — health check, returns `{ status: "ok" }`
- `POST /incoming-call` — returns TwiML that opens a MediaStream WebSocket
- WebSocket server on `/media-stream` — on connection, creates a `CallHandler`
- Graceful shutdown on SIGTERM

### `call-handler.ts` (~100 lines)
The core orchestrator for a single call. One instance per WebSocket connection.

**State (all instance variables):**
- `streamSid: string` — Twilio stream identifier
- `dgConnection: LiveClient` — Deepgram live STT connection for this call
- `conversationHistory: Array<{role, content}>` — chat messages for Groq
- `isSpeaking: boolean` — true while TTS audio is being sent (prevents processing new audio)
- `callSummary: string[]` — collects key points for SMS summary
- `callerPhone: string` — from Twilio start event

**Methods:**
- `handleMessage(msg)` — routes Twilio WebSocket events (`connected`, `start`, `media`, `stop`)
- `onStart(data)` — stores streamSid + callerPhone, initializes Deepgram live STT connection, plays greeting via TTS
- `onMedia(data)` — if `isSpeaking`, discard audio (no barge-in). Otherwise, forward raw mulaw bytes to Deepgram STT WebSocket via `dgConnection.send(audioBuffer)`.
- `onTranscript(transcript)` — callback from Deepgram `utterance_end` or `is_final` event. If non-empty, sends to LLM, then TTS.
- `onStop()` — closes Deepgram connection, sends SMS summary to Austen, cleans up
- `sendAudio(base64Payload)` — writes a Twilio `media` message to the WebSocket

### `stt.ts` (~50 lines)
Exports a function to create a Deepgram live STT connection:

```ts
function createLiveSTT(onTranscript: (text: string) => void): LiveClient
```

- Creates Deepgram client: `createClient(DEEPGRAM_API_KEY)`
- Opens live connection: `client.listen.live({ model: "nova-2", encoding: "mulaw", sample_rate: 8000, channels: 1, punctuate: true, smart_format: true, utterance_end_ms: 1000 })`
- Listens for `LiveTranscriptionEvents.Transcript` — accumulates `is_final` transcripts
- Listens for `LiveTranscriptionEvents.UtteranceEnd` — fires `onTranscript()` with accumulated text, then resets
- Returns the connection object so `call-handler` can send audio and close it

**Why `utterance_end_ms: 1000`?** Deepgram waits 1 second of silence after the last final transcript before firing `UtteranceEnd`. This is the natural pause detection — replaces our manual silence timers entirely.

**Transcript accumulation logic:**
- On each `is_final` transcript event, append to a buffer string
- On `UtteranceEnd`, fire the callback with the full accumulated text, then clear the buffer
- This handles multi-sentence utterances correctly (caller says a long sentence that Deepgram splits into multiple finals)

### `llm.ts` (~30 lines)
Single exported function:

```ts
async function chat(history: Array<{role: string, content: string}>): Promise<string>
```

- `POST https://api.groq.com/openai/v1/chat/completions`
- Model: `GROQ_MODEL` env var (default `llama-3.3-70b-versatile`)
- `max_tokens: 200` (phone responses should be 1-2 sentences)
- `temperature: 0.7`
- System prompt prepended to history
- Returns: `choices[0].message.content`
- Fallback on error: returns "I'm sorry, could you repeat that?"
- **OpenAI fallback**: If Groq fails (503, timeout >10s), retry once with `OPENAI_API_KEY` and `OPENAI_MODEL` at `https://api.openai.com/v1/chat/completions`. Same request shape, different key/model/endpoint. If both fail, return the graceful fallback string.

### `tts.ts` (~50 lines)
Single exported function:

```ts
async function speak(text: string, sendAudio: (base64: string) => void): Promise<void>
```

- Opens a **new WebSocket** to `wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none`
- Header: `Authorization: Token ${DEEPGRAM_API_KEY}`
- Sends text as JSON: `{ "type": "Speak", "text": "<text>" }` then `{ "type": "Flush" }` then `{ "type": "Close" }`
- On each binary message received: base64-encode and call `sendAudio()` to stream to Twilio
- Returns (resolves) when WebSocket closes
- **New connection per utterance** — no pooling, no pre-warming. Deepgram handles this fine.

### `sms.ts` (~30 lines)
Two exported functions:

```ts
async function sendBookingLink(to: string): Promise<void>
async function sendCallSummary(callerPhone: string, summary: string[]): Promise<void>
```

- Uses Twilio REST API directly (no SDK — just `fetch`)
- `POST https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`
- Basic auth: `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
- `sendBookingLink`: sends booking URL to caller from `TWILIO_SMS_NUMBER`
- `sendCallSummary`: sends to `AUSTEN_CELL_NUMBER` with caller phone + bullet summary

### `system-prompt.ts` (~1 line export)
Copy the exact system prompt from v1. No changes needed. It's already well-tuned.

The full system prompt is in the existing codebase at `cadence/src/conversation/system-prompt.ts`. Copy it verbatim.

---

## Call Flow

```
┌─────────────┐
│ Incoming Call│
│  (Twilio)   │
└──────┬──────┘
       │
       ▼
┌──────────────┐     TwiML: <Connect><Stream>
│ POST         │────────────────────────────┐
│ /incoming-call│                           │
└──────────────┘                            │
                                            ▼
                                   ┌────────────────┐
                                   │ WebSocket opens │
                                   │ /media-stream   │
                                   └───────┬────────┘
                                           │
                                           ▼
                                   ┌────────────────┐
                                   │ Open Deepgram   │
                                   │ live STT conn   │
                                   └───────┬────────┘
                                           │
                                           ▼
                                   ┌────────────────┐
                                   │ Play greeting   │
                                   │ via TTS         │
                                   │ isSpeaking=true │
                                   └───────┬────────┘
                                           │
                                           ▼
                              ┌────────────────────────┐
                              │ TTS done → isSpeaking  │
                              │ = false                 │
                              │ Start forwarding audio  │
                              └────────┬───────────────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         │
                 ┌─────────────────┐                │
                 │ Forward mulaw   │                │
                 │ to Deepgram STT │                │
                 │ WebSocket       │                │
                 └────────┬────────┘                │
                          │                         │
                          ▼ (UtteranceEnd event)    │
                 ┌─────────────────┐                │
                 │ Accumulated     │                │
                 │ transcript text │                │
                 └────────┬────────┘                │
                          │                         │
                          ▼ (non-empty)             │
                 ┌─────────────────┐                │
                 │ Groq LLM →     │                │
                 │ response text   │                │
                 └────────┬────────┘                │
                          │                         │
                          ▼                         │
                 ┌─────────────────┐                │
                 │ TTS → stream    │                │
                 │ audio to Twilio │                │
                 │ isSpeaking=true │                │
                 └────────┬────────┘                │
                          │                         │
                          ▼                         │
                 ┌─────────────────┐                │
                 │ TTS done →      │                │
                 │ isSpeaking=false│────────────────┘
                 └─────────────────┘    (loop)

                    On disconnect:
                 ┌─────────────────┐
                 │ Close DG STT    │
                 │ SMS summary to  │
                 │ Austen's cell   │
                 └─────────────────┘
```

---

## STT Streaming Strategy

**Deepgram SDK handles all the hard parts:**

1. `call-handler` forwards each Twilio `media` event's audio payload (base64-decode → Buffer) to `dgConnection.send(buffer)`
2. Deepgram processes audio in real-time, fires `Transcript` events with `is_final: true` for completed phrases
3. On `UtteranceEnd` (1s silence after last final), accumulated transcript is sent to LLM

**No manual buffering, no silence timers, no minimum byte thresholds.** Deepgram's endpointing is battle-tested and handles all the edge cases (background noise, partial words, long pauses mid-sentence).

**Audio forwarding when `isSpeaking`:** While TTS is playing, audio from the caller is discarded (not sent to Deepgram). This prevents Cadence from hearing herself speak and creating feedback loops. Simple `if (isSpeaking) return;` guard in `onMedia`.

---

## TTS Streaming Approach

**Per-utterance WebSocket connection to Deepgram Aura-2:**

1. Open WebSocket: `wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none`
2. Send: `{ "type": "Speak", "text": "response text here" }`
3. Send: `{ "type": "Flush" }`
4. Receive binary audio chunks → base64-encode → send to Twilio as `media` events
5. Send: `{ "type": "Close" }`
6. Wait for WebSocket close → resolve promise → set `isSpeaking = false`

**Why WebSocket instead of REST for TTS?**
- Streaming: audio starts playing before full synthesis completes (~200ms to first audio)
- REST TTS would require waiting for entire audio file, adding 1-2s latency

**Twilio media message format:**
```json
{
  "event": "media",
  "streamSid": "<sid>",
  "media": {
    "payload": "<base64 mulaw audio>"
  }
}
```

---

## Error Handling Strategy

**Philosophy: graceful degradation, never crash the call.**

| Component | Error | Response |
|-----------|-------|----------|
| STT | WebSocket connection fails | Log error, attempt reconnect once. If fails again, call continues but can't hear caller. |
| STT | Empty/noise transcript | Skip LLM call, keep listening |
| LLM | Groq API fails | Retry once with OpenAI fallback. If both fail: "I'm sorry, I didn't catch that. Could you repeat that?" |
| LLM | Timeout (>10s) | Same fallback response |
| TTS | WebSocket fails to connect | Log error, skip response, keep listening |
| TTS | Partial audio sent | Twilio plays what it got — acceptable |
| SMS | Summary fails to send | Log error, don't crash. Non-critical. |
| WebSocket | Unexpected close | Clean up Deepgram connection, send summary if possible |

**No retries beyond the specified ones.** If something fails, move on. The caller is on the phone — they'll repeat themselves. Retries add latency and complexity.

**Logging:** Simple `console.log` / `console.error` with `[CALL:<streamSid>]` prefix. Railway captures stdout.

---

## Environment Variables

| Variable | Description | Secret? |
|----------|-------------|---------|
| `PORT` | Server port (Railway injects automatically) | No |
| `DEEPGRAM_API_KEY` | Deepgram API key for STT + TTS | Yes |
| `GROQ_API_KEY` | Groq API key for LLM | Yes |
| `GROQ_MODEL` | LLM model name — `llama-3.3-70b-versatile` | No |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | Yes |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | Yes |
| `TWILIO_PHONE_NUMBER` | Twilio voice number (inbound) | No |
| `TWILIO_SMS_NUMBER` | Twilio SMS number (10DLC) | No |
| `TWILIO_WEBSOCKET_URL` | WebSocket URL for TwiML Stream (set after deploy — `wss://<railway-url>/media-stream`) | No |
| `AUSTEN_CELL_NUMBER` | Austen's phone for SMS summaries — `+16026633502` | No |
| `OPENAI_API_KEY` | OpenAI API key (LLM fallback) | Yes |
| `OPENAI_MODEL` | OpenAI fallback model name | No |

---

## TwiML Response (from `/incoming-call`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${TWILIO_WEBSOCKET_URL}" />
  </Connect>
</Response>
```

That's it. No `<Say>`, no `<Gather>`. The greeting comes from TTS over the media stream.

---

## Dependencies (package.json)

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "@deepgram/sdk": "^3.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.3.0"
  }
}
```

**3 runtime dependencies: express, ws, @deepgram/sdk.** Deepgram SDK is used only for live STT (handles WebSocket protocol, keepalive, reconnection). TTS and all other APIs use raw `fetch()` or raw WebSocket.

---

## Build & Deploy (Railway)

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch & node --watch dist/index.js"
  }
}
```

**Railway setup:**
- **Project:** existing Railway project `54b7812c` (add new service)
- **Source:** GitHub auto-deploy from `austendvds-boop/cadence` repo, `main` branch
- **Build command:** `npm install && npm run build`
- **Start command:** `node dist/index.js`
- **Port:** Railway injects `PORT` env var automatically — Express binds to it
- **No `railway.json` needed** — Railway detects Node.js automatically

---

## Line Count Estimate

| File | Lines |
|------|-------|
| `index.ts` | ~45 |
| `call-handler.ts` | ~100 |
| `stt.ts` | ~50 |
| `llm.ts` | ~40 |
| `tts.ts` | ~45 |
| `sms.ts` | ~30 |
| `system-prompt.ts` | ~5 (re-export) |
| **Total** | **~315** |

---

## What's NOT in This Build

- ❌ Barge-in / interruption
- ❌ Connection pooling / pre-warming
- ❌ State machine / complex lifecycle
- ❌ Twilio or Groq SDKs (only Deepgram SDK for STT)
- ❌ Database / persistence
- ❌ Authentication on endpoints
- ❌ Rate limiting
- ❌ Function calling / tool use in LLM (send_sms is handled by pattern matching on LLM response text — if response contains intent to text booking link, call `sendBookingLink()`)

---

## SMS Booking Link Handling

The system prompt instructs Cadence to offer texting the booking link. Since we're not using LLM function calling (keeping it simple):

1. After each LLM response, check if response text contains phrases like "text you the link", "send you the link", "text that to you"
2. If detected AND we have the caller's phone number, call `sendBookingLink(callerPhone)`
3. Simple string matching — no need for a separate LLM call

The caller's phone number comes from the Twilio `start` event metadata (`customParameters` or `from` field).

---

## Summary

Cadence v2 is a **~315-line, 7-file TypeScript app** deployed on Railway that:
1. Answers calls via Twilio MediaStream
2. Streams audio to Deepgram live STT via SDK WebSocket (proper endpointing, no manual buffers)
3. Generates responses via Groq LLM with the full DVDS script (OpenAI fallback)
4. Streams TTS audio back via Deepgram Aura-2 WebSocket
5. Sends call summaries to Austen via SMS
6. Has zero complex state management, one SDK dependency, zero over-engineering

---

## Railway Deployment Checklist

After the coder builds the app and pushes to `austendvds-boop/cadence` on the `main` branch:

### 1. Create Railway Service
- Go to Railway dashboard → project `54b7812c`
- Click **New Service** → **GitHub Repo** → select `austendvds-boop/cadence`
- Branch: `main`
- Railway will auto-detect Node.js, set build command to `npm install && npm run build`, start command to `node dist/index.js`

### 2. Set Environment Variables
In the Railway service settings, add all env vars:

```
DEEPGRAM_API_KEY=<from credentials>
GROQ_API_KEY=<from credentials>
GROQ_MODEL=llama-3.3-70b-versatile
TWILIO_ACCOUNT_SID=<from credentials>
TWILIO_AUTH_TOKEN=<from credentials>
TWILIO_PHONE_NUMBER=<Twilio voice number>
TWILIO_SMS_NUMBER=<Twilio 10DLC number>
AUSTEN_CELL_NUMBER=+16026633502
OPENAI_API_KEY=<from credentials>
OPENAI_MODEL=<chosen fallback model>
TWILIO_WEBSOCKET_URL=wss://<TBD-railway-url>/media-stream
```

Leave `TWILIO_WEBSOCKET_URL` as placeholder — update after getting the Railway URL.

### 3. Get Railway URL
- After first deploy, Railway assigns a public URL (e.g., `cadence-production-XXXX.up.railway.app`)
- Or generate one manually: Service Settings → Networking → Generate Domain

### 4. Update `TWILIO_WEBSOCKET_URL` Env Var
- Set `TWILIO_WEBSOCKET_URL=wss://<railway-url>/media-stream` in Railway env vars
- Railway will auto-redeploy on env var change

### 5. Update Twilio Webhook
- Go to Twilio Console → Phone Numbers → select the voice number
- Set **Voice webhook** to: `https://<railway-url>/incoming-call` (HTTP POST)
- Save

### 6. Test Call
- Call the Twilio number
- Verify: greeting plays, STT picks up speech, LLM responds, TTS plays back
- Check Railway logs for `[CALL:<streamSid>]` entries
- Verify SMS summary arrives to Austen's phone after hangup
