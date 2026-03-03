# Coder Context

## 2026-03-03

### Task
Fix Deepgram live STT config so `UtteranceEnd` events fire reliably when using `utterance_end_ms`.

### Changes made
- Updated `src/stt.ts` in the `client.listen.live({...})` options:
  - Added `interim_results: true`

### Files touched
- `src/stt.ts`

### Verification
- `npm run build` ✅ (TypeScript compile passed clean)

### Git
- Commit: `cd3085d` — `fix: add interim_results for UtteranceEnd to work`
- Push: `main` pushed to `origin`/GitHub (`austendvds-boop/cadence-v2`)

## 2026-03-03 (Crash-safety hardening)

### Task
Harden Deepgram STT callback handling so async errors in transcript processing cannot bubble up and disrupt live call flow.

### Changes made
- Updated `src/stt.ts`:
  - Wrapped `LiveTranscriptionEvents.Transcript` handler body in `try/catch`.
  - Added defensive parse-error logging with prefix: `[STT] transcript parse error`.
  - Wrapped `await onTranscript(utterance)` inside `LiveTranscriptionEvents.UtteranceEnd` handler in `try/catch`.
  - Added callback-error logging with prefix: `[STT] onTranscript callback error`.
- Preserved existing behavior otherwise:
  - Final transcript buffering logic unchanged.
  - Buffer reset timing unchanged.
  - No prompt/content or flow logic changes.

### Files touched
- `src/stt.ts`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅

### Git
- Commit: `<pending>` — `fix: harden STT callback error handling`
- Push: `<pending>`
