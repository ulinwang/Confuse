import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult>;
}

export class ProcessRunError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = "ProcessRunError";
  }
}

function truncated(value: string, maximum = 8_192): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

const TERMINATION_GRACE_MS = 1_000;

export class NodeProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: options.env,
        shell: false,
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminationReason: "timeout" | "abort" | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        callback();
      };
      const terminate = (reason: "timeout" | "abort") => {
        if (settled || terminationReason) return;
        terminationReason = reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new ProcessRunError(
                `${command} ${reason === "timeout" ? "timed out" : "was cancelled"}`,
                null,
                "SIGKILL",
              ),
            ),
          );
        }, TERMINATION_GRACE_MS);
        killTimer.unref();
      };
      const abort = () => terminate("abort");
      const timeout = setTimeout(
        () => terminate("timeout"),
        options.timeoutMs ?? 60_000,
      );
      timeout.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 1_048_576) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 65_536) stderr += chunk;
      });
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("close", (code, signal) => {
        finish(() => {
          if (terminationReason === "timeout") {
            reject(new ProcessRunError(`${command} timed out`, code, signal));
          } else if (terminationReason === "abort") {
            reject(
              new ProcessRunError(`${command} was cancelled`, code, signal),
            );
          } else if (code !== 0) {
            const detail = truncated(stderr.trim() || stdout.trim());
            reject(
              new ProcessRunError(
                `${command} exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`,
                code,
                signal,
              ),
            );
          } else {
            resolve({ stdout, stderr });
          }
        });
      });
      child.stdin.on("error", () => undefined);
      if (options.input !== undefined) child.stdin.write(options.input);
      child.stdin.end();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}
