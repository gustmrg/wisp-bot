import { describe, expect, it } from "vitest";

import { outlineCommand } from "../backend/command-outline.js";

describe("outlineCommand", () => {
  it("names each program with its subcommand, in order", () => {
    expect(outlineCommand("cd /workspace/patchbot && npm ci && npm run build 2>&1 | tail -n 20")).toBe(
      "cd · npm ci · npm run build · tail",
    );
    expect(outlineCommand("git clone https://github.com/owner/repo.git\ngit -C repo status")).toBe("git clone · git");
    expect(outlineCommand("(cd app; pnpm exec vitest run) && ls -la")).toBe("cd · pnpm exec vitest · ls");
  });

  it("leaves out arguments, values, quoted text and environment assignments", () => {
    const outline = outlineCommand(
      'GITHUB_TOKEN=ghp_abc curl -H "Authorization: Bearer xyz; rm -rf /" https://api.example.com/private > out.json',
    );
    expect(outline).toBe("curl");
    expect(outlineCommand("echo 'a && b' && sudo apt-get install -y jq")).toBe("echo · apt-get install");
    expect(outlineCommand("timeout 30 npm test")).toBe("npm test");
  });

  it("skips words that look like secrets or are not program names", () => {
    expect(outlineCommand("./bin/run-token-refresh && `whoami` && $(cat x)")).toBe("cat");
    expect(outlineCommand("npm run sk-live-123")).toBe("npm run");
    expect(outlineCommand("git status; git status")).toBe("git status");
  });

  it("caps its length", () => {
    expect(outlineCommand(Array.from({ length: 100 }, () => "make build && ls").join(" && "), 20)).toBe(
      "make build · ls · ma…",
    );
  });
});
