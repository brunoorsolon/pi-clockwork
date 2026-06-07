import { spawn } from "node:child_process";
import { DEFAULT_SHELL_MAX_OUTPUT_BYTES, DEFAULT_SHELL_TIMEOUT_MS, type ShellAction } from "../types";

export interface ShellResult {
	command: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
}

export async function runShellAction(action: ShellAction, defaultCwd: string): Promise<ShellResult> {
	const startedAt = Date.now();
	const timeoutMs = action.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
	const maxBytes = action.maxOutputBytes ?? DEFAULT_SHELL_MAX_OUTPUT_BYTES;
	const cwd = action.cwd ?? defaultCwd;
	const env = { ...process.env, ...(action.env ?? {}) };

	return await new Promise<ShellResult>((resolve) => {
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let truncated = false;
		let timedOut = false;

		const child = spawn(action.command, {
			cwd,
			env,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
			const current = kind === "stdout" ? stdout : stderr;
			if (current.length >= maxBytes) {
				truncated = true;
				return;
			}
			const available = maxBytes - current.length;
			const next = Buffer.concat([current, chunk.subarray(0, available)]);
			if (chunk.length > available) truncated = true;
			if (kind === "stdout") stdout = next;
			else stderr = next;
		};

		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
		}, timeoutMs);
		timer.unref?.();

		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({
				command: action.command,
				exitCode: 1,
				signal: null,
				stdout: stdout.toString("utf8"),
				stderr: `${stderr.toString("utf8")}\n${error.message}`.trim(),
				timedOut,
				truncated,
				durationMs: Date.now() - startedAt,
			});
		});

		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolve({
				command: action.command,
				exitCode,
				signal,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				timedOut,
				truncated,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

export function summarizeShellResult(result: ShellResult): string {
	const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? `signal ${result.signal}`}`;
	const truncated = result.truncated ? " · output truncated" : "";
	const stdout = result.stdout.trim() ? `\nstdout:\n${result.stdout.trim()}` : "";
	const stderr = result.stderr.trim() ? `\nstderr:\n${result.stderr.trim()}` : "";
	return `Shell ${status} in ${result.durationMs}ms${truncated}.${stdout}${stderr}`;
}
