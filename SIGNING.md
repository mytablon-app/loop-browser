# Windows code signing — Azure Trusted Signing

Unsigned Windows builds hit two walls:
- **SmartScreen** — a warning with a "More info → Run anyway" bypass (annoying but passable).
- **Smart App Control (SAC)** — a hard block with **no override** on PCs that have it on. The only
  fix is a signature from a publisher Microsoft trusts.

**Azure Trusted Signing** is Microsoft's managed signing service (~$10/mo), and it's the recommended
path for SAC/SmartScreen. Signing happens in the cloud — no certificate file or hardware token to
manage. This repo is already wired for it: `npm run dist:win:signed` (see `electron-builder.signing.js`).

> ⏳ **The slow part is identity validation, and it's a hard gate.** You can't sign until Microsoft
> validates the publisher identity. This can take **several business days**, and eligibility has
> requirements (e.g. organizations may need to be established **3+ years** or provide extra
> verification; individual "Public Trust" validation is also available). Start this early — it does
> **not** unblock anyone's test today.

---

## One-time Azure setup (you / the account owner)

1. **Azure subscription** — any. In the portal, register the resource provider
   **`Microsoft.CodeSigning`** (Subscriptions → Resource providers).
2. **Create a Trusted Signing account** (search "Trusted Signing" in the portal). Pick a region —
   it determines your endpoint, e.g. East US → `https://eus.codesigning.azure.net/`.
3. **Create a Certificate Profile** of type **Public Trust** under that account, and complete
   **identity validation** (the gate above). When approved, note the **certificate subject /
   publisher name** — it must match `AZURE_PUBLISHER_NAME` exactly.
4. **Create a service principal** for the build host to authenticate non-interactively:
   - Microsoft Entra ID → App registration → note the **Tenant ID**, **Client ID**, and a
     **Client secret**.
   - Grant it the role **`Trusted Signing Certificate Profile Signer`** on the Trusted Signing
     account (Access control (IAM) → Add role assignment).

You now have the seven values the build needs.

## Build-host prerequisites (the Windows machine that runs `dist:win:signed`)
- Windows + the **Windows SDK** (provides `signtool`).
- **.NET 8 runtime** (the Trusted Signing client library is .NET-based).
- electron-builder 25+ (already in `devDependencies`). It invokes the Azure Trusted Signing client
  during the Windows build; if the client tooling isn't present it will fetch/prompt for it — install
  the **`Microsoft.Trusted.Signing.Client`** tooling if a build complains.

## Build a signed installer
Set the env vars (PowerShell example — use your real values; don't commit secrets):
```powershell
$env:AZURE_TENANT_ID="…"; $env:AZURE_CLIENT_ID="…"; $env:AZURE_CLIENT_SECRET="…"
$env:AZURE_CODE_SIGNING_ENDPOINT="https://eus.codesigning.azure.net/"
$env:AZURE_CODE_SIGNING_ACCOUNT="<your-trusted-signing-account>"
$env:AZURE_CERT_PROFILE="<your-certificate-profile>"
$env:AZURE_PUBLISHER_NAME="<validated publisher/subject name>"

npm run dist:win:signed     # → build/dist/Loop-Browser-win.exe  (signed)
```
`electron-builder.signing.js` throws a clear error listing any missing env var, so a half-configured
run fails fast instead of silently producing an unsigned binary.

## Verify the signature
```powershell
signtool verify /pa /v "build\dist\Loop-Browser-win.exe"
```
Or right-click the `.exe` → **Properties → Digital Signatures** — there should be a valid signature
from your publisher name. Then install it on a **SAC-enabled** PC to confirm SAC no longer blocks it.

## After signing works
- **Re-upload** the signed `Loop-Browser-win.exe` to release `v0.0.1` (same asset name).
- **Update the copy**: drop the unsigned/SAC warning in `site/index.html` (the Windows `$n` note)
  and the SmartScreen/SAC block in `BUILDING.md` — a signed build shows neither prompt.
