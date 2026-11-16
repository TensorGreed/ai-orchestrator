---
title: "Data exfiltration through AI agents"
term: "Data exfiltration"
topic: security
definition: "Data leaving a system without permission. Through an agent it can leave in a tool call, a link, an image URL or a webhook the model was steered to use."
description: "Exfiltration through an agent means data leaving via a tool call, a link, an image URL or a webhook. The common channels and the controls that close them."
related: [lethal-trifecta, indirect-prompt-injection, data-labels, least-privilege, ssrf, sensitive-information-disclosure]
guide: [/learn/security/lethal-trifecta]
---

# Data exfiltration

**Data leaving a system without permission. Through an agent it can leave in a tool call, a link, an image URL or a webhook the model was steered to use.**

In a classic breach, an attacker gets into a system and copies data out. With an agent, the attacker often never gets in. They place instructions where the agent will read them, such as an email, a web page or a tool result, and the agent copies the data out for them, using the access it was given for honest work. This is why exfiltration is the usual payoff of <Term id="indirect-prompt-injection">indirect prompt injection</Term>, and why Simon Willison's <Term id="lethal-trifecta">lethal trifecta</Term> names "the ability to externally communicate" as one of its three ingredients.

## How data leaves an agent

- **Tool arguments.** The data goes into a call the agent was always allowed to make: a search query, an email subject, a ticket comment, an HTTP request. OWASP's MCP Security Cheat Sheet calls this exfiltration "via legitimate channels".
- **URLs in the answer.** The model writes a Markdown image or link whose query string carries the data. If the chat client loads images automatically, the data leaves as soon as the answer is shown, with no click at all.
- **Writes others can read.** A public issue comment, a shared document or a message in an outside channel.
- **Errors and echoes.** A tool that repeats its input in an error message or a log that someone outside can read.

## Example

OWASP's entry on prompt injection (LLM01:2025) describes this case: a user asks a model to summarise a web page that hides instructions, and the instructions make the model insert an image that links to a URL, and loading it sends the private conversation out. The user sees a summary. The attacker's server log sees the conversation.

## Common confusion

Exfiltration is not the same as the model revealing something it should not in its answer to the user (<Term id="sensitive-information-disclosure">sensitive information disclosure</Term>). There the wrong person reads the answer; in exfiltration the data travels to a place the attacker controls, often without anyone noticing. It is also not <Term id="ssrf">SSRF</Term>, which makes your server reach into your own network; the two often combine, when SSRF reads a cloud credential that is then sent out.

## In L2M

All of these are optional. [Data labels](/product/data-labels-and-destinations#data-labels) record where each step's data came from and, with tracking on, what it contains. [Destination rules](/product/data-labels-and-destinations#data-destinations) then block, mask or ask for approval when data classes such as card numbers or credentials would go further than a tier you allow; they are checked just before model calls, MCP calls, HTTP requests and connector sends leave. A safety preset denies open-world tools while the agent's context holds sensitive data ([untrusted content and write tools](/guides/govern-mcp-tools#untrusted-content-and-write-tools)). Content rules can also flag image and link URLs that carry data in model output and tool arguments ([detectors](/product/content-rules-engine#detectors)). What a local stdio MCP server sends on its own is outside L2M's view.

## Further reading

- [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (Simon Willison, June 2025)
- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) (OWASP Gen AI Security Project), scenario 2
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (OWASP Cheat Sheet Series)
