// Copilot's run in a separate browser, as the Record screen shows it.

// What the run is doing now: the latest of its steps, its stages (saving the recording, putting the demo back) and a
// stop, in the order they came (each job update has a seq). After a stop, it says so, then what it's finishing.
export function runNow(j) {
  const ev = j.events || [], stage = (j.stages || []).at(-1);
  const step = ev.filter(e => e.event === 'step').at(-1), stopped = ev.filter(e => e.event === 'stopped').at(-1);
  const later = (a, b) => !!a && (!b || (a.seq || 0) > (b.seq || 0));
  if (stopped) {
    const at = stopped.data?.at;
    const where = at && at.beat != null ? `Beat ${at.beat + 1}, ` : '';
    return `Stopped: ${where}${stopped.data?.why || 'it couldn\u2019t go on'}${later(stage, stopped) ? `. ${stage.label}\u2026` : ''}`;
  }
  if (later(stage, step)) return stage.label;
  if (step) return `Step ${step.data.n} of ${step.data.of}: ${step.data.text}`;
  return stage?.label || 'Starting\u2026';
}

// After a run: make the replica from what it recorded, unless a run in the separate browser stopped part way and the
// demo already has one (it stays as it was: a few screens never replace a whole replica).
export const makeAfterRun = (o, { away, built }) => !!o && (!away || (o.summary?.states > 0 && !(o.stopped && built)));
