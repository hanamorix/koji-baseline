// tools.ts — Agent tool definitions + Tauri execution dispatcher
// 11 tools: filesystem, shell, search, git, browser, network

import { invoke } from "@tauri-apps/api/core";
import type { ToolDefinition } from "../providers/provider";

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command and return its stdout + stderr. Supports pipes, redirects, and any shell syntax.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          cwd: {
            type: "string",
            description: "Working directory (optional, defaults to home dir)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. Optionally slice to a line range.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or ~ path to the file",
          },
          start_line: {
            type: "number",
            description: "First line to return (1-indexed, inclusive)",
          },
          end_line: {
            type: "number",
            description: "Last line to return (1-indexed, inclusive)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating it if it does not exist.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or ~ path to the file",
          },
          content: {
            type: "string",
            description: "Full content to write",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Find and replace an exact string in a file. Fails if old_text is not found.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or ~ path to the file",
          },
          old_text: {
            type: "string",
            description: "Exact string to find",
          },
          new_text: {
            type: "string",
            description: "Replacement string",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or ~ path to the directory",
          },
          recursive: {
            type: "boolean",
            description: "If true, list recursively (default false)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search file contents with a regex pattern using ripgrep (or grep as fallback).",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for",
          },
          path: {
            type: "string",
            description: "Directory to search in (default: current dir)",
          },
          glob: {
            type: "string",
            description: "File glob filter, e.g. '*.ts' or '**/*.rs'",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_filenames",
      description: "Search for files by name pattern using find.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Filename pattern (glob-style, e.g. '*.ts')",
          },
          path: {
            type: "string",
            description: "Directory to search in (default: current dir)",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Run git status in the current repo and return the output.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff, optionally for a specific path or staged changes.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Limit diff to this file or directory (optional)",
          },
          staged: {
            type: "boolean",
            description: "If true, show staged diff (--cached). Default false.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_browser",
      description: "Open a URL in the system default browser.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to open",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a URL via HTTP GET and return the response body as text.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to fetch",
          },
        },
        required: ["url"],
      },
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

/**
 * Dispatch a tool call to the appropriate Tauri command.
 * Returns the result as a plain string for insertion into the message history.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "run_command": {
      const result = await invoke<string>("agent_run_command", {
        command: args.command as string,
        cwd: (args.cwd as string | undefined) ?? null,
      });
      return result;
    }

    case "read_file": {
      const result = await invoke<string>("agent_read_file", {
        path: args.path as string,
        startLine: (args.start_line as number | undefined) ?? null,
        endLine: (args.end_line as number | undefined) ?? null,
      });
      return result;
    }

    case "write_file": {
      await invoke<void>("agent_write_file", {
        path: args.path as string,
        content: args.content as string,
      });
      return "File written successfully.";
    }

    case "edit_file": {
      await invoke<void>("agent_edit_file", {
        path: args.path as string,
        oldText: args.old_text as string,
        newText: args.new_text as string,
      });
      return "File edited successfully.";
    }

    case "list_directory": {
      const result = await invoke<string>("agent_list_directory", {
        path: args.path as string,
        recursive: (args.recursive as boolean | undefined) ?? null,
      });
      return result;
    }

    case "search_files": {
      const result = await invoke<string>("agent_search_files", {
        pattern: args.pattern as string,
        path: (args.path as string | undefined) ?? null,
        glob: (args.glob as string | undefined) ?? null,
      });
      return result;
    }

    case "search_filenames": {
      const result = await invoke<string>("agent_search_filenames", {
        pattern: args.pattern as string,
        path: (args.path as string | undefined) ?? null,
      });
      return result;
    }

    case "git_status": {
      const result = await invoke<string>("agent_run_command", {
        command: "git status",
        cwd: null,
      });
      return result;
    }

    case "git_diff": {
      let command = "git diff";
      if (args.staged === true) command += " --cached";
      if (args.path) command += ` -- ${args.path as string}`;
      const result = await invoke<string>("agent_run_command", {
        command,
        cwd: null,
      });
      return result;
    }

    case "open_browser": {
      await invoke<void>("open_url", { url: args.url as string });
      return `Opened ${args.url as string} in browser.`;
    }

    case "fetch_url": {
      const result = await invoke<string>("agent_fetch_url", {
        url: args.url as string,
      });
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
