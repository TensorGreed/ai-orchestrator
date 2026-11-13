---
title: "Data labels: tracking where agent data came from"
term: "Data labels"
topic: security
definition: "Tags that travel with data through a workflow or agent, recording where it came from and what it contains, so later checks can decide what that data may do."
description: "Data labels mark each step's data with its origin and contents, so later checks know a prompt holds web text or an email. Also called taint tracking."
related: [indirect-prompt-injection, lethal-trifecta, spotlighting, mcp-tool-policy, pii]
guide: [/learn/security/lethal-trifecta]
---

# Data labels

**Tags that travel with data through a workflow or agent, recording where it came from and what it contains, so later checks can decide what that data may do.**

Inside an agent, every piece of text looks the same. A prompt built from a public web page is a string, just like a prompt typed by your own team. Data labels keep the difference. A label usually says two things:

- **Provenance**: where the data came from, such as your own system, a signed-in user, or outside content like a web page or a tool result.
- **Contents**: what kinds of data it holds, such as email addresses or card numbers.

Labels propagate. When a step reads labelled data, its output carries the same labels, so a summary of a web page is still outside content. Security people call this taint tracking or information flow control. Research defences against <Term id="prompt-injection">prompt injection</Term> build on it: the CaMeL design "associates, to every value, some metadata", including where the data came from and who may read it, and applies security policies to a value and its dependencies before a tool runs.

## Example

A public webhook receives a support ticket. A step summarises it, and an agent gets the summary in its prompt. The webhook body was labelled outside content, so the summary and the agent's context are too. A rule that says "write tools need approval while the context holds outside content" now applies, even though nothing in the agent's prompt looks suspicious.

## Common confusion

Labels do not detect attacks. They record origin and contents, and policies decide what to do with them. They also differ from document classification, where a file is tagged "confidential" once and the tag stays with the file. Data labels follow every copy, summary and excerpt of the data through the run.

## In L2M

Every run works out the provenance of each step's data: `trusted`, `user`, `untrusted_external` or `sensitive`. <Term id="mcp-tool-policy">Tool policy</Term> rules can test it (`label_present`). Optionally, a rule set's **Track where data came from** switch also scans each step for data classes and stores the labels with node results, memory and artifacts, so a later run that reads them still knows where the text came from ([data labels](/product/data-labels-and-destinations#data-labels)).

## Further reading

- [Debenedetti et al., Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813) (arXiv, 2025)
