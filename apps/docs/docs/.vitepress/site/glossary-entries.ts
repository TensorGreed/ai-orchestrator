// Glossary terms that have a short entry on the A–Z index (/glossary/) but no page of their own.
// A term gets a page only when it can carry 150+ words of real substance; until then it lives here,
// with its one-sentence definition and, where L2M has a matching feature, a link to that docs page.
// Writing docs/glossary/<slug>.md promotes a term: the page then wins and this entry is ignored,
// so keep the slug the same. Imports nothing from Node, so the config and the theme can both use it.

export interface IndexEntry {
  /** The slug a page would have: the index anchor is /glossary/#<slug>. */
  slug: string;
  term: string;
  /** One of GLOSSARY_TOPICS. */
  topic: string;
  definition: string;
  /** A docs path for "In L2M", when L2M has a matching feature. */
  docs?: string;
}

export const INDEX_ENTRIES: IndexEntry[] = [
  // MCP
  {
    slug: "mcp-host",
    term: "MCP host",
    topic: "mcp",
    definition: "The AI application, such as a chat app, an IDE or an agent runtime, that creates MCP clients, connects them to servers and decides what the model may use.",
    docs: "/runtime/agent-loop"
  },
  {
    slug: "mcp-resource",
    term: "MCP resource",
    topic: "mcp",
    definition: "Data an MCP server shares by URI, such as a file or a record, for the application to read. Unlike a tool, it is usually the application, not the model, that decides when to read it.",
    docs: "/product/mcp-server-registry#resources-and-prompts"
  },
  {
    slug: "mcp-prompt",
    term: "MCP prompt",
    topic: "mcp",
    definition: "A reusable message template an MCP server offers, with named arguments, for a person or application to pick, rather than for the model to call.",
    docs: "/product/mcp-server-registry#resources-and-prompts"
  },
  {
    slug: "mcp-session",
    term: "MCP session",
    topic: "mcp",
    definition: "Over Streamable HTTP, the state that ties a client's requests together: if the server returns an MCP-Session-Id when the client initializes, the client sends it with every later request.",
    docs: "/product/mcp-gateway"
  },
  {
    slug: "structured-tool-output",
    term: "Structured tool output",
    topic: "mcp",
    definition: "A tool result returned as JSON in structuredContent, besides the text content. A tool that declares an outputSchema must return results that match it.",
    docs: "/product/mcp-server-registry#structured-output"
  },
  {
    slug: "elicitation",
    term: "Elicitation (MCP)",
    topic: "mcp",
    definition: "An MCP server asking the person for input through the client, usually while it handles a request such as a tool call: a message with a simple form, or a URL to open for sensitive steps.",
    docs: "/product/mcp-server-registry#elicitation-a-server-asks-the-person-a-question"
  },
  {
    slug: "sampling",
    term: "Sampling (MCP)",
    topic: "mcp",
    definition: "An MCP server asking the client to run a model call on its behalf, so a tool can use the client's model without its own API key.",
    docs: "/product/mcp-server-registry#sampling-a-server-asks-the-model-for-a-completion"
  },
  {
    slug: "write-tool",
    term: "Write tool",
    topic: "mcp",
    definition: "A tool that can change something outside the agent, such as a file, a record or a message, as opposed to a read-only tool that only fetches data.",
    docs: "/product/mcp-tool-policy#read-only-classification"
  },
  {
    slug: "breaking-change",
    term: "Breaking change (MCP tool)",
    topic: "mcp",
    definition: "A change to a server's tools that can break existing callers, such as a removed tool, a removed input property or a new required argument.",
    docs: "/product/mcp-server-registry#what-counts-as-a-breaking-change"
  },
  {
    slug: "oauth-2-1",
    term: "OAuth 2.1",
    topic: "mcp",
    definition: "A draft consolidation of OAuth 2.0 and its security best practices, such as PKCE for every client. MCP authorization for HTTP servers builds on it.",
    docs: "/product/mcp-server-registry#oauth-for-remote-servers"
  },
  {
    slug: "pkce",
    term: "PKCE",
    topic: "mcp",
    definition: "Proof Key for Code Exchange: the client sends a hash (S256) of a one-time secret with the authorization request and the secret itself when it redeems the code, so a stolen code is useless. MCP clients must use it."
  },
  {
    slug: "delegated-credentials",
    term: "Delegated credentials",
    topic: "mcp",
    definition: "Each person's own account is used for a tool call, instead of one shared service credential, so the server sees who is acting and applies their permissions.",
    docs: "/product/mcp-server-registry#delegated-credentials"
  },
  // Agents and retrieval
  {
    slug: "worker-agent",
    term: "Worker agent",
    topic: "agents",
    definition: "A specialist agent, with its own model, tools and instructions, that a supervisor agent calls like a tool for one part of a task.",
    docs: "/runtime/agent-loop#attachment-ports"
  },
  {
    slug: "max-iterations",
    term: "Max iterations",
    topic: "agents",
    definition: "The most rounds of model call and tool calls an agent may take in one run. When it is reached, the agent stops instead of looping on.",
    docs: "/troubleshooting/common-issues#agent-hits-max-iterations"
  },
  {
    slug: "workflow-dag",
    term: "Workflow DAG",
    topic: "agents",
    definition: "A workflow drawn as a directed acyclic graph: steps joined by edges that never loop back, run in the order their inputs allow.",
    docs: "/product/workflow-editor"
  },
  {
    slug: "token-llm",
    term: "Token (LLM)",
    topic: "agents",
    definition: "The unit a language model reads and writes: a word, part of a word or a punctuation mark. Context limits, prices and rate limits are all counted in tokens."
  },
  {
    slug: "approval-gate",
    term: "Approval gate",
    topic: "agents",
    definition: "A step that pauses a run until a person approves or rejects what happens next, such as a payment, an email or a write tool call.",
    docs: "/product/approvals"
  },
  {
    slug: "session-tool-cache",
    term: "Session tool cache",
    topic: "agents",
    definition: "A store of full tool results kept outside the prompt for one conversation, so the agent can fetch an earlier result again instead of calling the tool twice.",
    docs: "/runtime/agent-loop#session-tool-cache-multi-turn-reuse"
  },
  // Security
  {
    slug: "tool-shadowing",
    term: "Tool shadowing",
    topic: "security",
    definition: "One MCP server's tool descriptions changing how an agent uses another server's tools, for example by telling it to copy data into every email it sends."
  },
  {
    slug: "jailbreak",
    term: "Jailbreak",
    topic: "security",
    definition: "Input written to make a model ignore its safety rules. OWASP treats it as a form of prompt injection; prompt injection more broadly hijacks an application's instructions."
  },
  {
    slug: "data-exfiltration",
    term: "Data exfiltration",
    topic: "security",
    definition: "Data leaving a system without permission. Through an agent it can leave in a tool call, a link, an image URL or a webhook the model was steered to use.",
    docs: "/product/data-labels-and-destinations"
  },
  {
    slug: "ssrf",
    term: "SSRF",
    topic: "security",
    definition: "Server-side request forgery: making a server fetch a URL the attacker chose, such as an internal service or a cloud metadata address, from inside the network.",
    docs: "/security/outbound-url-checks"
  },
  {
    slug: "unbounded-consumption",
    term: "Unbounded consumption",
    topic: "security",
    definition: "OWASP LLM10: an application that lets users or agents run up model calls, tokens or compute without limits, which costs money and can deny service to others.",
    docs: "/product/budgets"
  },
  {
    slug: "sensitive-information-disclosure",
    term: "Sensitive information disclosure",
    topic: "security",
    definition: "OWASP LLM02: a model or app revealing personal data, credentials or confidential business data in its answers, logs or tool calls."
  },
  {
    slug: "system-prompt-leakage",
    term: "System prompt leakage",
    topic: "security",
    definition: "OWASP LLM07: the hidden instructions of an app getting out, which matters most when they hold secrets or describe access rules that should be enforced elsewhere."
  },
  {
    slug: "improper-output-handling",
    term: "Improper output handling",
    topic: "security",
    definition: "OWASP LLM05: passing a model's answer to another system (a browser, a shell, a database) without validating it first, so the answer can act as an attack."
  },
  {
    slug: "misinformation",
    term: "Misinformation (LLM)",
    topic: "security",
    definition: "OWASP LLM09: a model stating false or unsupported things with confidence, and people or systems acting on them without checking."
  },
  {
    slug: "pii",
    term: "PII",
    topic: "security",
    definition: "Personally identifiable information: data that identifies a person alone or combined with other data, such as a name, an email address or an ID number."
  },
  {
    slug: "protection-token",
    term: "Protection token",
    topic: "security",
    definition: "A placeholder that stands in for a sensitive value in a prompt or a log. A reversible token can be turned back into the value later, only where a rule allows it.",
    docs: "/product/content-rules#protection-port"
  },
  {
    slug: "secret-reference",
    term: "Secret reference",
    topic: "security",
    definition: "A pointer to a stored, encrypted secret that a workflow or config holds in place of the secret itself, so the raw value never appears in exports or responses.",
    docs: "/security/secrets"
  },
  {
    slug: "shadow-mode",
    term: "Shadow mode",
    topic: "security",
    definition: "Running a new rule on real traffic and recording what it would have done, without enforcing it, so you can check it before it blocks anything.",
    docs: "/product/mcp-tool-policy#shadow-mode"
  },
  // Testing
  {
    slug: "pass-at-k",
    term: "pass@k and pass^k",
    topic: "testing",
    definition: "Two ways to score k tries of the same test: pass@k is the chance that at least one try succeeds, pass^k the chance that all k succeed."
  },
  {
    slug: "regression-eval",
    term: "Regression eval",
    topic: "testing",
    definition: "An eval that checks a system still does what it did before a change. It should pass nearly every time; a failure means something broke."
  },
  {
    slug: "grader",
    term: "Grader",
    topic: "testing",
    definition: "The logic that scores one result in an eval: an exact comparison, a schema check, a script, a model acting as judge, or a person."
  },
  {
    slug: "llm-as-judge",
    term: "LLM as judge",
    topic: "testing",
    definition: "Using a language model to grade another model's output against a written rubric, for qualities that exact comparisons cannot check.",
    docs: "/product/golden-sets#llm-judge"
  },
  {
    slug: "cassette",
    term: "Cassette",
    topic: "testing",
    definition: "A recording of the outside calls a run made, with their answers, so a later test run can be answered from it instead of calling the real services.",
    docs: "/product/testing-mcp-workflows#record-and-replay"
  },
  {
    slug: "snapshot-mock",
    term: "Snapshot mock",
    topic: "testing",
    definition: "A stand-in MCP server built from a real server's recorded tool schemas, so tests can run without the real server or a network.",
    docs: "/product/testing-mcp-workflows#snapshot-mock-servers"
  },
  {
    slug: "production-capture",
    term: "Production capture",
    topic: "testing",
    definition: "Recording a sample of real production runs, with personal data masked, so the useful ones can become test cases.",
    docs: "/product/production-capture"
  },
  // Operations and governance
  {
    slug: "openai-compatible-api",
    term: "OpenAI-compatible API",
    topic: "operations",
    definition: "An HTTP API that accepts the same requests as OpenAI's API (such as /v1/chat/completions), so any client built for it can switch servers by changing the base URL.",
    docs: "/product/ai-gateway"
  },
  {
    slug: "model-allowlist",
    term: "Model allowlist",
    topic: "operations",
    definition: "A list of the providers and models an organization permits. Calls to any other model are refused.",
    docs: "/security/model-allowlists"
  },
  {
    slug: "rate-limit",
    term: "Rate limit",
    topic: "operations",
    definition: "A cap on how many requests a caller may make in a period, so one client cannot flood a service or run up its costs.",
    docs: "/product/mcp-gateway#rate-limits"
  },
  {
    slug: "rbac",
    term: "RBAC",
    topic: "operations",
    definition: "Role-based access control: permissions are given to roles, such as admin or viewer, and people get roles, rather than permissions one by one.",
    docs: "/security/auth-rbac#roles"
  },
  {
    slug: "sso",
    term: "SSO",
    topic: "operations",
    definition: "Single sign-on: people sign in once with their organization's identity provider and reach many apps without a separate password for each.",
    docs: "/security/auth-rbac#oidc-single-sign-on"
  },
  {
    slug: "oidc",
    term: "OIDC",
    topic: "operations",
    definition: "OpenID Connect: an identity layer on top of OAuth 2.0 that tells an app who signed in, using signed ID tokens from an identity provider.",
    docs: "/security/auth-rbac#oidc-single-sign-on"
  },
  {
    slug: "saml",
    term: "SAML",
    topic: "operations",
    definition: "Security Assertion Markup Language: an older XML-based standard for single sign-on, where the identity provider sends a signed assertion about the user.",
    docs: "/security/auth-rbac#saml-single-sign-on"
  },
  {
    slug: "mfa",
    term: "MFA",
    topic: "operations",
    definition: "Multi-factor authentication: signing in with a second proof, such as a one-time code from an authenticator app, as well as a password or SSO.",
    docs: "/security/auth-rbac#mfa-required-per-role"
  },
  {
    slug: "service-account",
    term: "Service account",
    topic: "operations",
    definition: "An account for a program rather than a person, such as a CI job, with its own keys and its own limited permissions.",
    docs: "/security/service-accounts"
  },
  {
    slug: "audit-log",
    term: "Audit log",
    topic: "operations",
    definition: "A record of who did what and when, such as changes to settings, rules and secrets, kept so that actions can be checked later."
  },
  {
    slug: "signed-run-manifest",
    term: "Signed run manifest",
    topic: "operations",
    definition: "A record of what one run did, signed with a private key, so anyone with the public key can check later that it was not changed.",
    docs: "/security/audit-bundles"
  },
  {
    slug: "data-retention",
    term: "Data retention",
    topic: "operations",
    definition: "How long each kind of stored data is kept before it is deleted, such as run history, tool-call logs and agent memory.",
    docs: "/operations/data-retention"
  },
  {
    slug: "legal-hold",
    term: "Legal hold",
    topic: "operations",
    definition: "An instruction to keep certain data from being deleted, whatever its age, because it may be needed for a legal matter.",
    docs: "/operations/legal-hold"
  },
  {
    slug: "data-subject-request",
    term: "Data-subject request",
    topic: "operations",
    definition: "A person's request to an organization about their own personal data, such as a copy of it or its deletion, under privacy laws like the GDPR.",
    docs: "/security/data-subject-requests"
  },
  {
    slug: "right-to-erasure",
    term: "Right to erasure",
    topic: "operations",
    definition: "The GDPR right (Article 17) to have one's personal data deleted on certain grounds, with exceptions, for example data needed for legal claims.",
    docs: "/security/data-subject-requests#deleting-a-persons-data"
  },
  {
    slug: "subject-reference",
    term: "Subject reference",
    topic: "operations",
    definition: "A value saved with a run that identifies the person the run was about, so that person's runs can be found later without searching every record.",
    docs: "/security/data-subject-requests#subject-references"
  },
  {
    slug: "self-hosted",
    term: "Self-hosted",
    topic: "operations",
    definition: "Software that you run on your own servers or cloud account, so its data and its keys stay under your control.",
    docs: "/operations/scaling"
  },
  {
    slug: "sbom",
    term: "SBOM",
    topic: "operations",
    definition: "Software bill of materials: a list of every component and version inside a piece of software, used to check it for known vulnerabilities and licences.",
    docs: "/operations/verify-a-release#_4-get-and-inspect-the-sboms"
  },
  {
    slug: "master-key",
    term: "Master key",
    topic: "operations",
    definition: "The one key that encrypts the other stored secrets. Without it the stored secrets cannot be decrypted, so it is backed up apart from the database.",
    docs: "/security/secrets"
  },
  {
    slug: "opentelemetry",
    term: "OpenTelemetry",
    topic: "operations",
    definition: "An open standard and set of tools for traces, metrics and logs, sent over its own protocol (OTLP) to any compatible backend.",
    docs: "/operations/opentelemetry"
  },
  {
    slug: "tool-call-telemetry",
    term: "Tool-call telemetry",
    topic: "operations",
    definition: "A record of every tool call an agent or client makes: which tool, how long it took, whether it failed, and what it cost.",
    docs: "/product/mcp-tool-call-telemetry"
  }
];
