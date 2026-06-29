import { ConnectorNotImplementedError, type ConnectorExecutionContext, type ConnectorFetchResult, type SourceConnector } from "./providers.js";
import type { LinearSourceObjectType } from "./source-object.js";

export const linearMvpObjectTypes = [
  "linear.workspace",
  "linear.user",
  "linear.team",
  "linear.project",
  "linear.workflow_state",
  "linear.label",
  "linear.issue",
  "linear.comment",
] as const satisfies readonly LinearSourceObjectType[];

export const linearMvpScopeTypes = ["linear.workspace", "linear.team", "linear.project"] as const;

export interface LinearWorkspaceScopeConfig {
  workspaceId?: string;
  includeProjects?: boolean;
}

export interface LinearTeamScopeConfig {
  teamId: string;
  includeProjects?: boolean;
}

export class LinearSourceConnector implements SourceConnector {
  readonly provider = "linear";
  readonly supportedObjectTypes = linearMvpObjectTypes;
  readonly supportedScopeTypes = linearMvpScopeTypes;

  async fetchSourceObjects(_context: ConnectorExecutionContext): Promise<ConnectorFetchResult> {
    throw new ConnectorNotImplementedError(this.provider, "fetchSourceObjects");
  }
}
