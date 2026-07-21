#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

type PiMode = "interactive" | "print" | "json" | "rpc";

interface HarnessOptions {
  input?: string;
  phase?: string;
  from?: string;
  to?: string;
  mode: PiMode;
  tools: string;
  provider?: string;
  model?: string;
  thinking?: string;
  session?: boolean;
  sessionDir?: string;
  offline?: boolean;
  piBin: string;
  dryRun?: boolean;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTools = "read,grep,find,ls,bash,edit,write";

const program = new Command();
program
  .name("pi-agent-harness")
  .description("Launch pi with podcast-football project context and no MCP dependency")
  .argument("[task...]", "task text to hand to pi")
  .option("--input <htmlOrDir>", "report file or directory relevant to the task")
  .option("--phase <phase>", "single harness phase to focus on")
  .option("--from <phase>", "pipeline range start")
  .option("--to <phase>", "pipeline range end")
  .option("--mode <mode>", "pi mode: interactive, print, json, or rpc", parseMode, "interactive")
  .option("--tools <list>", "pi tool allowlist", defaultTools)
  .option("--provider <name>", "pi provider name")
  .option("--model <pattern>", "pi model pattern or provider/model id")
  .option("--thinking <level>", "pi thinking level")
  .option("--session-dir <dir>", "pi session directory")
  .option("--no-session", "start pi with --no-session")
  .option("--offline", "set PI_OFFLINE=1 for pi startup")
  .option("--pi-bin <path>", "pi executable", "pi")
  .option("--dry-run", "print the generated command and prompt without launching pi")
  .action(async (taskParts: string[], options: HarnessOptions) => {
    const prompt = buildPrompt(taskParts, options);
    const piArgs = buildPiArgs(options, prompt);

    if (options.dryRun) {
      printDryRun(options, piArgs, prompt);
      return;
    }

    const environment = {
      ...process.env,
      ...(options.offline ? { PI_OFFLINE: "1" } : {}),
    };

    if (options.mode === "rpc") {
      console.error("[pi-agent-harness] RPC mode started. Send JSONL commands to stdin, for example: {\"type\":\"prompt\",\"message\":\"...\"}");
    }

    const child = spawn(options.piBin, piArgs, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        console.error(`Could not find '${options.piBin}'. Install pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent`);
      } else {
        console.error(error.message);
      }
      process.exitCode = 1;
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`pi exited via signal ${signal}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = code ?? 0;
    });
  });

await program.parseAsync(process.argv);

function parseMode(value: string): PiMode {
  if (value === "interactive" || value === "print" || value === "json" || value === "rpc") return value;
  throw new Error(`Invalid mode '${value}'. Expected interactive, print, json, or rpc.`);
}

function buildPiArgs(options: HarnessOptions, prompt: string): string[] {
  const piArgs: string[] = [];

  if (options.provider) piArgs.push("--provider", options.provider);
  if (options.model) piArgs.push("--model", options.model);
  if (options.thinking) piArgs.push("--thinking", options.thinking);
  if (options.tools) piArgs.push("--tools", options.tools);
  if (options.session === false) piArgs.push("--no-session");
  if (options.sessionDir) piArgs.push("--session-dir", path.resolve(projectRoot, options.sessionDir));

  switch (options.mode) {
    case "print":
      piArgs.push("-p", prompt);
      break;
    case "json":
      piArgs.push("--mode", "json", prompt);
      break;
    case "rpc":
      piArgs.push("--mode", "rpc");
      break;
    case "interactive":
      piArgs.push(prompt);
      break;
  }

  return piArgs;
}

function buildPrompt(taskParts: string[], options: HarnessOptions): string {
  const task = taskParts.join(" ").trim() || "Inspect the project state, choose the smallest useful next step, and keep changes scoped.";
  const lines = [
    "Use the podcast-football pi harness resources in this repository.",
    "",
    `Task: ${task}`,
    "",
    "Runtime rules:",
    "- Work as a minimal pi coding agent with no MCP dependency.",
    "- Load /skill:podcast-football-harness when pipeline details matter.",
    "- Prefer npm run harness -- inspect <html> before parser changes.",
    "- Prefer HARNESS_SKIP_RENDER=1 for fast local verification.",
    "- Keep generated out/ artifacts out of source changes unless explicitly requested.",
    "",
    "Useful commands:",
    "- npm run harness -- inspect <html>",
    "- npm run harness -- run <html|dir>",
    "- npm run lint",
    "- npm run build",
  ];

  if (options.input) lines.push("", `Input target: ${options.input}`);
  if (options.phase) lines.push(`Focus phase: ${options.phase}`);
  if (options.from || options.to) lines.push(`Range: ${options.from ?? "INGEST"}..${options.to ?? "POST"}`);

  return lines.join("\n");
}

function printDryRun(options: HarnessOptions, piArgs: string[], prompt: string): void {
  const environmentPrefix = options.offline ? "PI_OFFLINE=1 " : "";
  console.log(`Project root: ${projectRoot}`);
  console.log("Command:");
  console.log(`  ${environmentPrefix}${shellQuote(options.piBin)} ${piArgs.map(shellQuote).join(" ")}`);
  if (options.mode === "rpc") {
    console.log("RPC prompt command:");
    console.log(JSON.stringify({ type: "prompt", message: prompt }));
  }
  console.log("Prompt:");
  console.log(prompt);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}