import type { SurfaceRegistrar } from '../../main/mcp/kernel.js';
import { registerDatabaseTool } from '../mcp/database-tool.js';
import { registerEngineeringTool } from '../mcp/engineering-tool.js';
import { registerKnowledgeTool } from '../mcp/knowledge-tool.js';

/** Fork-owned Core extensions. Upstream MCP composition should call only this bridge. */
export function registerCosErpDbCoreTools(reg: SurfaceRegistrar): void {
  registerDatabaseTool(reg);
  registerKnowledgeTool(reg);
  registerEngineeringTool(reg);
}
