import { describe, expect, test } from "bun:test";
import { parseGitNameStatus, parseUnifiedDiff } from "./ado";

describe("git diff file identity", () => {
  test("keeps binary files distinct when patches omit ---/+++ markers", () => {
    const raw = [
      "diff --git a/tools/terraform.exe b/tools/terraform.exe",
      "index 3fd8d704..3f7d04ef 100644",
      "Binary files a/tools/terraform.exe and b/tools/terraform.exe differ",
      "diff --git a/tools/terragrunt.exe b/tools/terragrunt.exe",
      "index 00181d7a..c913dae9 100644",
      "Binary files a/tools/terragrunt.exe and b/tools/terragrunt.exe differ",
      "",
    ].join("\n");
    const metadata = parseGitNameStatus(
      "M\0tools/terraform.exe\0M\0tools/terragrunt.exe\0",
    );

    expect(parseUnifiedDiff(raw, metadata)).toEqual([
      expect.objectContaining({
        path: "tools/terraform.exe",
        oldPath: "tools/terraform.exe",
        status: "edit",
        binary: true,
        blob: "3f7d04ef",
      }),
      expect.objectContaining({
        path: "tools/terragrunt.exe",
        oldPath: "tools/terragrunt.exe",
        status: "edit",
        binary: true,
        blob: "c913dae9",
      }),
    ]);
  });

  test("normalizes add, delete, rename, copy, and unusual path records", () => {
    const unusual = "folder/space tab\tand newline\n.bin";
    expect(parseGitNameStatus([
      "A", "empty.txt",
      "D", "removed.txt",
      "R100", "old name.txt", "new name.txt",
      "C100", "source.txt", "copy.txt",
      "M", unusual,
      "",
    ].join("\0"))).toEqual([
      { path: "empty.txt", status: "add" },
      { path: "removed.txt", status: "delete" },
      { path: "new name.txt", oldPath: "old name.txt", status: "rename" },
      { path: "copy.txt", oldPath: "source.txt", status: "copy" },
      { path: unusual, status: "edit" },
    ]);
  });

  test("identifies empty, deleted, and renamed files without content markers", () => {
    const raw = [
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "diff --git a/removed.txt b/removed.txt",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 100%",
      "rename from old name.txt",
      "rename to new name.txt",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(raw, parseGitNameStatus(
      "A\0empty.txt\0D\0removed.txt\0R100\0old name.txt\0new name.txt\0",
    ));

    expect(files.map(({ path, oldPath, status }) => ({ path, oldPath, status }))).toEqual([
      { path: "empty.txt", oldPath: undefined, status: "add" },
      { path: "removed.txt", oldPath: "removed.txt", status: "delete" },
      { path: "new name.txt", oldPath: "old name.txt", status: "rename" },
    ]);
  });

  test("rejects conflicting duplicate destination identities", () => {
    const raw = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "diff --git a/a.txt b/a.txt",
      "index 2222222..3333333 100644",
      "",
    ].join("\n");
    const duplicate = parseGitNameStatus("M\0a.txt\0M\0a.txt\0");

    expect(() => parseUnifiedDiff(raw, duplicate))
      .toThrow('git diff contains duplicate destination path "a.txt"');
  });
});
