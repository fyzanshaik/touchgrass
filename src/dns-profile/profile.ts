import type { GatewayEndpoint } from "./endpoint.ts";

export interface DnsProfileIds {
  readonly profileUuid: string;
  readonly dnsSettingsUuid: string;
}

export interface DnsProfileMetadata {
  readonly displayName: string;
  readonly description: string;
}

export interface DnsProfileInput {
  readonly endpoint: GatewayEndpoint;
  readonly ids: DnsProfileIds;
  readonly metadata: DnsProfileMetadata;
}

export const profileIdentifier = "org.clearbrowse.personal.dns";

export const dnsSettingsPayloadDisplayName = "Touchgrass Gateway DNS";

export const defaultProfileMetadata = {
  displayName: "Touchgrass DNS",
  description:
    "Routes eligible DNS lookups to your personal Cloudflare Gateway. Filtering depends on Gateway rules and browser settings. Remove this profile to restore the previous DNS setup.",
} as const satisfies DnsProfileMetadata;

const escapeXmlCharacter = (character: string): string => {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&apos;";
    default:
      return character;
  }
};

export const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, escapeXmlCharacter);

export const buildDnsProfileXml = (input: DnsProfileInput): string => {
  const { endpoint, ids, metadata } = input;
  const settingsIdentifier = `${profileIdentifier}.settings`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>${escapeXml(profileIdentifier)}</string>
  <key>PayloadUUID</key><string>${escapeXml(ids.profileUuid)}</string>
  <key>PayloadDisplayName</key><string>${escapeXml(metadata.displayName)}</string>
  <key>PayloadDescription</key><string>${escapeXml(metadata.description)}</string>
  <key>PayloadScope</key><string>System</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>${escapeXml(settingsIdentifier)}</string>
      <key>PayloadUUID</key><string>${escapeXml(ids.dnsSettingsUuid)}</string>
      <key>PayloadDisplayName</key><string>${escapeXml(dnsSettingsPayloadDisplayName)}</string>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>${escapeXml(endpoint)}</string>
      </dict>
      <key>OnDemandRules</key>
      <array><dict><key>Action</key><string>Connect</string></dict></array>
    </dict>
  </array>
</dict>
</plist>
`;
};
