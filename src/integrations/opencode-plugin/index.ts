import fs from "fs";
import os from "os";
import path from "path";

interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface BusEventWrapper {
  event: {
    type: string;
    sessionID?: string;
    info?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

function resolveWorkerPort(): string {
  const fromEnv = process.env.CLAUDE_MEM_WORKER_PORT;
  const parsed = fromEnv ? Number.parseInt(fromEnv.trim(), 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return String(parsed);
  }
  return "37777";
}

const WORKER_BASE_URL = `http://127.0.0.1:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
  });
}

async function workerGetText(urlPath: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${urlPath}`, { headers: JSON_HEADERS });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${urlPath} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker GET ${urlPath} failed: ${message}`);
    }
    return null;
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
      } else {
        break;
      }
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  async function updateAgentsMd(): Promise<void> {
    const context = await workerGetText(
      `/api/context/inject?projects=${encodeURIComponent(projectName)}`,
    );
    if (!context) return;

    const configDir =
      process.env.OPENCODE_CONFIG_DIR ||
      path.join(os.homedir(), ".config", "opencode");
    const agentsMdPath = path.join(configDir, "AGENTS.md");

    const OPEN_TAG = "<claude-mem-context>";
    const CLOSE_TAG = "</claude-mem-context>";
    const wrapped = `${OPEN_TAG}\n${context}\n${CLOSE_TAG}`;

    try {
      let existingContent: string;
      if (fs.existsSync(agentsMdPath)) {
        existingContent = fs.readFileSync(agentsMdPath, "utf-8");
        const start = existingContent.indexOf(OPEN_TAG);
        const end = existingContent.indexOf(CLOSE_TAG);
        if (start !== -1 && end !== -1) {
          existingContent =
            existingContent.slice(0, start) +
            wrapped +
            existingContent.slice(end + CLOSE_TAG.length);
        } else {
          existingContent = existingContent.trimEnd() + "\n\n" + wrapped + "\n";
        }
      } else {
        fs.mkdirSync(configDir, { recursive: true });
        existingContent = `# Claude-Mem Memory Context\n\n${wrapped}\n`;
      }
      fs.writeFileSync(agentsMdPath, existingContent, "utf-8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude-mem] Failed to update AGENTS.md: ${message}`);
    }
  }

  return {
    // Captures every tool execution and sends it to the worker as an observation.
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ) => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);

      let toolResponseText = output.output || "";
      if (toolResponseText.length > MAX_TOOL_RESPONSE_LENGTH) {
        toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
      }

      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: toolResponseText,
        cwd: ctx.directory,
      });
    },

    // Captures user prompt text so it's stored as an observation.
    "chat.message": async (
      input: { sessionID: string; messageID?: string },
      output: { message: unknown; parts: Array<{ type: string; text?: string }> },
    ) => {
      const textParts = (output.parts || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("");
      if (!textParts) return;

      const contentSessionId = getOrCreateContentSessionId(input.sessionID);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: "user_prompt",
        tool_input: {},
        tool_response: textParts.slice(0, MAX_TOOL_RESPONSE_LENGTH),
        cwd: ctx.directory,
      });
    },

    // Triggered when OpenCode compacts/summarizes a session.
    "experimental.session.compacting": async (
      input: { sessionID: string },
      _output: { context: string[]; prompt?: string },
    ) => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
      void updateAgentsMd();
    },

    // Bus event subscription for session lifecycle and file edits.
    event: async ({ event }: BusEventWrapper) => {
      switch (event.type) {
        case "session.created": {
          const contentSessionId = getOrCreateContentSessionId(event.sessionID!);
          workerPostFireAndForget("/api/sessions/init", {
            contentSessionId,
            project: projectName,
            prompt: "",
          });
          break;
        }

        case "session.deleted": {
          if (event.sessionID) {
            void updateAgentsMd();
            contentSessionIdsByOpenCodeSessionId.delete(event.sessionID);
          }
          break;
        }
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: {
            type: "string",
            description: "Search query for memory observations",
          },
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const query = String(args.query || "");
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          let data: { content?: Array<{ type: string; text: string }> };
          try {
            data = JSON.parse(text);
          } catch (error: unknown) {
            console.warn(
              "[claude-mem] Failed to parse search results:",
              error instanceof Error ? error.message : String(error),
            );
            return "Failed to parse search results.";
          }

          const resultText = data.content?.[0]?.text;
          if (!resultText) {
            return `No results found for "${query}".`;
          }
          return resultText;
        },
      },
    },
  };
};

export default ClaudeMemPlugin;
