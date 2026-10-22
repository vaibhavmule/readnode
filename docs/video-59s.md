# 59-second vertical video

**Format:** 1080 × 1920, 9:16, 30 fps. Captions burned in, no voice-over required —
everything readable with the sound off, which is how it will be watched.

**Rule for the whole edit:** every number and command on screen is real. No
mock-up dashboards, no invented statistics. The terminal output is the product.

---

## Shot list

| # | Time | Screen | Caption |
| --- | --- | --- | --- |
| 1 | 0:00–0:04 | Terminal, cursor blinking | `Your Farcaster client shouldn't need anyone's API key.` |
| 2 | 0:04–0:10 | Type `readnode provision --provider aws --username yourname`, hit enter | `1 · Provision the compute` |
| 3 | 0:10–0:14 | Provider plan prints; instance running | `Your machine. Your data.` |
| 4 | 0:14–0:21 | Type `readnode up`; sync log scrolls, `blockDelay` counts down | `2 · Sync your own Snapchain read node` |
| 5 | 0:21–0:26 | `readnode status`; shard table, delay hits single digits | `~550 GB of Farcaster state, on your disk` |
| 6 | 0:26–0:31 | Type `readnode client`; browser opens at `127.0.0.1:3939` | `3 · Open the client` |
| 7 | 0:31–0:38 | Paste seed phrase; custody address and FID resolve | `Import your seed phrase — used once, never written to disk` |
| 8 | 0:38–0:45 | Click "Issue app key"; scopes and TTL appear | `One gasless app key. No Optimism transaction.` |
| 9 | 0:45–0:52 | Feed loads; post a cast; like; follow | `Read, post, follow, react` |
| 10 | 0:52–0:57 | Toggle a client badge in the filter; that client's casts vanish | `See which client posted what — and filter it out` |
| 11 | 0:57–0:59 | Repo + site URLs | `MIT · three commands · github.com/vaibhavmule/readnode` |

---

## Emphasis beats

Two moments carry the video. Hold on them a beat longer than feels natural:

- **The gasless key (shot 8).** The whole reason this is buildable in a week is
  that app keys stopped needing an on-chain transaction. Let the caption sit.
- **The client filter (shot 10).** Make the cast visibly disappear when toggled.
  It is the least obvious requirement and the easiest to prove on camera.

## Music

One continuous bed, no drops. Around −22 LUFS under the captions. If it competes
with the text, it is too loud.

## Recording notes

- Record at 2× and speed the sync log to about 8×. A genuine hours-long download
  is the honest b-roll, but nobody watches it in real time.
- Terminal font at least 15 px at 1080 wide, or the commands are unreadable on a
  phone.
- Blur or crop the seed phrase in shot 7 before posting. Show the fields filling
  in, not the words.
