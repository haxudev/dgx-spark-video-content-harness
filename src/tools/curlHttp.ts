import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function postJsonWithCurl(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<string> {
  const bodyText = JSON.stringify(body);
  const args = [
    "-sS",
    "--connect-timeout", "20",
    "-m", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    url,
    ...Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
    "--data-binary", bodyText,
  ];
  try {
    const { stdout } = await execFileAsync("curl", args, {
      encoding: "utf8",
      timeout: timeoutMs + 5_000,
      maxBuffer: 80 * 1024 * 1024,
    });
    return stdout;
  } catch (e: any) {
    if (typeof e?.status === "number") throw e;
    const detail = e?.stderr ? String(e.stderr).slice(0, 500) : `exit=${e?.code ?? "unknown"} signal=${e?.signal ?? "unknown"}`;
    throw new Error(`curl request failed: ${detail}`);
  }
}

export async function getBufferWithCurl(url: string, timeoutMs: number): Promise<Buffer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pf-curl-"));
  const outFile = path.join(tmp, "download.bin");
  try {
    await execFileAsync("curl", [
      "-sS",
      "--connect-timeout", "20",
      "-m", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-o", outFile,
      url,
    ], {
      timeout: timeoutMs + 5_000,
      maxBuffer: 1024 * 1024,
    });
    return await fs.readFile(outFile);
  } catch (e: any) {
    const detail = e?.stderr ? String(e.stderr).slice(0, 500) : `exit=${e?.code ?? "unknown"} signal=${e?.signal ?? "unknown"}`;
    throw new Error(`curl download failed: ${detail}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
