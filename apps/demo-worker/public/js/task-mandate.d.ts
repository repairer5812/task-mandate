import type { IssueInput } from "@task-mandate/core";

export function issueMandate(input: IssueInput): Promise<string>;
export function signRequest(
  req: Request,
  opts: {
    mandate: string | (() => string | Promise<string>);
    agentKey: JsonWebKey;
    now?: Date;
  },
): Promise<Request>;
