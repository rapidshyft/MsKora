/**
 * GradeX health probing.
 *
 * Kora is deliberately hosted away from the GradeX VPS, so that when the box
 * is down Kora is still up to say so. That only works if a failure to reach
 * GradeX is reported as a failure rather than as silence — so every probe
 * resolves, none of them throw, and "I could not reach it" is a first-class
 * result rather than an absent one.
 */

/** How long to wait on a probe before calling it unreachable. */
const PROBE_TIMEOUT_MS = 8000;

export interface ProbeResult {
  /** Human label for the thing probed. */
  name: string;
  /** What we asked for. */
  url: string;
  ok: boolean;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /** Round-trip in ms, or null when the request never completed. */
  latencyMs: number | null;
  /** Why it failed, when it did. */
  error?: string;
  /** Extra detail a probe chose to surface (e.g. the API's own status field). */
  detail?: string;
}

async function probe(
  name: string,
  url: string,
  expect: (response: Response) => Promise<{ ok: boolean; detail?: string }>,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "MsKora/health-check" },
    });
    const latencyMs = Date.now() - startedAt;
    const verdict = await expect(response);
    return {
      name,
      url,
      ok: verdict.ok,
      status: response.status,
      latencyMs,
      ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      status: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface GradexEnvironment {
  apiBaseUrl: string;
  dashboardBaseUrl: string;
}

/**
 * The three things worth knowing at a glance: is the API alive, is it ready
 * to serve (which includes its database check), and is the admin dashboard
 * being served.
 */
export async function checkGradex(env: GradexEnvironment): Promise<ProbeResult[]> {
  const api = env.apiBaseUrl.replace(/\/$/, "");
  const dashboard = env.dashboardBaseUrl.replace(/\/$/, "");

  return Promise.all([
    probe("API", `${api}/health`, async (response) => {
      if (!response.ok) return { ok: false };
      try {
        const body = (await response.json()) as { status?: string; database?: string };
        // The endpoint answers 200 with its own status field; trust that over
        // the status code, which only says the process is listening.
        const healthy = body.status === "healthy";
        const database = typeof body.database === "string" ? body.database : "";
        const connected = database.startsWith("connected");
        return {
          ok: healthy && connected,
          detail: connected ? "db connected" : database || "db state unknown",
        };
      } catch {
        return { ok: false, detail: "unreadable response body" };
      }
    }),
    probe("Readiness", `${api}/ready`, async (response) => ({
      ok: response.ok,
      detail: response.ok ? "ready to serve" : "not ready",
    })),
    probe("Dashboard", `${dashboard}/auth`, async (response) => ({
      ok: response.ok,
    })),
  ]);
}

/** True only when every probe came back good. */
export function allHealthy(results: ProbeResult[]): boolean {
  return results.every((result) => result.ok);
}

function describe(result: ProbeResult): string {
  const mark = result.ok ? "🟢" : "🔴";
  const parts: string[] = [];

  if (result.status !== null) parts.push(`HTTP ${result.status}`);
  if (result.latencyMs !== null) parts.push(`${result.latencyMs}ms`);
  if (result.detail) parts.push(result.detail);
  // An unreachable probe has no status and no latency — say why instead of
  // rendering an empty line that reads like a pass.
  if (result.error) parts.push(`unreachable: ${result.error}`);

  return `${mark} <b>${result.name}</b> — ${parts.join(" · ")}`;
}

/** Telegram HTML-formatted summary of a set of probes. */
export function formatHealthReport(results: ProbeResult[]): string {
  const healthy = allHealthy(results);
  const heading = healthy ? "✅ GradeX looks healthy" : "⚠️ GradeX has a problem";
  const lines = results.map(describe);
  return [heading, "", ...lines].join("\n");
}
