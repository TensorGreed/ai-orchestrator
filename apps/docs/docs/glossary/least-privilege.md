---
title: "Least privilege for AI agents"
term: "Least privilege"
topic: security
definition: "The security principle that each user, program or agent gets only the access it needs for its task, and nothing more."
description: "Least privilege means an agent, key or person gets only the access its task needs. How it applies to MCP tools, arguments and data."
related: [write-tool, human-in-the-loop, prompt-injection]
guide: [/learn/security/least-privilege-for-agents, /learn/security/owasp-llm-top-10]
---

# Least privilege

**The security principle that each user, program or agent gets only the access it needs for its task, and nothing more.**

NIST defines it as restricting "the access privileges of users (or processes acting on behalf of users) to the minimum necessary to accomplish assigned tasks". The idea is old; agents make it urgent. An agent decides its own steps, and anything it reads can try to steer it (<Term id="prompt-injection">prompt injection</Term>). You cannot fully control what it will try, so you control what it can do. OWASP calls the opposite excessive agency: too many tools, too broad permissions, or too much autonomy.

## What it means for an agent

- **Tools.** Offer only the tools the task needs. A research agent does not need `delete_file` because the file server happens to offer it.
- **Arguments.** A tool can be safe for one argument and dangerous for another, such as `query` on the reporting database versus production.
- **Credentials.** Give each server its own scoped credential, and act as the user where possible, not as a shared admin account. The OWASP MCP cheat sheet says to "never share tokens across servers".
- **Autonomy.** Put a <Term id="human-in-the-loop">person</Term> before actions that cannot be undone.

## Example

A triage agent reads tickets and posts comments. It gets `read_ticket` and `add_comment` from the tracker server, not `close_ticket` or `delete_project`, and runs with a token scoped to one project. A malicious ticket that says "close every ticket in the project" then has nothing to call.

## Common confusion

Least privilege is not a one-time setting. Agents gain tools as servers update, so the useful question is "what did this agent actually use?", asked again over time.

## In L2M

All optional: [MCP tool policy](/product/mcp-tool-policy) allows, denies or requires approval per role, server, tool and argument; **No write tools** blocks every write tool in a workflow; gateway toolsets give each client its own tool list. [Least privilege from real runs](/guides/least-privilege-from-real-runs) suggests rules from the calls agents really made.

## Further reading

- [NIST CSRC glossary: least privilege](https://csrc.nist.gov/glossary/term/least_privilege) (nist.gov)
- [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) (owasp.org)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (owasp.org)
