import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readMcpConfig } from "./config.js";
import { createApiClient, ApiClientError } from "./client/api-client.js";
import { redactString } from "./sanitize/redact.js";
import { listSources } from "./tools/list-sources.js";
import { getIndexedFiles } from "./tools/get-indexed-files.js";
import { search } from "./tools/search.js";
import { previewCitation } from "./tools/preview-citation.js";
import { getAgentRuns } from "./tools/get-agent-runs.js";
import { getIntegrationsStatus } from "./tools/get-integrations-status.js";
import { getLlmDiagnostics } from "./tools/get-llm-diagnostics.js";

function wrapOk(tool, apiBaseUrl, data) {
  return {
    ok: true,
    tool,
    checkedAt: new Date().toISOString(),
    apiBaseUrl,
    data
  };
}

function wrapError(tool, apiBaseUrl, error) {
  const message = redactString(error?.message || "Unknown error");
  const code = error instanceof ApiClientError
    ? error.code
    : error?.code || "TOOL_ERROR";

  return {
    ok: false,
    tool,
    checkedAt: new Date().toISOString(),
    apiBaseUrl,
    error: {
      code,
      message
    }
  };
}

function toolResult(envelope) {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError: envelope.ok === false
  };
}

function registerReadOnlyTool(server, apiClient, definition) {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const data = await definition.handler(apiClient, args);
        return toolResult(wrapOk(definition.name, apiClient.baseUrl, data));
      } catch (error) {
        return toolResult(wrapError(definition.name, apiClient.baseUrl, error));
      }
    }
  );
}

function phaseOneTools(apiClient) {
  return [
    {
      name: "listSources",
      title: "List RAG sources",
      description: "List indexed RAG projects with public index status and optional summary.",
      inputSchema: {
        includeSummary: z.boolean().optional().default(true),
        maskPaths: z.boolean().optional().default(false)
      },
      handler: listSources
    },
    {
      name: "getIndexedFiles",
      title: "Get indexed files",
      description: "Return indexed file tree for a source using relative paths only.",
      inputSchema: {
        sourceId: z.string().min(1),
        qualityFilter: z.enum(["all", "ok", "warning", "error", "searchable"]).optional().default("all")
      },
      handler: getIndexedFiles
    },
    {
      name: "search",
      title: "Search indexed chunks",
      description: "Hybrid retrieval over indexed chunks. Returns snippets only; full chunk text is disabled in Phase 1.",
      inputSchema: {
        query: z.string().min(1).max(2000),
        sourceId: z.string().optional(),
        limit: z.number().int().min(1).max(30).optional().default(10),
        includeFullText: z.boolean().optional().default(false)
      },
      handler: search
    },
    {
      name: "previewCitation",
      title: "Preview citation excerpt",
      description: "Preview markdown/excerpt for a citation target. Output is truncated to maxChars (Phase 1 max 20000).",
      inputSchema: {
        sourceId: z.string().min(1),
        chunkId: z.string().optional(),
        fileId: z.string().optional(),
        path: z.string().optional(),
        focusText: z.string().max(900).optional(),
        maxChars: z.number().int().min(500).max(20000).optional().default(12000)
      },
      handler: previewCitation
    },
    {
      name: "getAgentRuns",
      title: "Get daily agent runs",
      description: "Return recent daily index agent runs with sanitized errors.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().default(10)
      },
      handler: getAgentRuns
    },
    {
      name: "getIntegrationsStatus",
      title: "Get integrations status",
      description: "Return Qdrant, reranker, and PDF converter status from the running API.",
      inputSchema: {},
      handler: getIntegrationsStatus
    },
    {
      name: "getLlmDiagnostics",
      title: "Get local LLM diagnostics",
      description: "Probe local LLM routing. provider=local only in Phase 1; token/remote is blocked.",
      inputSchema: {
        provider: z.enum(["local", "token"]).optional().default("local")
      },
      handler: getLlmDiagnostics
    }
  ];
}

export async function startMcpServer(env = process.env) {
  const config = readMcpConfig(env);
  const apiClient = createApiClient(config);
  const server = new McpServer({
    name: "localai-rag",
    version: "0.1.0"
  });

  for (const tool of phaseOneTools(apiClient)) {
    registerReadOnlyTool(server, apiClient, tool);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startMcpServer().catch((error) => {
    console.error(redactString(error?.message || "Failed to start MCP server"));
    process.exit(1);
  });
}
