import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface AuthEnvResult {
  /** Environment to hand each ChatSession subprocess. */
  env: NodeJS.ProcessEnv;
  /** True if we stripped an ANTHROPIC_API_KEY that would have overridden the subscription. */
  strippedApiKey: boolean;
  /** Resolved path to a `claude` binary, if we found one to prefer. */
  claudePath?: string;
  /** Human-readable notes for the status/preflight message. */
  notes: string[];
}

/**
 * Build the subprocess environment so the SDK uses the user's **subscription**
 * login rather than pay-per-token API billing.
 *
 * Auth precedence in claude-code is: API key > OAuth token > subscription OAuth.
 * So to force the subscription we must ensure ANTHROPIC_API_KEY (and the auth
 * token) are NOT present in the env we pass to the subprocess.
 */
export async function buildAuthEnv(
  configuredClaudePath: string
): Promise<AuthEnvResult> {
  const notes: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };

  let strippedApiKey = false;
  if (env.ANTHROPIC_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
    strippedApiKey = true;
    notes.push(
      "Removed ANTHROPIC_API_KEY from the session environment so Claude Fleet uses your subscription login instead of pay-per-token API billing."
    );
  }
  // ANTHROPIC_AUTH_TOKEN also outranks the subscription; drop it too.
  if (env.ANTHROPIC_AUTH_TOKEN) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    notes.push("Removed ANTHROPIC_AUTH_TOKEN so the subscription login is used.");
  }

  const claudePath = await resolveClaude(configuredClaudePath, notes);
  return { env, strippedApiKey, claudePath, notes };
}

async function resolveClaude(
  configured: string,
  notes: string[]
): Promise<string | undefined> {
  if (configured && existsSync(configured)) {
    notes.push(`Using configured claude binary: ${configured}`);
    return configured;
  }
  // Try the login shell's PATH (GUI apps on macOS often don't inherit it).
  const candidates = [
    process.env.CLAUDE_BIN_PATH,
    `${process.env.HOME}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) {
      notes.push(`Found claude binary at ${c}.`);
      return c;
    }
  }
  // Ask a login shell where claude is (picks up nvm / custom PATH).
  try {
    const { stdout } = await pexec(
      process.env.SHELL || "/bin/zsh",
      ["-l", "-c", "command -v claude"],
      { timeout: 4000 }
    );
    const p = stdout.trim();
    if (p && existsSync(p)) {
      notes.push(`Resolved claude via login shell: ${p}.`);
      return p;
    }
  } catch {
    /* fall through — SDK will use its bundled binary */
  }
  notes.push(
    "No external claude binary found; relying on the one bundled with the Agent SDK. If chats fail to authenticate, set claudeFleet.pathToClaudeExecutable or run `claude login` in a terminal."
  );
  return undefined;
}
