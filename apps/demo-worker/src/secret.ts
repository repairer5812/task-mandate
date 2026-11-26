import { fixedEqual } from "@task-mandate/demo-site";

export function tokenMatches(provided: string, secret: string): Promise<boolean> {
  return fixedEqual(provided, secret);
}
