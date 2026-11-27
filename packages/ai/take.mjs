// The last take's raw recording, kept while a new one records: a take that stops part way puts it back whole (its
// recording, and the snapshots, shots, streams and hovers it names, which the new take's reuse by screen name).
import { existsSync, readdirSync, rmSync, cpSync } from 'node:fs';

// Not part of a take: content-addressed blobs (a take only adds to them) and the receiver's own log.
const SHARED = new Set(['blobs', 'receiver.log']);
const takeFiles = dir => existsSync(dir) ? readdirSync(dir).filter(n => !SHARED.has(n)) : [];

// → the copy's folder, or null when there's no last take (no recording.json).
export function keepLastTake(raw) {
  if (!raw || !existsSync(`${raw}/recording.json`)) return null;
  const to = `${raw}.last-take`;
  rmSync(to, { recursive: true, force: true });
  for (const n of takeFiles(raw)) cpSync(`${raw}/${n}`, `${to}/${n}`, { recursive: true });
  return to;
}

// The new take's files out, the last take's back; the copy is removed either way (drop: the new take stays).
export function endTake(raw, kept, { restore }) {
  if (!kept) return;
  if (restore) {
    for (const n of takeFiles(raw)) rmSync(`${raw}/${n}`, { recursive: true, force: true });
    for (const n of takeFiles(kept)) cpSync(`${kept}/${n}`, `${raw}/${n}`, { recursive: true });
  }
  rmSync(kept, { recursive: true, force: true });
}
