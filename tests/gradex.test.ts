import { afterEach, describe, expect, it, vi } from "vitest";

import { allHealthy, checkGradex, formatHealthReport, type ProbeResult } from "../src/gradex";
import { escapeHtml } from "../src/bot";

const env = {
  apiBaseUrl: "https://api.example.test",
  dashboardBaseUrl: "https://admin.example.test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("checkGradex", () => {
  it("probes the API, readiness and dashboard", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/health")) return jsonResponse({ status: "healthy", database: "connected: {...}" });
      if (href.endsWith("/ready")) return new Response("ok", { status: 200 });
      return new Response("<html>", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await checkGradex(env);

    expect(results.map((r) => r.name)).toEqual(["API", "Readiness", "Dashboard"]);
    expect(allHealthy(results)).toBe(true);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://api.example.test/health",
      "https://api.example.test/ready",
      "https://admin.example.test/auth",
    ]);
  });

  it("treats a 200 with an unhealthy body as unhealthy", async () => {
    // /health answers 200 whenever the process is listening; its own status
    // field is the real verdict, so a degraded API must not read as green.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/health")
          ? jsonResponse({ status: "degraded", database: "connected: {...}" })
          : new Response("ok", { status: 200 }),
      ),
    );

    const results = await checkGradex(env);
    expect(results[0]!.ok).toBe(false);
    expect(allHealthy(results)).toBe(false);
  });

  it("treats a healthy process with a disconnected database as unhealthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/health")
          ? jsonResponse({ status: "healthy", database: "error: connection refused" })
          : new Response("ok", { status: 200 }),
      ),
    );

    const results = await checkGradex(env);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain("error");
  });

  it("reports an unreachable host as a failure rather than throwing", async () => {
    // The whole point of hosting Kora away from the VPS: when GradeX is down,
    // Kora still answers and says so.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));

    const results = await checkGradex(env);

    expect(results).toHaveLength(3);
    expect(allHealthy(results)).toBe(false);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("strips a trailing slash so base URLs cannot produce a double slash", async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await checkGradex({ apiBaseUrl: "https://api.example.test/", dashboardBaseUrl: "https://admin.example.test/" });

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("//health");
      expect(String(call[0])).not.toMatch(/[^:]\/\//);
    }
  });
});

describe("formatHealthReport", () => {
  const ok: ProbeResult = { name: "API", url: "u", ok: true, status: 200, latencyMs: 42, detail: "db connected" };
  const down: ProbeResult = { name: "Readiness", url: "u", ok: false, status: null, latencyMs: null, error: "timed out" };

  it("leads with a verdict and marks each probe", () => {
    const report = formatHealthReport([ok, down]);
    expect(report).toContain("⚠️ GradeX has a problem");
    expect(report).toContain("🟢 <b>API</b> — HTTP 200 · 42ms · db connected");
    expect(report).toContain("🔴 <b>Readiness</b> — unreachable: timed out");
  });

  it("says healthy only when every probe passed", () => {
    expect(formatHealthReport([ok])).toContain("✅ GradeX looks healthy");
    expect(formatHealthReport([ok, down])).not.toContain("✅");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup so an echoed message cannot break the parse mode", () => {
    // Telegram rejects the whole sendMessage if HTML is malformed, so an
    // unescaped echo of "<b>" would make the bot look broken.
    expect(escapeHtml("<b>bold</b> & <script>")).toBe(
      "&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
