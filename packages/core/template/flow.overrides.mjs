// Hand edits to the recorded flow. compile (scenecast flow) builds flow.json from recording.json, then calls this.
// Change the flow in place (or return the fields to replace). The format is in the kit's docs/flow-format.md.
// Keep every edit here, with a line on why, so a new recording keeps them.
export default function overrides(flow, { recording, demo }) {
  // Replay pace: 5 plays each streamed answer at its recorded speed (capped at record.streamMaxMs); 10 is half
  // speed. ?pace= in the URL overrides it.
  flow.pace = 5;

  // Beat labels for the presenter guide (⌥1 … ⌥9), e.g.:
  // flow.beats[2].label = '2 Copilot: prompt 1';

  // Captured text that's left over from setup, not part of the story (removed from every page and frame):
  // flow.edits = [{ remove: 'A sentence a reset left behind.' }];

  // Layout the real app keeps up to date by script (docs/flow-format.md, "layout"), e.g. a fixed composer:
  // flow.apps.find(a => a.id === 'copilot').layout.pin = [{ el: '…', anchor: '…' }];
}
