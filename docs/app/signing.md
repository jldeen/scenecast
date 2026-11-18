# Signing the installers

CI builds the installers on every push (`installers` job in `.github/workflows/ci.yml`). Without signing secrets they
are **unsigned**: the Mac app is ad-hoc signed (it runs, but macOS asks once), and the Windows installers show
SmartScreen's "unknown publisher". Add the secrets below (repository Settings → Secrets and variables → Actions) and
the next run signs them; nothing else changes. A secret that isn't set is never passed to the build.

## macOS: Developer ID and notarization

You need an Apple Developer account and a **Developer ID Application** certificate.

1. In Keychain Access, export the certificate with its private key as a `.p12`, with a password.
2. Base64 it: `base64 -i DeveloperID.p12 | pbcopy`.
3. Add the secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | The base64 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Its password |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, e.g. `Developer ID Application: Contoso (TEAMID1234)` |
| `APPLE_ID` | The Apple ID that notarizes (for notarization) |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | The team ID |

Tauri imports the certificate into a temporary keychain, signs the app (hardened runtime) and what it carries,
notarizes it when `APPLE_ID` is set, and staples the ticket. `scripts/prepare-bundle.mjs` prints `signed as …,
notarized` in the job log.

Unsigned, a presenter opens it once with Control-click → Open (or System Settings → Privacy & Security → Open Anyway).

## Windows: Authenticode

You need a code-signing certificate as a `.pfx` (an OV or EV certificate from a CA, or your organization's).

1. Base64 it: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("signing.pfx")) | Set-Clipboard`.
2. Add the secrets:

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | The base64 `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password |

`scripts/prepare-bundle.mjs` imports it into the runner's certificate store and gives Tauri its thumbprint (SHA-256,
timestamped by `http://timestamp.digicert.com`, or `WINDOWS_TIMESTAMP_URL`); Tauri signs the app, the `.msi` and the
setup `.exe`. A certificate held in a cloud HSM (Azure Trusted Signing, for instance) needs a `bundle.windows.signCommand`
in the overlay instead; see Tauri's Windows signing guide.

Unsigned, a presenter clicks More info → Run anyway on the SmartScreen prompt.

## Locally

```bash
npm ci                                   # at the repository root: the installer carries its playwright-core
cd apps/desktop
npm ci
node scripts/prepare-bundle.mjs          # Node for the installer, and signing if its variables are set
npx tauri build --config src-tauri/tauri.bundle.json --target universal-apple-darwin --bundles app,dmg   # macOS
npx tauri build --config src-tauri/tauri.bundle.json --bundles msi,nsis                                  # Windows
```
