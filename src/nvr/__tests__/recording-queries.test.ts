import { describe, it, expect } from "vitest";
import {
  parseResponseXml,
  parseDateRecordingInfo,
  parseRecordingSegments,
} from "../xml";

describe("parseDateRecordingInfo", () => {
  it("parses a response with multiple dates", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryDatesExistRec">
  <status>success</status>
  <content type="list" startTime="2026-04-01 00:00:00" endTime="2026-04-13 23:59:59" duration="1123200">
    <item>2026-04-13</item>
    <item>2026-04-12</item>
    <item>2026-04-11</item>
  </content>
</response>`;

    const resp = parseResponseXml(xml);
    const info = parseDateRecordingInfo(resp);

    expect(info.dates).toEqual(["2026-04-13", "2026-04-12", "2026-04-11"]);
    expect(info.startTime).toBe("2026-04-01 00:00:00");
    expect(info.endTime).toBe("2026-04-13 23:59:59");
    expect(info.duration).toBe(1123200);
  });

  it("handles a single date (not wrapped in array by parser)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryDatesExistRec">
  <status>success</status>
  <content type="list" startTime="2026-04-13 08:00:00" endTime="2026-04-13 20:00:00" duration="43200">
    <item>2026-04-13</item>
  </content>
</response>`;

    const resp = parseResponseXml(xml);
    const info = parseDateRecordingInfo(resp);

    expect(info.dates).toEqual(["2026-04-13"]);
  });

  it("handles empty content (no recordings)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryDatesExistRec">
  <status>success</status>
  <content></content>
</response>`;

    const resp = parseResponseXml(xml);
    const info = parseDateRecordingInfo(resp);

    expect(info.dates).toEqual([]);
    expect(info.startTime).toBe("");
    expect(info.endTime).toBe("");
    expect(info.duration).toBe(0);
  });
});

describe("parseRecordingSegments", () => {
  it("parses multiple recording segments", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryChlRecLog">
  <status>success</status>
  <content>
    <chl>{00000001-0000-0000-0000-000000000000}</chl>
    <recList type="list" timeZone="UTC">
      <item>
        <recType>SCHEDULE</recType>
        <startTime>2026-04-13 00:00:01</startTime>
        <endTime>2026-04-13 06:30:00</endTime>
        <size>82</size>
      </item>
      <item>
        <recType>MOTION</recType>
        <startTime>2026-04-13 08:15:00</startTime>
        <endTime>2026-04-13 08:45:30</endTime>
        <size>25</size>
      </item>
    </recList>
  </content>
</response>`;

    const resp = parseResponseXml(xml);
    const segments = parseRecordingSegments(resp);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      recType: "SCHEDULE",
      startTime: "2026-04-13 00:00:01",
      endTime: "2026-04-13 06:30:00",
      size: 82,
    });
    expect(segments[1]).toEqual({
      recType: "MOTION",
      startTime: "2026-04-13 08:15:00",
      endTime: "2026-04-13 08:45:30",
      size: 25,
    });
  });

  it("handles a single segment", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryChlRecLog">
  <status>success</status>
  <content>
    <chl>{00000001-0000-0000-0000-000000000000}</chl>
    <recList type="list">
      <item>
        <recType>SCHEDULE</recType>
        <startTime>2026-04-13 10:00:00</startTime>
        <endTime>2026-04-13 11:00:00</endTime>
        <size>40</size>
      </item>
    </recList>
  </content>
</response>`;

    const resp = parseResponseXml(xml);
    const segments = parseRecordingSegments(resp);

    expect(segments).toHaveLength(1);
    expect(segments[0].recType).toBe("SCHEDULE");
  });

  it("returns empty array when no recList", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryChlRecLog">
  <status>success</status>
  <content></content>
</response>`;

    const resp = parseResponseXml(xml);
    const segments = parseRecordingSegments(resp);

    expect(segments).toEqual([]);
  });

  it("returns empty array when recList has no items", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<response version="1.0" cmdId="" cmdUrl="/queryChlRecLog">
  <status>success</status>
  <content>
    <chl>{00000001-0000-0000-0000-000000000000}</chl>
    <recList type="list"></recList>
  </content>
</response>`;

    const resp = parseResponseXml(xml);
    const segments = parseRecordingSegments(resp);

    expect(segments).toEqual([]);
  });
});
