---
title: "OWASP Top 10 for LLM apps, explained for agents"
sidebarTitle: "OWASP Top 10 for LLM apps"
description: "The ten OWASP LLM risks for 2025, one by one, with what each looks like in an agent that calls tools and a concrete control for each one."
level: intermediate
related: [prompt-injection]
socialCard: true
---

# The OWASP Top 10 for LLM applications

The OWASP Top 10 for LLM Applications is a ranked list of the ten most important security risks in software built on large language models, maintained by the OWASP Gen AI Security Project. The current edition is 2025. It was written for LLM apps in general, but every entry gets sharper in an agent, because an agent turns model output into actions. This guide walks through the ten entries, shows what each looks like in an agent that calls tools, and names a control for each, including where L2M has one and where it does not.

## What the list is

OWASP (the Open Worldwide Application Security Project) is a non-profit known for its Top 10 of web application risks. Its Gen AI Security Project publishes the [Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/) under a Creative Commons licence. Each entry has its own page with a description, examples, attack scenarios and mitigations. The 2025 edition replaced the 2023/24 list.

The list is a vocabulary and a checklist, not a standard you certify against. Its value in a review is that it makes you ask ten specific questions instead of one vague one.

## The ten risks, for an agent

Each entry below has four parts: what OWASP means, what it looks like in an agent, one control that helps, and what L2M offers. Where L2M has no direct control, the entry says so.

### LLM01: Prompt injection

**What it is.** <Term id="prompt-injection">Prompt injection</Term>: input that makes the model follow instructions the developer did not intend, typed by the user (direct) or hidden in content the model reads (indirect).

**In an agent.** A web page, email or tool result tells the agent to call a tool it should not, with arguments the attacker chose. The injection is the entry point; the tool call is the damage.

**A control.** Layers: mark outside content, give the agent fewer and narrower tools, ask a person before risky actions, and test with attack cases. No single filter is enough. The [prompt injection guide](/learn/security/prompt-injection) covers each layer.

**In L2M.** When no rule set is bound to an agent's project or workflow, the agent gets a built-in default rule set. It blocks known injection patterns in prompts and tool results, and command, SQL and path attacks in tool arguments; spotlighting, approval before write tools and approval after untrusted content are optional ([where content rules run](/product/content-rules#where-content-rules-run)).

### LLM02: Sensitive information disclosure

**What it is.** The application reveals personal data, credentials or confidential business information through what the model says or does.

**In an agent.** The agent reads a customer record to answer one question and repeats it to the wrong person, or puts an API key it found in a file into a tool argument that goes to a third party.

**A control.** Keep sensitive values out of the model's context unless the step needs them: mask or tokenise them on the way in, and restore them only at the step that must see the real value. Keep credentials out of prompts entirely.

**In L2M.** The default rule set redacts credentials in prompts, tool results and answers, and masks card numbers in tool results and answers. In tool arguments it blocks private keys and sends likely exfiltration to review, but lets other credentials through, so add a rule set for the API-key case above. Optionally, a [protection port](/product/content-rules#protection-port) masks, hashes, encrypts or tokenises values before a model sees them, and a [Reveal node](/product/content-rules#reveal-node) restores them only where a rule allows. Secrets are stored encrypted and referenced by id, never pasted into configs ([secrets](/security/secrets#design)).

### LLM03: Supply chain

**What it is.** Risk that comes in through third-party parts: models, datasets, packages, plugins and the platform you run them on.

**In an agent.** The agent's tools come from MCP servers someone else wrote and published. An unpinned server package can change under you; a compromised one runs with your credentials.

**A control.** Install from sources you trust, pin exact versions, verify signatures where they exist, and keep an inventory (an SBOM) of what you run.

**In L2M.** Release images are signed, ship build provenance and CycloneDX SBOMs, and can be checked before you deploy them ([verify a release](/operations/verify-a-release#what-each-release-contains)). An optional [deployment catalog](/product/mcp-onboarding#deployment-catalog) limits local MCP servers to a reviewed list with exact versions. Community node packages are off by default and installed without running install scripts ([threat model](/extensions/community-nodes#threat-model)).

### LLM04: Data and model poisoning

**What it is.** Training, fine-tuning or embedding data is tampered with to plant backdoors, biases or wrong behaviour.

**In an agent.** Most agent builders do not train models, so the practical version is poisoned retrieval data: a document in the knowledge base that carries false facts or hidden instructions, read by the agent as trusted context.

**A control.** Track where documents come from, limit who can add them, and treat retrieved text as outside content, not as instructions.

**In L2M.** No direct control: L2M does not train or fine-tune models and does not scan documents when they are added to a knowledge base. At run time, rule sets can check retrieved documents as outside content, and optionally drop a document that fails a check before it reaches the model ([outside content at the model boundary](/product/content-rules#outside-content-at-the-model-boundary)).

### LLM05: Improper output handling

**What it is.** Model output passed to another component without validation: into a browser (cross-site scripting), a shell, a SQL query or a URL fetch.

**In an agent.** Every tool call is model output used as input. A SQL tool that runs whatever query the model writes, or a fetch tool that requests whatever URL it names, is this risk.

**A control.** Treat model output like user input: validate it against a schema, encode it for where it goes, use parameterised queries, and check URLs before fetching them.

**In L2M.** The [Output Parser](/nodes/core-nodes#output-parser-output-parser) node validates answers against a JSON schema. Rule sets check tool arguments for SQL, command and path patterns, and optional [output checks](/product/content-rules-output-checks) validate the final answer. The HTTP Request node goes through [outbound URL checks](/security/outbound-url-checks), and code nodes run in a container when docker or podman and the sandbox images are present. Without one, JavaScript runs in a WebAssembly sandbox and Python code nodes fail, unless the deployment allows host Python, which is not sandboxed ([code execution](/security/code-execution)).

### LLM06: Excessive agency

**What it is.** Excessive agency: the application can take harmful actions because it has more functionality, permissions or autonomy than its task needs. OWASP names those three root causes.

**In an agent.** This is the central agent risk. A support agent connected to a server with 40 tools, including `delete_customer`, has excessive functionality even if it never calls it, because an injection or a bad plan can.

**A control.** Give each agent only the tools it needs, limit their arguments, run them with the user's permissions, and require approval for high-impact actions. Put the check in code, not in the prompt.

**In L2M.** [MCP tool policy](/product/mcp-tool-policy) rules allow, deny or require approval per server, tool and argument value, and can run in shadow mode first. A workflow can switch off write tools, or ask a person before each write tool call ([approval before write tools](/product/approvals#approval-before-write-tools)). **No write tools** trusts a server's `readOnlyHint` unless an admin marks the tool, so mark the tools of servers you do not fully trust. The approval gate trusts only an admin's marking, so an unmarked tool always counts as a write. Every agent node has an iteration limit.

### LLM07: System prompt leakage

**What it is.** The system prompt contains something that should not be seen, such as credentials, internal rules or how permissions work, and the model reveals it. OWASP's point is that a system prompt is not a secret and not a security control.

**In an agent.** A system prompt that says "the admin password for the billing tool is …" or "users on the free plan cannot call refund_order" leaks both a secret and the shape of the access checks.

**A control.** Keep secrets and authorization logic out of the system prompt entirely. Enforce permissions in code, so a leaked prompt reveals nothing that helps an attacker.

**In L2M.** Partly. The default rule set checks incoming prompts for prompt-extraction phrasing, and an optional canary token detects a planted marker if the model repeats it. There is no check that compares an answer with the real system prompt. Credentials belong in [secrets](/security/secrets), which nodes reference by id.

### LLM08: Vector and embedding weaknesses

**What it is.** Weaknesses in how embeddings are stored and retrieved in retrieval-augmented generation (RAG): one tenant's documents returned to another, poisoned entries, or source text recovered from embeddings.

**In an agent.** An agent searching a shared vector store returns another customer's documents because the search has no filter on who is asking.

**A control.** Enforce access control in the retrieval layer (per tenant, per project, per user), validate what goes into the store, and log retrievals.

**In L2M.** Partly. Built-in knowledge bases belong to a project, and a run can retrieve only from its own project's knowledge bases and from shared ones, which only an admin can add content to ([project access](/security/auth-rbac#project-access)). External vector stores rely on their own access control and the filter you configure on the node.

### LLM09: Misinformation

**What it is.** The model produces false or misleading content that looks credible, and people or systems act on it. Hallucination is the main cause.

**In an agent.** The agent answers a policy question from memory instead of from the policy document, and states a refund window that does not exist. Because it sounds sure, the customer believes it.

**A control.** Ground answers in retrieved sources, show citations, check that claims are supported by those sources, and make uncertainty visible to the reader.

**In L2M.** Retrieval nodes return citation instructions and an `extract_citations` node maps citation markers back to documents ([citations](/nodes/knowledge-bases#citations-phase-9-4)). An optional grounding check tests whether an answer is supported by the retrieved documents ([grounding in sources](/product/content-rules-output-checks#grounding-in-sources)), and RAG eval scorers measure faithfulness on test cases.

### LLM10: Unbounded consumption

**What it is.** Users or attackers drive uncontrolled inference: denial of service, runaway cost ("denial of wallet"), or copying a model through mass queries.

**In an agent.** A loop that never reaches a final answer calls the model again and again; a public endpoint lets anyone start expensive runs.

**A control.** Limit iterations, time, tokens and spend per run, per user and per client; rate-limit public entry points.

**In L2M.** Optional [budgets](/product/budgets#scopes) cap spend or tokens per project, workflow, user or gateway client and either warn or block. Gateway clients and registered servers can have rate limits. Agent nodes have an iteration limit and runs have an execution timeout.

## The agentic list (2026)

In December 2025 the same project published a second list, the [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/), for systems that plan and act across tools and steps. Its entries are:

| ID | Risk |
|---|---|
| ASI01 | Agent Goal Hijack |
| ASI02 | Tool Misuse and Exploitation |
| ASI03 | Identity and Privilege Abuse |
| ASI04 | Agentic Supply Chain Vulnerabilities |
| ASI05 | Unexpected Code Execution (RCE) |
| ASI06 | Memory & Context Poisoning |
| ASI07 | Insecure Inter-Agent Communication |
| ASI08 | Cascading Failures |
| ASI09 | Human-Agent Trust Exploitation |
| ASI10 | Rogue Agents |

The two lists overlap on purpose: the agentic document references the LLM Top 10 and builds on it. Goal hijack is where prompt injection leads in an agent; tool misuse and privilege abuse extend excessive agency. The agentic list also adds a principle it calls least agency: do not give a system autonomy it does not need, because agentic behaviour where it is not needed widens the attack surface without adding value. Read the LLM list for the model-level risks and the agentic list for what happens when the model is in a loop with tools, memory and other agents.

## How to use the list in a review

A short way to run a review of one agent:

1. **Draw the agent.** Its model, its tools (and which of them write), its data sources, its memory, who can call it, and where its output goes.
2. **Walk the ten entries** against that drawing. For each, write one line: does it apply, what is the worst case, which control covers it.
3. **Prefer controls outside the model.** A tool the agent cannot call, a budget it cannot exceed, an approval it cannot skip. Instructions in a prompt are the weakest control on the list.
4. **Write down what is not covered.** Several entries have no complete fix. Record the residual risk and who accepted it.
5. **Turn findings into tests.** An injection case, a forbidden tool call or an over-budget run becomes a regression test that runs on every change. See [regression testing AI agents](/learn/testing/regression-testing-agents).

## Further reading

- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) (OWASP Gen AI Security Project)
- [OWASP Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) (OWASP Gen AI Security Project, December 2025)
- [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (OWASP)
- [MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (OWASP Cheat Sheet Series)
