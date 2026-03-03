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
- Commit: _pending in this run_
- Push: _pending in this run_
