#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as helpers from "./lib/helpers.js";
import { registerSystemTools } from "./lib/system.js";
import { registerDockerTools } from "./lib/docker.js";

void z;
void helpers;

const server = new McpServer({
  name: "infra-mcp",
  version: "1.0.0",
});

server.setResourceRequestHandlers();
server.setPromptRequestHandlers();

registerSystemTools(server);
registerDockerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[infra-mcp] Server started");
