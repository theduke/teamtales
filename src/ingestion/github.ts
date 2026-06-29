import { ConnectorNotImplementedError, type ConnectorExecutionContext, type ConnectorFetchResult, type SourceConnector } from "./providers.js";
import type { GitHubSourceObjectType } from "./source-object.js";

export const githubMvpObjectTypes = [
  "github.repository",
  "github.pull_request",
  "github.pull_request_review",
  "github.pull_request_comment",
  "github.issue",
  "github.issue_comment",
  "github.commit",
  "github.user",
] as const satisfies readonly GitHubSourceObjectType[];

export const githubMvpScopeTypes = ["github.repository"] as const;

export interface GitHubRepositoryScopeConfig {
  repository: string;
  includeCommits?: boolean;
}

export class GitHubSourceConnector implements SourceConnector {
  readonly provider = "github";
  readonly supportedObjectTypes = githubMvpObjectTypes;
  readonly supportedScopeTypes = githubMvpScopeTypes;

  async fetchSourceObjects(_context: ConnectorExecutionContext): Promise<ConnectorFetchResult> {
    throw new ConnectorNotImplementedError(this.provider, "fetchSourceObjects");
  }
}
