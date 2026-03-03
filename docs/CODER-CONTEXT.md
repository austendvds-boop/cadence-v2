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
