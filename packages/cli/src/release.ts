/**
 * `l2m release publish <workflowId> --version <n>`: publish a saved version
 * through the workflow's release gate (needs a server with release gates).
 *
 *   200 published                      exit 0
 *   202 needs approval                 exit 4, with the approval request id
 *   409 blocked by the gate            exit 1, with the reasons
 *   anything else, or unreachable      exit 1
 */
import { APPROVAL_REASON_MAX_LENGTH, releasePublishInputSchema, type ReleasePublishInput, type WorkflowRelease } from "@ai-orchestrator/shared";
import { apiCall, apiTarget, cleanServerText, isObject, replyError, RequestError, write, type CliIo } from "./api";
import { oneFlag, UsageError, type ParsedArgs } from "./args";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INCOMPLETE = 4;

export async function runReleasePublish(args: ParsedArgs, io: CliIo): Promise<number> {
  const [, , workflowId, extra] = args.positionals;
  if (!workflowId || extra) throw new UsageError("l2m release publish needs exactly one workflow id");
  const versionFlag = oneFlag(args, "version");
  if (versionFlag === undefined) throw new UsageError("l2m release publish needs --version <n>");
  if (!/^\d+$/.test(versionFlag.trim()) || Number(versionFlag) <= 0) throw new UsageError("--version must be a positive whole number");
  const hash = oneFlag(args, "hash");
  const run = oneFlag(args, "run");
  const overrideReason = oneFlag(args, "override-reason");
  const approvalReason = oneFlag(args, "request-approval");
  if (overrideReason !== undefined && approvalReason !== undefined) throw new UsageError("Choose --override-reason or --request-approval, not both");
  if (overrideReason !== undefined && !overrideReason.trim()) throw new UsageError("--override-reason needs a reason");
  if (approvalReason !== undefined && !approvalReason.trim()) throw new UsageError("--request-approval needs a reason");
  if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) throw new UsageError("--hash is a workflow hash: 64 lowercase hex characters");
  for (const [flag, text] of [["--override-reason", overrideReason], ["--request-approval", approvalReason]] as const) {
    if (text !== undefined && text.trim().length > APPROVAL_REASON_MAX_LENGTH) throw new UsageError(`${flag} can be at most ${APPROVAL_REASON_MAX_LENGTH} characters`);
  }
  const target = apiTarget(args, io);
  const body: ReleasePublishInput = {
    version: Number(versionFlag),
    ...(hash ? { workflowHash: hash } : {}),
    ...(run ? { replayRunId: run } : {}),
    ...(overrideReason !== undefined ? { override: { reason: overrideReason.trim() } } : {}),
    ...(approvalReason !== undefined ? { requestApproval: { reason: approvalReason.trim() } } : {})
  };
  const checked = releasePublishInputSchema.safeParse(body);
  if (!checked.success) throw new UsageError(`Invalid publish request: ${checked.error.issues[0]?.message ?? "invalid"}`);
  let reply;
  try {
    reply = await apiCall(target, "POST", `/api/workflows/${encodeURIComponent(workflowId)}/publish`, body);
  } catch (error) {
    if (error instanceof RequestError) {
      write(io.stderr, `l2m: publish failed: ${cleanServerText(error.message)}`);
      return EXIT_FAILED;
    }
    throw error;
  }
  const json = args.booleans.has("json");
  const answer = isObject(reply.body) ? reply.body : {};
  if (reply.status === 200) {
    const release: Partial<WorkflowRelease> = isObject(answer.release) ? answer.release : {};
    if (json) io.stdout.write(`${JSON.stringify({ ...answer, exitCode: EXIT_OK }, null, 2)}\n`);
    else {
      const verdict = typeof release.verdict === "string" ? ` (${cleanServerText(release.verdict)})` : "";
      write(io.stdout, `Published version ${Number(versionFlag)} of workflow ${cleanServerText(workflowId)}${verdict}.`);
    }
    return EXIT_OK;
  }
  if (reply.status === 202) {
    const requestId = typeof answer.approvalRequestId === "string" ? answer.approvalRequestId : null;
    if (json) io.stdout.write(`${JSON.stringify({ ...answer, exitCode: EXIT_INCOMPLETE }, null, 2)}\n`);
    else {
      write(io.stdout, `Publishing version ${Number(versionFlag)} needs approval${requestId ? `: request ${cleanServerText(requestId)}` : ""}. It is decided in the approvals inbox; nothing is published yet.`);
      for (const reason of Array.isArray(answer.reasons) ? answer.reasons.map(cleanServerText) : []) write(io.stdout, `  - ${reason}`);
    }
    return EXIT_INCOMPLETE;
  }
  if (reply.status === 409) {
    const reasons = Array.isArray(answer.reasons) ? answer.reasons.map(cleanServerText) : [];
    if (json) io.stdout.write(`${JSON.stringify({ ...answer, exitCode: EXIT_FAILED }, null, 2)}\n`);
    else {
      write(io.stdout, `Publishing version ${Number(versionFlag)} is blocked by the release gate${typeof answer.replayRunId === "string" ? ` (replay job ${cleanServerText(answer.replayRunId)})` : ""}.`);
      for (const reason of reasons) write(io.stdout, `  - ${reason}`);
      if (answer.canRequestApproval === true) write(io.stdout, "  Ask the gate's approvers with --request-approval <reason>.");
    }
    return EXIT_FAILED;
  }
  write(io.stderr, `l2m: publish failed with ${reply.status}: ${cleanServerText(replyError(reply))}${reply.status === 404 ? " (does the server have release gates?)" : ""}`);
  return EXIT_FAILED;
}
