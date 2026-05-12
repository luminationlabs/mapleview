import { describe, it, expect } from "vitest";
import { buildRequestXml, parseResponseXml } from "../xml";

describe("buildRequestXml", () => {
  it("should build request with null token and no content", () => {
    const xml = buildRequestXml("null");
    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<request version="1.0" systemType="NVMS-9000" clientType="WEB">' +
      '<token>null</token>' +
      '</request>'
    );
  });

  it("should build request with token and content", () => {
    const token = "{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}";
    const content =
      "<userName><![CDATA[admin]]></userName><password><![CDATA[abc123]]></password>";
    const xml = buildRequestXml(token, content);

    expect(xml).toContain(`<token>${token}</token>`);
    expect(xml).toContain(`<content>${content}</content>`);
  });

  it("should produce single-line XML matching web client format", () => {
    const xml = buildRequestXml("null");
    // No newlines — single line like the web client sends
    expect(xml).not.toContain("\n");
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml.endsWith("</request>")).toBe(true);
  });
});

describe("parseResponseXml", () => {
  it("should parse a success response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/reqLogin">
  <status>success</status>
  <content>
    <sessionId>{7A5D5717-A202-457A-B70C-D523B18D4F93}</sessionId>
    <nonce>{F67500CA-19EC-4B63-8B3E-4E53A0C15914}</nonce>
    <token>{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}</token>
  </content>
</response>`;

    const result = parseResponseXml(xml);
    expect(result.status).toBe("success");
    expect(result.content.sessionId).toBe(
      "{7A5D5717-A202-457A-B70C-D523B18D4F93}",
    );
    expect(result.content.nonce).toBe(
      "{F67500CA-19EC-4B63-8B3E-4E53A0C15914}",
    );
    expect(result.content.token).toBe(
      "{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}",
    );
  });

  it("should parse a failed response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/doLogin">
  <status>failed</status>
  <content></content>
</response>`;

    const result = parseResponseXml(xml);
    expect(result.status).toBe("failed");
  });

  it("should throw on missing response root", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><foo>bar</foo>`;
    expect(() => parseResponseXml(xml)).toThrow("missing <response> root");
  });

  it("should handle response with types section", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryChlRecLog">
  <status>success</status>
  <content>
    <recCount>5</recCount>
  </content>
  <types>
    <recType>MOTION,SCHEDULE</recType>
  </types>
</response>`;

    const result = parseResponseXml(xml);
    expect(result.status).toBe("success");
    expect(result.types).toBeDefined();
    expect(result.content.recCount).toBe(5);
  });

  it("should handle empty content gracefully", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/test">
  <status>success</status>
</response>`;

    const result = parseResponseXml(xml);
    expect(result.status).toBe("success");
    expect(result.content).toEqual({});
  });
});
