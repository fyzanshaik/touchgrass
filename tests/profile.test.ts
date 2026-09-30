import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import { GatewayEndpoint } from "../src/dns-profile/endpoint.ts";
import {
  buildDnsProfileXml,
  dnsSettingsPayloadDisplayName,
  escapeXml,
  profileIdentifier,
  type DnsProfileInput,
} from "../src/dns-profile/profile.ts";

const endpoint = Schema.decodeUnknownSync(GatewayEndpoint)(
  "https://clearbrowse-test.cloudflare-gateway.com/dns-query",
);

const profileInput = {
  endpoint,
  ids: { profileUuid: "PROFILE-UUID", dnsSettingsUuid: "DNS-UUID" },
  metadata: {
    displayName: "ClearBrowse Test DNS",
    description: "Remove this profile to restore the previous DNS setup.",
  },
} satisfies DnsProfileInput;

describe("escapeXml", () => {
  it("escapes the five XML-significant characters", () => {
    assert.equal(escapeXml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("leaves other text untouched", () => {
    assert.equal(
      escapeXml("https://clearbrowse-test.cloudflare-gateway.com/dns-query"),
      "https://clearbrowse-test.cloudflare-gateway.com/dns-query",
    );
  });
});

describe("buildDnsProfileXml", () => {
  const xml = buildDnsProfileXml(profileInput);

  it("emits an unsigned removable system profile", () => {
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
    assert.match(xml, /<key>PayloadType<\/key><string>Configuration<\/string>/);
    assert.match(xml, /<key>PayloadScope<\/key><string>System<\/string>/);
    assert.match(xml, /<key>PayloadRemovalDisallowed<\/key><false\/>/);
    assert.match(xml, /<key>PayloadVersion<\/key><integer>1<\/integer>/);
    assert.match(xml, /<\/plist>\n$/);
  });

  it("emits an HTTPS DNS settings payload with a catch-all connect rule", () => {
    assert.match(xml, /<key>PayloadType<\/key><string>com\.apple\.dnsSettings\.managed<\/string>/);
    assert.match(xml, /<key>DNSProtocol<\/key><string>HTTPS<\/string>/);
    assert.match(xml, /<key>OnDemandRules<\/key>\n\s*<array><dict><key>Action<\/key><string>Connect<\/string><\/dict><\/array>/);
  });

  it("scopes both payload identifiers to the project", () => {
    assert.match(xml, new RegExp(`<string>${profileIdentifier}</string>`));
    assert.match(xml, new RegExp(`<string>${profileIdentifier}\\.settings</string>`));
  });

  it("routes the server URL and the generated uuid at the given values", () => {
    assert.match(
      xml,
      /<key>ServerURL<\/key><string>https:\/\/clearbrowse-test\.cloudflare-gateway\.com\/dns-query<\/string>/,
    );
    assert.match(xml, /<string>PROFILE-UUID<\/string>/);
    assert.match(xml, /<string>DNS-UUID<\/string>/);
    assert.equal(xml.includes(`<string>${dnsSettingsPayloadDisplayName}</string>`), true);
  });

  it("omits certificate, VPN, token and failover payloads", () => {
    for (const forbidden of [
      "SupplementalMatchDomains",
      "AllowFailover",
      "com.apple.vpn.managed",
      "com.apple.security.pkcs1",
      "PayloadCertificateFileName",
      "ManagementToken",
    ]) {
      assert.equal(xml.includes(forbidden), false);
    }
  });

  it("escapes metadata and endpoint text instead of interpolating it raw", () => {
    const escaped = buildDnsProfileXml({
      ...profileInput,
      metadata: {
        displayName: "A & B <C>",
        description: "quotes \" and ' here",
      },
    });
    assert.match(escaped, /<string>A &amp; B &lt;C&gt;<\/string>/);
    assert.match(escaped, /<string>quotes &quot; and &apos; here<\/string>/);
    assert.equal(escaped.includes("<C>"), false);
  });
});
