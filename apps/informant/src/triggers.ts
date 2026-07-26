import type { PullRequest, TriggerRule } from "./types.ts";

export interface EventContext {
  type: "commit" | "comment";
  branch?: string;
  tag?: string;
  pullRequest?: PullRequest;
}

function globMatches(pattern: string, value: string): boolean {
  const expression = [...pattern]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${expression}$`).test(value);
}

export function triggerMatches(rule: TriggerRule, context: EventContext): boolean {
  if (rule.event !== context.type) return false;
  if (rule.tag) {
    const tag = context.tag;
    return tag !== undefined && rule.tag.patterns.some((pattern) => globMatches(pattern, tag));
  }
  if (context.tag !== undefined) return false;
  if (rule.branch)
    return context.branch !== undefined && rule.branch.names.includes(context.branch);
  if (!rule.pullRequest) return true;
  const pr = context.pullRequest;
  if (!pr?.sameRepository) return false;
  const filter = rule.pullRequest;
  return (
    (filter.state === undefined || filter.state === "all" || filter.state === pr.state) &&
    (filter.draft === undefined || filter.draft === pr.draft) &&
    (filter.baseBranches === undefined || filter.baseBranches.includes(pr.baseBranch))
  );
}
