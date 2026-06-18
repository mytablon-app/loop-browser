// Signed Windows build config — Azure Trusted Signing.
//
// Used ONLY by `npm run dist:win:signed`. The default `npm run dist` (mac) and
// `npm run dist:win` (unsigned) keep using the plain `build` block in package.json,
// so this file can't break the working unsigned builds.
//
// It spreads the package.json build config and layers `azureSignOptions` onto `win`.
// All values come from env vars — nothing secret is committed. See SIGNING.md for the
// full Azure setup (resources, identity validation, service principal, build prereqs).
//
// Required env at build time:
//   Auth (service principal — Azure SDK DefaultAzureCredential reads these):
//     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//   Trusted Signing target (from your Azure resources):
//     AZURE_CODE_SIGNING_ENDPOINT   e.g. https://eus.codesigning.azure.net/  (region-specific)
//     AZURE_CODE_SIGNING_ACCOUNT    your Trusted Signing account name
//     AZURE_CERT_PROFILE            your certificate profile name
//     AZURE_PUBLISHER_NAME          the validated publisher/subject name (must match the cert)

const base = require("./package.json").build;

const required = [
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT",
  "AZURE_CERT_PROFILE",
  "AZURE_PUBLISHER_NAME",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(
    "Azure Trusted Signing not configured — missing env: " +
      missing.join(", ") +
      "\nSee SIGNING.md. For an UNSIGNED build use `npm run dist:win` instead."
  );
}

module.exports = {
  ...base,
  win: {
    ...base.win,
    azureSignOptions: {
      endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
      certificateProfileName: process.env.AZURE_CERT_PROFILE,
      publisherName: process.env.AZURE_PUBLISHER_NAME,
    },
  },
};
