import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  inherit?: boolean;
  input?: string;
  stdio?: ("pipe" | "inherit" | "ignore")[];
}

export async function run(
  command: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio:
        options.stdio ??
        (options.inherit
          ? "inherit"
          : [options.input ? "pipe" : "ignore", "pipe", "pipe"]),
    });

    if (options.input && child.stdin) {
      child.stdin.end(options.input);
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const result = { stdout, stderr, code: code ?? 0 };
      if (result.code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${result.code}\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

export async function hasCommand(command: string): Promise<boolean> {
  const result = await run("sh", ["-c", `command -v ${command}`], {
    allowFailure: true,
  });
  return result.code === 0;
}

export function sshArgs(host: string, sshKey?: string): string[] {
  const args = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ConnectTimeout=15",
  ];
  if (sshKey) args.push("-i", sshKey);
  args.push(host);
  return args;
}

export async function ssh(
  host: string,
  command: string,
  options: { sshKey?: string; inherit?: boolean; allowFailure?: boolean } = {},
): Promise<RunResult> {
  return run("ssh", [...sshArgs(host, options.sshKey), command], {
    inherit: options.inherit,
    allowFailure: options.allowFailure,
  });
}

export async function sshScript(
  host: string,
  script: string,
  options: { sshKey?: string; inherit?: boolean; command?: string } = {},
): Promise<RunResult> {
  // stdin carries the script, so it can't also be inherited from the terminal.
  return run("ssh", [...sshArgs(host, options.sshKey), options.command ?? "bash -s"], {
    input: script,
    allowFailure: true,
    stdio: options.inherit ? ["pipe", "inherit", "inherit"] : undefined,
  });
}
