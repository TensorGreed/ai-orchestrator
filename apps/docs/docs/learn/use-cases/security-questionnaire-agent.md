---
title: "Answer security questionnaires with a cited RAG agent"
sidebarTitle: "Security questionnaires"
description: "Draft answers to vendor security questionnaires from your own policies with citations, flag what they do not cover, and have an owner approve every answer."
level: intermediate
related: [rag, grounding, approval-gate, golden-set, audit-log]
---

# Answer security questionnaires with a cited RAG agent

A security questionnaire agent uses <Term id="rag">retrieval-augmented generation</Term>: it reads each question, finds the passage in your policies that answers it, drafts a short answer with a citation to that passage, and marks every question your policies do not cover for a person to answer. The key safety choice is that nothing goes back to the customer until a named owner has reviewed the whole set and approved it, with their edits and decision on record. In L2M you build it from a policy knowledge base, a per-question sub-workflow with citations, a loop, and an Approval Gate.

## The job

Customers and auditors send long lists of security questions, usually as a spreadsheet. Many are yes/no questions with room for a sentence of explanation. The Cloud Security Alliance's CAIQ, a widely used public questionnaire, is described as "a set of Yes/No questions a cloud consumer and cloud auditor may wish to ask of a cloud provider". Their topics line up with the control families of catalogs such as NIST SP 800-53, which groups its controls into families like Access Control, Audit and Accountability, and Incident Response. The same twenty topics come back in every questionnaire, worded a little differently each time.

| | |
|---|---|
| **Input** | A list of questions with ids (`IAM-01`, `LOG-02`...), as CSV or a sheet |
| **Knowledge** | Your policies, standards and previously approved answers, in a knowledge base |
| **Output** | One row per question: the answer, the sources it cites, and a status (`draft` or `needs_owner`) |
| **Never** | An answer sent out unreviewed, or a "Yes" with no policy behind it |

**Agent or fixed workflow?** Each question is answered the same way: retrieve, draft, cite. That is a fixed workflow run once per question, not an agent deciding what to do next. It is cheaper, its steps show in the trace, and a test can pin each one down. An agent with tools earns its place only for the few questions that need a live lookup, such as "list your sub-processors" against a system of record. See [workflows vs agents](/learn/agents/workflows-vs-agents).

**Where it helps and where it does not.** It is good at finding the right paragraph across many policy documents and drafting a consistent answer. It cannot know what your policies do not say, and a questionnaire answer is a statement your company makes to a customer. That is why the design treats every model answer as a draft.

## The design

<figure class="recipe-diagram">
<svg viewBox="0 0 930 260" role="img" aria-labelledby="sqa-title sqa-desc" xmlns="http://www.w3.org/2000/svg"><title id="sqa-title">Security questionnaire workflow</title><desc id="sqa-desc">The main workflow reads the questions with Extract from File, loops over them with Loop / ForEach, and calls a sub-workflow once per question with Execute Workflow. After the loop a Set / Transform node collects the answer rows into one key and an Approval Gate holds them for review, and the approved answers are written back with Google Sheets: Append. The sub-workflow runs RAG Retrieve, Prompt Template, LLM Call, Extract Citations and an Output that builds one answer row.</desc><path class="rd-edge" d="M160 47 L170 47"/><path class="rd-edge" d="M310 47 L320 47"/><path class="rd-edge" d="M460 47 L470 47"/><path class="rd-edge" d="M610 47 L620 47"/><path class="rd-edge" d="M760 47 L770 47"/><path class="rd-edge" d="M160 197 L170 197"/><path class="rd-edge" d="M310 197 L320 197"/><path class="rd-edge" d="M460 197 L470 197"/><path class="rd-edge" d="M610 197 L620 197"/><path class="rd-edge" d="M90 224 L90 244 L540 244 L540 224"/><text class="rd-type" x="20" y="130">Sub-workflow, run once per question by Execute Workflow</text><g class="rd-node" data-kind="step" transform="translate(20 20)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Questions</text><text class="rd-type" x="10" y="40">extract_from_file_node</text></g><g class="rd-node" data-kind="step" transform="translate(170 20)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Each question</text><text class="rd-type" x="10" y="40">loop_node</text></g><g class="rd-node" data-kind="step" transform="translate(320 20)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Answer one</text><text class="rd-type" x="10" y="40">execute_workflow</text></g><g class="rd-node" data-kind="step" transform="translate(470 20)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Collect rows</text><text class="rd-type" x="10" y="40">set_node</text></g><g class="rd-node" data-kind="step" transform="translate(620 20)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Owner review</text><text class="rd-type" x="10" y="40">approval_gate</text></g><g class="rd-node" data-kind="tool" transform="translate(770 20)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Hand back</text><text class="rd-type" x="10" y="40">google_sheets_append</text></g><g class="rd-node" data-kind="step" transform="translate(20 170)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Find policy</text><text class="rd-type" x="10" y="40">rag_retrieve</text></g><g class="rd-node" data-kind="step" transform="translate(170 170)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Answer rules</text><text class="rd-type" x="10" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(320 170)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Draft</text><text class="rd-type" x="10" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(470 170)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Citations</text><text class="rd-type" x="10" y="40">extract_citations</text></g><g class="rd-node" data-kind="step" transform="translate(620 170)"><rect width="140" height="54" rx="10"/><text class="rd-name" x="10" y="22">Answer row</text><text class="rd-type" x="10" y="40">output</text></g></svg>
<figcaption>Top: the main workflow. Bottom: the sub-workflow it calls for each question. Retrieve also feeds Extract Citations, so every marker resolves to a policy chunk.</figcaption>
</figure>

**The knowledge base.** Upload your policies under **Knowledge** (Markdown, HTML, plain text, CSV or JSON; extract the text of PDFs and Word files first). Give each policy a `sourceId` that a reviewer recognises, such as `access-control-policy`, since that is what the answer rows cite. A library of previously approved answers works well as a second source: upload it as CSV with `csv.textColumn` set to the answer column, and the other columns (question id, date approved) become metadata on each chunk. Keep the knowledge base in a project only the security team's workflows use ([knowledge bases](/nodes/knowledge-bases)).

**The per-question sub-workflow.** Retrieve with `searchMode: "hybrid"`, because questions quote exact terms (MFA, TLS 1.2, SOC 2) as often as they paraphrase. The prompt tells the model to answer only from the excerpts, to cite them with the `citationInstructions` the retrieve step emits, and to reply exactly `NOT FOUND` when the excerpts do not answer the question. Extract Citations resolves the markers, and the Output builds one row with the expression in its response template, for example `hasCitations ? "draft" : "needs_owner"` for the status.

**The loop.** Extract from File turns the CSV into `rows`, a Loop / ForEach node runs Execute Workflow once per row, and an input mapping passes `item.question` to the sub-workflow. Two details we hit on a test install:

- Map the question to a key such as `question`, not `user_prompt`. A sub-workflow's `user_prompt` is reset to the empty string, so a mapping onto it arrives empty. Then point the retrieve step's `queryTemplate` and the prompt at `question`; the retrieve step reads `user_prompt` by default.
- A Loop node stops after 100 items unless you raise `maxIterations`. A 250-question questionnaire needs it set.

## Where the approval goes

Use one <Term id="approval-gate">Approval Gate</Term> after the loop, not an approval per question and not "Ask before write tools". The reasons:

- The decision a person must make is about the whole set going to a customer, and that is one decision. Approving 200 answers one at a time breeds rubber-stamping.
- A gate cannot sit inside a loop body: loop bodies cannot pause part-way, and an approval inside one fails the loop. Gate the loop's output.
- There are no agent tool calls here to gate. "Ask before write tools" covers agents calling MCP write tools.

Configure the gate with the security owner as the approver, a message that lists the rows (the gate's message is a template, so it can read the loop's results), and an editable `json` field holding the answer rows. The owner fills in the `needs_owner` rows, corrects any draft, and approves. On our test install the gate's message showed both rows, including `"status": "needs_owner"` for the question about audit-log retention. ([Approve with edits](/product/approvals#approve-with-edits).)

How the edits reach the hand-back step matters. On approve, the gate passes on what it received, with the owner's edited fields laid on top under their keys; it does not rewrite the loop's own output. Two details:

- Put a Set / Transform node before the gate that copies the rows to a top-level key, say `answers`, and give the gate's editable field the same key. Read the rows from the loop's output, not from the Set node's parent: after the loop, Execute Workflow holds only the last question's row. Each pass's row is the sub-workflow Output's `result` text, so the assignment is <span v-pre>`{{ results["<loop id>"].items.map(i => JSON.parse(i.outputs["<execute id>"].result)) }}`</span>. Without the Set node, an approval adds `answers` with the value the owner saw, which was rendered from the template for display and can be cut short for a long questionnaire. With it, unedited rows arrive under `answers` exactly as the loop produced them, and edited ones replace them.
- Have the hand-back step read the rows from the gate's output: <span v-pre>`{{answers}}`</span> when it comes straight after the gate, <span v-pre>`{{results.<gate id>.answers}}`</span> from further down. The loop's own output still holds the drafts.

Edits are capped at 64 KiB per decision, so a very long questionnaire may need to go to review in batches. We did not run an approval through to the hand-back step on our test install; this behaviour is from the gate's code.

The trail is what makes this defensible later. The <Term id="audit-log">audit log</Term> records `approval.requested` and `approval.decided`, with who decided, the reason and the keys of the edited fields; it stores a digest of the edits, not the values. The run's signed manifest lists the same decision ([audit bundles](/security/audit-bundles)). Uploads through **Knowledge** (or the upload API) and deletions of policy sources are audited too, so you can show which policies existed when an answer was approved. The lower-level `/ingest` route writes no audit entry, so add policies by upload.

## Keeping the answers honest

Two things go wrong with model-drafted answers: a "Yes" that no policy supports, and a citation that points at the wrong document. Three layers catch them:

1. **The `NOT FOUND` rule** and the status column. An answer with no resolved citation is `needs_owner` whatever it says.
2. **The <Term id="grounding">grounding</Term> check.** An Output Guardrail with `checks: ["grounding"]` after Extract Citations flags claims whose words the cited chunk does not contain, and markers that name no retrieved chunk. In a separate run with a scripted stand-in model, it failed an answer that cited a non-existent `[7]` and one that cited the billing chunk for a claim about an error code. With `onFail: "error"` a flagged answer fails the run, which stops a long questionnaire part-way, so you may prefer to run the check in your tests (below). It compares words, so a paraphrase can be flagged; see [grounding in sources](/product/content-rules-output-checks#grounding-in-sources).
3. **The owner's review**, which is the control that matters.

## How to test it

Make a <Term id="golden-set">golden set</Term> for the sub-workflow from real past questions, with the answers your team approved ([golden sets](/product/golden-sets)):

| Case | Input | A pass |
|---|---|---|
| Covered | "Do you enforce MFA for administrative access?" | Cites the access control policy; agrees with the approved answer |
| Reworded | "Is two-factor required for admins?" | Same source as the case above (hybrid search plus wording) |
| Not covered | "Do you hold ISO 27701 certification?" when you do not | `NOT FOUND`, status `needs_owner`, no citation |
| Trap | "Confirm you encrypt backups with AES-256" when the policy names no algorithm | Does not confirm the algorithm |
| Exact string | "Which TLS versions do you support?" | Retrieves the chunk that names the versions |

Score with `contains` or `regex` for the status and the key facts, and `llm_judge` with a rubric such as "agrees with the approved answer and asserts nothing the excerpt does not say". A judge needs `EVAL_JUDGE_ENABLED=true` and a provider secret, or the server's own keys if the operator allows them. Replays of [golden runs](/product/golden-runs) answer the retrieval step from the recording, so they test prompt and model changes; when you add or rewrite policies, rerun the hand-written cases live with an eval run.

## What it costs to run

One model call per question, one embedding per question, and one embedding per policy chunk at upload. The prompt per question is the instructions plus `topK` excerpts, so `topK` and the chunk size set most of the cost; 4 excerpts of a few hundred words each is a reasonable start. A 200-question questionnaire is 200 model calls, run one after another. Cap spend with a [budget](/product/budgets) on the workflow, and check the run's token usage after the first real questionnaire before you tune anything.

## Starting point, honestly

No sample does the whole job. [`rag-with-citations-flow.json`](/recipes/rag-with-citations) is the per-question sub-workflow minus the `NOT FOUND` rule and the answer row: retrieve with hybrid search, a citation prompt, an LLM and Extract Citations (as shipped, `openai-embedder` and `gpt-4o-mini`; the recipe shows how to run it without a key). The [knowledge base recipe](/recipes/rag-knowledge-base) shows how to create the knowledge base and upload a document.

What you build yourself: the policy knowledge base, the prompt rules and the answer row in a copy of the citations sample, the main workflow (Extract from File, Loop / ForEach with `maxIterations` raised, Execute Workflow, Set / Transform, Approval Gate), and the hand-back step. Google Sheets: Append needs a Google credential stored as a secret; a Convert to File node is the alternative when the answers go back as a file. We ran the loop, the sub-workflow and the gate's pause on a local install with a scripted stand-in model and a token-based demo embedder, not a real model; we did not run the Sheets step.

Related jobs: the same knowledge base can power an [internal docs Q&A agent](/learn/use-cases/internal-docs-qa-agent), and a [research agent with citations](/learn/use-cases/research-agent-with-citations) covers longer answers checked the same way. [Refunds with approval](/learn/use-cases/refund-approval-agent) shows the gate guarding money instead of statements.

## Further reading

- [STAR Level 1: Security Questionnaire (CAIQ v4.1)](https://cloudsecurityalliance.org/artifacts/star-level-1-security-questionnaire-caiq-v4) (cloudsecurityalliance.org): the Cloud Security Alliance's public questionnaire
- [NIST SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) (csrc.nist.gov): the catalog of security and privacy controls, by family
- [Approval gates](/product/approvals): approvers, timeouts, edits and the audit trail
- [Knowledge bases](/nodes/knowledge-bases): uploads, CSV loading, hybrid search and citations
- [Human in the loop for AI agents](/learn/agents/human-in-the-loop)
