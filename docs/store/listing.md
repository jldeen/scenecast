# The recorder in the Chrome Web Store and Edge Add-ons

So a presenter adds the recorder in two clicks ("Add to Chrome", "Add extension") instead of Developer mode and Load
unpacked, and it updates itself. Publish it **unlisted** (only people with the link find it) in both stores. Until
then, Scenecast keeps the folder way, and that stays for internal builds and locked-down devices.

## What to do

1. Build the store package: `node packages/recorder/build.mjs` (the same extension the app installs), zipped with
   `manifest.json` at the root. Set its `version` to the app's.
2. **Chrome Web Store** (developer account, one-time fee): new item, upload the zip, fill in the listing below, set
   visibility to **Unlisted**, submit. The `debugger` permission means a manual review: allow a few days.
3. **Edge Add-ons** (Partner Center, free): the same zip and listing, **Hidden**. If Edge's review is slow, Edge also
   installs from the Chrome Web Store ("Allow extensions from other stores").
4. Put each store's ID and page in `packages/recorder/store.json`. Scenecast then recognises a recorder added from a
   store, and Record's **Add the recorder** opens the store page in the demo's browser and profile.
5. For a managed fleet, IT can force-install it by ID with the `ExtensionInstallForcelist` policy (Chrome and Edge).

## The listing

**Name:** Scenecast Recorder

**Summary (132 characters at most):** Records a live web demo in your own browser, so Scenecast can turn it into a replica
that runs the same every time.

**Description:**

> Scenecast Recorder works with the Scenecast desktop app. You click through your demo once, as you'll present it; the
> recorder captures each screen as a real page (its markup, styles, fonts and frames) and a picture of it, and sends
> them to Scenecast on this computer. Scenecast turns them into a replica you present from: the same every run, no
> network, no sign-ins on stage.
>
> Nothing leaves your computer: the recorder only talks to the Scenecast app on this machine (127.0.0.1). It records
> only while you've started a recording in Scenecast, and only the demo's tabs.

**Category:** Productivity (Workflow and planning)

**Single purpose:** Capture the pages of a web demo the presenter is recording, for the Scenecast desktop app on the
same computer.

**Permission justifications:**

| Permission | Why |
|---|---|
| `debugger` | To capture each screen exactly as it renders (the page's markup with its shadow DOM and frames, computed fonts, a screenshot) through the Chrome DevTools Protocol, which a content script can't reach. While it records, the browser shows its "started debugging this browser" bar. |
| `tabs` | To find the demo's tabs by address, open a missing one, and follow the presenter from tab to tab. |
| `storage` | To remember the Scenecast app's local port, an ID for this recorder, and which recording is running, so a recording picks up where it left off if the browser restarts the extension. |
| Host permission `<all_urls>` | The demo can be any web app (Teams, Copilot, an admin center): the recorder captures whichever ones the presenter's demo uses. It sends nothing anywhere but 127.0.0.1. |

**Remote code:** none. Everything runs from the package.

**Data use (privacy practices):** It handles website content (the pages being recorded) to provide its single
purpose. It is not sold, not transferred to third parties, not used for anything else, and not sent off the device:
it goes to the Scenecast app on this computer. No analytics.

**Privacy policy:** link to a page with the paragraph above (the repository's `docs/store/privacy.md`).

**Pictures:** a 128×128 icon (`packages/recorder/extension/icon.png`), one to five screenshots at 1280×800 (Scenecast's
Record screen with the recorder connected; a recording in progress), and a 440×280 small promo tile.
