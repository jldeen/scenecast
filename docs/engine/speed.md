# Speed: where a recording's time goes

The goal: Demo 1 (38 screens, 4 apps, 4 prompts) recorded and built in **15 minutes or less**, menus and hovers
kept. Each stage of the plan ships as its own release; this page is how it's measured.

## The take's timeline (recording.json)

The recorder writes one entry per span of its own work (`timeline`), wall clock, and sums them up in `timing`:

| `timing` | What |
|---|---|
| `wallSecs` | Start to Stop. |
| `startSecs` | Getting each app's tab ready and capturing its start screen. |
| `startSweepSecs` | The start screens' side states (hovers, menus, groups, chips, zoom…). |
| `screenSweepSecs` | Every later screen's side states. |
| `actionSecs` | Each click, Enter or Escape until its screen was captured (`productSecs` of it: the product, an answer streaming). |
| `heldSecs` | The presenter's actions held back while the recorder was busy ("wait for Ready"). |
| `presenterSecs` | Everything else: the presenter reading, moving, typing. |
| `sweepKinds` | Per kind: seconds, runs, what was found, and its deliberate fixed waits (`waitSecs`). |

Fixed waits count only deliberate waits inside work (a hover's settle, before a click). Timeouts and polling loops
aren't counted; before 0.5.1 they were, and loops running side by side were counted twice.

## The demo's timeline (.out/timeline.json)

The app adds one entry per phase: `check` / `check-fix`, `start`, `stop` (Stop until the recording is saved), `build`,
`checks`, `compare`. Review shows "Recorded in X · finished in Y · built in Z".

## The benchmark

`scenecast ai bench --demo <dir> --plan <plan.md> --yes '<regex>' [--build]` runs a saved plan with Record for me,
unattended: every "May I?" whose step matches `--yes` is done, any other is skipped. It writes `.out/bench.json` with
each phase and the take's split. A demo's own prep (resetting a tenant, opening tabs) is outside it.

## The fixture budget

The selftest's fixture take fails CI if it gets slower than its budget (`SCENECAST_TAKE_BUDGET`, 240 s at 0.5.1). The
budget comes down as each stage lands.
