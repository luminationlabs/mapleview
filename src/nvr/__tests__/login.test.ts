import { describe, it, expect, vi, beforeEach } from "vitest";
import { login, stripBraces } from "../login";
import { computePasswordHash } from "../crypto";

describe("stripBraces", () => {
  it("should strip braces from a GUID", () => {
    expect(stripBraces("{7A5D5717-A202-457A-B70C-D523B18D4F93}")).toBe(
      "7A5D5717-A202-457A-B70C-D523B18D4F93",
    );
  });

  it("should return the string unchanged if no braces", () => {
    expect(stripBraces("7A5D5717-A202-457A-B70C-D523B18D4F93")).toBe(
      "7A5D5717-A202-457A-B70C-D523B18D4F93",
    );
  });

  it("should handle empty string", () => {
    expect(stripBraces("")).toBe("");
  });

  it("should not strip if only one brace", () => {
    expect(stripBraces("{abc")).toBe("{abc");
    expect(stripBraces("abc}")).toBe("abc}");
  });
});

describe("login", () => {
  const mockHost = "192.168.1.100";
  const mockUser = "admin";
  const mockPass = "password123";

  const reqLoginResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/reqLogin">
  <status>success</status>
  <content>
    <sessionId>{7A5D5717-A202-457A-B70C-D523B18D4F93}</sessionId>
    <nonce>{F67500CA-19EC-4B63-8B3E-4E53A0C15914}</nonce>
    <token>{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}</token>
    <softwareVersion><![CDATA[1.4.6.76250]]></softwareVersion>
  </content>
</response>`;

  const doLoginResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/doLogin">
  <status>success</status>
  <content>
    <userId>{AE7D03B6-55BE-4BCC-B54D-DBC7EF517174}</userId>
    <authEffective>true</authEffective>
    <userType>normal</userType>
    <sessionKey>HQuyn+fY/cd7052/ZToZyh4aBcAOUmiM5hKCg9mJKV8=</sessionKey>
  </content>
</response>`;

  /** Mock XMLHttpRequest for doLogin (which uses xhrPost instead of fetch) */
  function mockXHR(responseText: string, status = 200) {
    const instances: any[] = [];
    class MockXHR {
      open = vi.fn();
      setRequestHeader = vi.fn();
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 0;
      responseText = "";
      send = vi.fn().mockImplementation(() => {
        this.status = status;
        this.responseText = responseText;
        this.onload?.();
      });
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXHR);
    return { MockXHR, instances: () => instances };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should perform two-step login and return NvrSession", async () => {
    // Mock fetch for reqLogin (step 1)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(`http://${mockHost}/reqLogin`);
        expect(init?.body).toContain("<token>null</token>");
        return new Response(reqLoginResponseXml, { status: 200 });
      }),
    );

    // Mock XMLHttpRequest for doLogin (step 2)
    const { instances } = mockXHR(doLoginResponseXml);

    const session = await login(mockHost, mockUser, mockPass);

    expect(session.host).toBe(mockHost);
    expect(session.sessionId).toBe("7A5D5717-A202-457A-B70C-D523B18D4F93");
    expect(session.token).toBe("{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}");
    expect(session.userId).toBe("{AE7D03B6-55BE-4BCC-B54D-DBC7EF517174}");
    expect(session.userName).toBe(mockUser);

    // Verify the XHR was called with correct URL and cookie
    const xhr = instances()[0];
    expect(xhr.open).toHaveBeenCalledWith(
      "POST",
      `http://${mockHost}/doLogin`,
      true,
    );
    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      "Cookie",
      "sessionId=7A5D5717-A202-457A-B70C-D523B18D4F93",
    );

    // Verify password hash in the body
    const body = xhr.send.mock.calls[0][0] as string;
    const expectedHash = computePasswordHash(
      mockPass,
      "{F67500CA-19EC-4B63-8B3E-4E53A0C15914}",
    );
    expect(body).toContain(`<![CDATA[${expectedHash}]]>`);
    expect(body).toContain(`<![CDATA[${mockUser}]]>`);
    expect(body).toContain(
      "<token>{7094BDCD-5DF5-471A-9DE5-A4BBB21AA723}</token>",
    );
  });

  it("should throw on reqLogin HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await expect(login(mockHost, mockUser, mockPass)).rejects.toThrow(
      "reqLogin failed: HTTP 500",
    );
  });

  it("should throw on reqLogin status=failed", async () => {
    const failedXml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/reqLogin">
  <status>failed</status>
  <content></content>
</response>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(failedXml, { status: 200 })),
    );
    await expect(login(mockHost, mockUser, mockPass)).rejects.toThrow(
      "reqLogin failed: status=failed",
    );
  });

  it("should throw on doLogin XHR failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(reqLoginResponseXml, { status: 200 })),
    );
    mockXHR("", 401);

    await expect(login(mockHost, mockUser, mockPass)).rejects.toThrow(
      "HTTP 401",
    );
  });
});
