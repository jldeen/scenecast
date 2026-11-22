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

## After Stop (0.5.4)

The app makes the replica, then it's ready to present: the build, and the talk track on its screens when there is
one. Every screen compared with the real product, then the quick checks, follow in the background; Review fills in as
each screen is compared, and Present doesn't wait for either.

What makes the build fast:

- **Each file is read once, on every core.** The same pass scans it for secrets and hashes it for the fingerprint
  (`SCENECAST_THREADS`). data/ isn't read again for the output fingerprint: the scan's hashes are it.
- **Secrets, scanned as captures arrive.** While the demo's receiver runs, the app scans new captures every 3 s on two
  threads (`scrub::Prescan`). What it found is kept by content in `.out/scrub-cache.txt` (with the allowlist and the
  scanner's own version); the build after Stop finds every capture done, and still reports each raw finding. A built
  file is kept only when it's clean: one with a finding is redacted every build.
- **Each stylesheet rewritten once.** The asset resolver remembers each stylesheet and resource it resolved in this
  build (and what it reported missing, replayed), and the CSS a part needs from a source page once for all the pages it
  goes into. `<style>` blocks are found without a regex's capture engine.
- **Compose in one pass,** each page read once and written only if a step changed it; publish compares files on every
  core.
- **The guide's pictures** come from the recording's screenshots, made smaller (no browser). After the compare, a
  screen that differs gets the replica's own picture.
- **The compare** renders several screens at once (a third of the cores, at most 4: `SCENECAST_COMPARE_LANES`) and
  reuses the last comparison of a screen whose replica renders exactly as before (`.out/fidelity/cache`).

The output is byte for byte what a clean `--force` build with no cache makes (`packages/selftest/asset-build.mjs`
checks it, and that a planted token is still caught from the cache).
