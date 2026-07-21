import { describe, expect, test } from "bun:test";
import { renderStartupService } from "./startup.ts";

describe("startup service", () => {
  test("renders a persistent LaunchAgent with escaped paths and environment", () => {
    const service = renderStartupService(
      "/Applications/Informant & tools/informant",
      { PATH: "/opt/tools&more/bin", INFORMANT_CONFIG_FILE: "/tmp/config.json" },
      "/tmp/informant logs",
    );

    expect(service).toContain("<string>dev.informant.worker</string>");
    expect(service).toContain("<string>/Applications/Informant &amp; tools/informant</string>");
    expect(service).toContain("<string>serve</string>");
    expect(service).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(service).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(service).toContain("<string>/opt/tools&amp;more/bin</string>");
    expect(service).toContain("<string>/tmp/informant logs/worker.stderr.log</string>");
  });
});
