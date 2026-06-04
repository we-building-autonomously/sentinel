import { describe, it, expect } from "vitest";
import { pickUploadFiles, describeUpload } from "./upload.js";

describe("pickUploadFiles", () => {
  const files = ["/a/avatar.png", "/a/doc.pdf"];

  it("returns no files (cancel) when none are available", () => {
    expect(pickUploadFiles([], false, 0)).toEqual({ files: [], nextIndex: 0 });
  });

  it("offers all files to a multi-select chooser without advancing", () => {
    expect(pickUploadFiles(files, true, 0)).toEqual({ files, nextIndex: 0 });
  });

  it("rotates one file per single-select chooser", () => {
    const a = pickUploadFiles(files, false, 0);
    expect(a).toEqual({ files: ["/a/avatar.png"], nextIndex: 1 });
    const b = pickUploadFiles(files, false, a.nextIndex);
    expect(b).toEqual({ files: ["/a/doc.pdf"], nextIndex: 2 });
    // wraps around
    const c = pickUploadFiles(files, false, b.nextIndex);
    expect(c.files).toEqual(["/a/avatar.png"]);
  });
});

describe("describeUpload", () => {
  it("lists basenames", () => {
    expect(describeUpload(["/a/b/avatar.png", "/c/doc.pdf"])).toBe("avatar.png, doc.pdf");
  });
  it("notes a cancelled upload", () => {
    expect(describeUpload([])).toBe("no file configured — upload cancelled");
  });
});
