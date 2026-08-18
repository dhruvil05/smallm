#!/usr/bin/env node
import { findModels, SmallmError } from "./index";
import { ModelQuery, ModelMatch } from "./types";

/**
 * Thin CLI wrapper around findModels(). Per the v0.5 guide's Do's/Don'ts:
 * this file must contain NO scoring, filtering, or provider logic — only
 * flag parsing (turning argv into a ModelQuery) and output formatting
 * (turning a ModelMatch[] into text). All actual decisions — including
 * input validation — are made by the library itself; this file just calls
 * findModels() and displays whatever it returns or throws.
 */

/** Thrown for usage problems (unknown flag, unknown command, --help). Caught in main(), never process.exit()'d from inside parseArgs itself — keeps parseArgs testable as a pure function. */
export class CliUsageError extends Error {
  constructor(message: string, public readonly exitCode: number = 1) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedCli {
  query: ModelQuery;
  json: boolean;
  showHelp: boolean;
}

export const USAGE = `Usage: smallm find [options]

Required:
  --task <task>                Task type (chat, summarize, classify, extract, code, translate, or any custom string)
  --context <tokens>           Required context window, in tokens

Optional (map 1:1 to ModelQuery fields):
  --max-params <billions>      Hard filter, e.g. 7 = "under 7B"
  --domain <domain>            Preferred domain tag, used in scoring only
  --hardware <cpu|gpu-low|gpu-high>   Hardware hint (original string form)
  --hardware-type <cpu|gpu>    Hardware type (structured form — use with --hardware-vram)
  --hardware-vram <gb>         VRAM budget in GB (structured form only)
  --max-latency <ms>           Enforced only when benchmark data exists for the (model, hardware) pair
  --scoring-mode <rule|embedding|hybrid>   Scoring strategy (default: rule)
  --providers <list>           Comma-separated, e.g. huggingface,ollama (default: huggingface)
  --limit <n>                  Max results (default: 5)
  --cache-dir <path>           File cache directory
  --cache-ttl <ms>             File cache TTL in ms

Output:
  --json                       Print raw ModelMatch[] JSON instead of a table

Examples:
  npx smallm find --task summarize --context 4096
  npx smallm find --task chat --context 8192 --max-params 7 --json
  npx smallm find --task chat --context 4096 --providers huggingface,ollama --hardware-type gpu --hardware-vram 8
`;

/** Pure parser: argv (already sliced past "find") -> a ModelQuery + output mode. Never touches process.exit or the network. */
export function parseArgs(argv: string[]): ParsedCli {
  const query: Record<string, unknown> = {};
  let json = false;
  let showHelp = false;
  let hardwareType: string | undefined;
  let hardwareVram: number | undefined;
  let hardwareString: string | undefined;
  let cacheDir: string | undefined;
  let cacheTtl: number | undefined;

  const takeValue = (flag: string, i: number): [string, number] => {
    const value = argv[i + 1];
    if (value === undefined) {
      throw new CliUsageError(`Flag ${flag} requires a value`);
    }
    return [value, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--task": {
        const [v, next] = takeValue(arg, i);
        query.task = v;
        i = next;
        break;
      }
      case "--context": {
        const [v, next] = takeValue(arg, i);
        query.contextLength = Number(v);
        i = next;
        break;
      }
      case "--max-params": {
        const [v, next] = takeValue(arg, i);
        query.maxParamsB = Number(v);
        i = next;
        break;
      }
      case "--domain": {
        const [v, next] = takeValue(arg, i);
        query.domain = v;
        i = next;
        break;
      }
      case "--hardware": {
        const [v, next] = takeValue(arg, i);
        hardwareString = v;
        i = next;
        break;
      }
      case "--hardware-type": {
        const [v, next] = takeValue(arg, i);
        hardwareType = v;
        i = next;
        break;
      }
      case "--hardware-vram": {
        const [v, next] = takeValue(arg, i);
        hardwareVram = Number(v);
        i = next;
        break;
      }
      case "--max-latency": {
        const [v, next] = takeValue(arg, i);
        query.maxLatencyMs = Number(v);
        i = next;
        break;
      }
      case "--scoring-mode": {
        const [v, next] = takeValue(arg, i);
        query.scoringMode = v;
        i = next;
        break;
      }
      case "--providers": {
        const [v, next] = takeValue(arg, i);
        query.providers = v.split(",").map((s) => s.trim());
        i = next;
        break;
      }
      case "--limit": {
        const [v, next] = takeValue(arg, i);
        query.limit = Number(v);
        i = next;
        break;
      }
      case "--cache-dir": {
        const [v, next] = takeValue(arg, i);
        cacheDir = v;
        i = next;
        break;
      }
      case "--cache-ttl": {
        const [v, next] = takeValue(arg, i);
        cacheTtl = Number(v);
        i = next;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        showHelp = true;
        break;
      default:
        throw new CliUsageError(`Unknown flag: ${arg}`);
    }
  }

  // Structured hardware form takes precedence if given; otherwise fall back
  // to the string-enum form. Both map onto the exact same ModelQuery.hardware
  // field the library already accepts — no new capability invented here.
  if (hardwareType !== undefined) {
    query.hardware = {
      type: hardwareType,
      ...(hardwareVram !== undefined ? { vramGB: hardwareVram } : {}),
    };
  } else if (hardwareString !== undefined) {
    query.hardware = hardwareString;
  }

  if (cacheDir !== undefined || cacheTtl !== undefined) {
    query.cacheOptions = {
      ...(cacheDir !== undefined ? { dir: cacheDir } : {}),
      ...(cacheTtl !== undefined ? { ttlMs: cacheTtl } : {}),
    };
  }

  return { query: query as unknown as ModelQuery, json, showHelp };
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/** Pure formatter: ModelMatch[] -> a human-readable table string. */
export function formatTable(results: ModelMatch[]): string {
  if (results.length === 0) {
    return "No matching models found.";
  }

  const columns: Array<{ header: string; width: number; get: (m: ModelMatch) => string }> = [
    { header: "NAME", width: 42, get: (m) => truncate(m.name, 42) },
    { header: "PROVIDER", width: 12, get: (m) => m.provider },
    { header: "PARAMS(B)", width: 10, get: (m) => (m.paramsB == null ? "?" : String(m.paramsB)) },
    { header: "SCORE", width: 6, get: (m) => String(m.score) },
    { header: "MODE", width: 10, get: (m) => m.scoringMode ?? "rule" },
    { header: "REASON", width: 50, get: (m) => truncate(m.reasonWhy, 50) },
  ];

  const headerRow = columns.map((c) => c.header.padEnd(c.width)).join(" ");
  const separator = columns.map((c) => "-".repeat(c.width)).join(" ");
  const rows = results.map((m) => columns.map((c) => c.get(m).padEnd(c.width)).join(" "));

  return [headerRow, separator, ...rows].join("\n");
}

/**
 * Entry point. Only place in this file that touches process.exit/console —
 * everything else (parseArgs, formatTable) is a pure, independently
 * testable function.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  if (argv[0] !== "find") {
    console.error(`Unknown command: "${argv[0]}". Only "find" is supported.\n`);
    console.log(USAGE);
    return 1;
  }

  let parsed: ParsedCli;
  try {
    parsed = parseArgs(argv.slice(1));
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(`Error: ${err.message}\n`);
      console.log(USAGE);
      return err.exitCode;
    }
    throw err;
  }

  if (parsed.showHelp) {
    console.log(USAGE);
    return 0;
  }

  try {
    // The one line that matters: flags in, library call, nothing invented.
    const results = await findModels(parsed.query);
    console.log(parsed.json ? JSON.stringify(results, null, 2) : formatTable(results));
    return 0;
  } catch (err) {
    if (err instanceof SmallmError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Unexpected error:", err);
    }
    return 1;
  }
}

/* istanbul ignore next -- exercised via the compiled bin, not unit tests */
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
