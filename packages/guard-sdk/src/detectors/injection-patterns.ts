/**
 * Phase 12.2 — rule packs for prompt injection and jailbreaks. Each pattern
 * has a weight (its score when it fires alone) and a short label. Weights
 * are tuned on the corpus under `corpus/`: phrases that also appear in
 * ordinary requests ("act as a translator") sit below the default 0.5
 * threshold on their own and only count when combined with others.
 */

export interface InjectionPattern {
  id: string;
  label: string;
  weight: number;
  pattern: RegExp;
}

const p = (id: string, label: string, weight: number, source: string): InjectionPattern => ({
  id,
  label,
  weight,
  pattern: new RegExp(source, "giu")
});

const INSTRUCTION_NOUN = "(?:instructions?|prompts?|rules?|directions?|guidelines?|constraints?|programming|training|context|messages?)";
const QUALIFIER = "(?:all|any|the|your|these|those|every|previous|prior|above|earlier|preceding|original|initial|system|developer|safety|content|ethical|moral|exact|full|complete|entire|verbatim|secret|hidden|internal|confidential|real|actual|underlying|custom)";

/** Direct injection on user-facing channels. */
export const DIRECT_INJECTION_PATTERNS: InjectionPattern[] = [
  p(
    "override_instructions",
    "instruction override",
    0.9,
    `\\b(?:ignore|disregard|forget|override|bypass|skip|drop|discard|abandon|set aside)\\b(?!\\s+(?:my|our|his|her|their)\\b)[^.\\n]{0,40}?\\b(?:${QUALIFIER}\\s+){0,3}${INSTRUCTION_NOUN}\\b`
  ),
  p(
    "do_not_follow",
    "refusal of prior rules",
    0.7,
    `\\b(?:do not|don'?t|stop|never|no longer)\\s+(?:follow|obey|listen to|adhere to|comply with|respect)\\b[^.\\n]{0,30}?\\b(?:${QUALIFIER}\\s+){0,3}${INSTRUCTION_NOUN}\\b`
  ),
  p(
    "new_instructions",
    "new instruction block",
    0.65,
    "(?:^|\\n|[.!?]\\s)\\s*(?:new|updated|real|actual|true|hidden|secret|important)\\s+(?:instructions?|rules?|directive|task|system prompt)\\s*[:\\-]"
  ),
  p(
    "system_role_marker",
    "role marker",
    0.7,
    "(?:^|\\n)\\s*(?:#+\\s*)?(?:system|assistant|developer)\\s*(?:prompt|message)?\\s*:|<\\|im_start\\|>\\s*system|\\[inst\\]|<<sys>>|<\\|system\\|>"
  ),
  p(
    "reveal_system_prompt",
    "system prompt extraction",
    0.9,
    `\\b(?:reveal|print|show|repeat|output|display|dump|leak|disclose|recite|tell me|give me|write out|echo|paste)\\b[^.\\n]{0,40}?\\b(?:your|the|its|this|all)\\s+(?:${QUALIFIER}\\s+){0,2}(?:system prompt|initial prompt|hidden prompt|original prompt|system (?:message|instructions?)|instructions? (?:you were|you have been|you've been) given|configuration|preamble)`
  ),
  p(
    "what_are_instructions",
    "asking for instructions",
    0.55,
    "\\bwhat\\s+(?:are|were|is|was)\\s+(?:your|the)\\s+(?:exact\\s+|full\\s+|original\\s+|complete\\s+)?(?:system\\s+)?(?:prompt|instructions|rules you (?:were|are) given)\\b"
  ),
  p(
    "role_play_unrestricted",
    "unrestricted persona",
    0.85,
    "\\b(?:pretend|imagine|act|behave|roleplay|role-play|respond|answer|you are now|from now on you are|you will now be)\\b[^.\\n]{0,60}?\\b(?:without|no|free (?:of|from)|unbound by|beyond|outside|ignoring)\\s+(?:any\\s+)?(?:restrictions?|limitations?|limits|filters?|rules|guidelines|guardrails|censorship|ethics|ethical (?:guidelines|constraints)|safety (?:guidelines|measures|rules|filters?)|boundaries|content policy)"
  ),
  p(
    "persona_jailbreak",
    "known jailbreak persona",
    0.8,
    "\\b(?:do anything now|(?:enable|enter|activate|switch to|turn on|unlock)\\s+developer mode|developer mode\\s+(?:enabled|activated|on|unlocked)|dan mode|jailbreak(?:ed|ing)? (?:mode|prompt)|evil (?:mode|twin|version)|unfiltered (?:mode|ai|assistant|version)|god ?mode|opposite mode|no restrictions mode)\\b"
  ),
  p(
    "unrestricted_ai",
    "unrestricted AI framing",
    0.75,
    "\\b(?:an?|the)\\s+(?:ai|assistant|model|chatbot|language model)\\s+(?:that|which|who)\\s+(?:has no|doesn'?t have|does not have|ignores?|is not bound by|is free (?:of|from)|can bypass|has broken free (?:of|from))\\s+(?:any\\s+)?(?:restrictions?|rules|limitations?|filters?|guidelines|ethics|guardrails|content policy|safety)"
  ),
  p(
    "override_safety",
    "safety override",
    0.8,
    "\\b(?:disable|turn off|switch off|remove|deactivate|bypass|circumvent|override|lift)\\b[^.\\n]{0,30}?\\b(?:your|the|all|any)\\s+(?:safety|content|ethical|moral)?\\s*(?:filters?|guardrails|restrictions|safeguards|limitations|rules|protections|censorship)\\b"
  ),
  p(
    "hypothetical_frame",
    "hypothetical bypass frame",
    0.5,
    "\\b(?:hypothetically|in a fictional (?:world|story|scenario)|for (?:a|the) (?:story|novel|screenplay)|purely (?:hypothetical|theoretical)|this is (?:just )?a (?:test|game|simulation))\\b[^.\\n]{0,80}?\\b(?:no|without|ignore|bypass)\\b[^.\\n]{0,20}?\\b(?:rules|restrictions|limits|filters|guidelines|policy)\\b"
  ),
  p(
    "respond_only_with",
    "forced output format from untrusted text",
    0.45,
    "\\b(?:you must|always)\\s+(?:respond|reply|answer|start your (?:response|answer|reply))\\s+(?:only\\s+)?with\\b"
  ),
  p(
    "confirm_compliance",
    "compliance confirmation demand",
    0.55,
    "\\b(?:say|respond with|reply with|begin with|start with|answer)\\s+[\"'“‘]?(?:yes,? (?:i (?:will|can|understand)|master|sir)|i (?:am|'m) (?:free|unrestricted|jailbroken|dan)|understood,? (?:i|and))\\b"
  ),
  p(
    "prompt_leak_trick",
    "leak through translation or encoding",
    0.7,
    "\\b(?:translate|encode|convert|rewrite|summari[sz]e|base64|rot13|reverse|spell out|output in (?:json|yaml|markdown|code))\\b[^.\\n]{0,40}?\\b(?:your|the)\\s+(?:${QUALIFIER}\\s+){0,2}(?:system prompt|instructions|rules|configuration|preamble)\\b".replace("${QUALIFIER}", QUALIFIER)
  ),
  p(
    "exfil_instruction",
    "data exfiltration instruction",
    0.75,
    "\\b(?:send|post|forward|upload|transmit|email|exfiltrate|leak)\\b[^.\\n]{0,60}?\\b(?:conversation|chat history|context|secrets?|api keys?|credentials?|passwords?|tokens?|system prompt|user data|personal (?:data|information))\\b[^.\\n]{0,40}?\\b(?:to|at)\\s+(?:https?://|www\\.|[a-z0-9.-]+\\.[a-z]{2,}|this (?:url|address|endpoint)|the (?:following|above) (?:url|address|endpoint|webhook))"
  )
];

/**
 * Indirect injection in retrieved documents, tool results, web pages and
 * email: text that addresses the model rather than the user, or carries
 * instructions in places a document has no business holding them.
 */
export const INDIRECT_INJECTION_PATTERNS: InjectionPattern[] = [
  ...DIRECT_INJECTION_PATTERNS,
  p(
    "address_the_model",
    "text addressing the model",
    0.75,
    "\\b(?:(?:dear|hey|hello|attention|note to|message (?:to|for)|to)\\s+(?:the\\s+)?(?:ai|assistant|llm|language model|chatbot|model|copilot|agent)(?:s|\\b)|(?:ai|assistant|llm|model|agent)\\s+instructions?\\s*:\\s*(?=\\w)|if you are an?\\s+(?:ai|llm|language model|assistant|agent|automated (?:system|agent))|(?:ai|llm|language model|assistant|agent)s?\\s+(?:reading|processing|summari[sz]ing|parsing)\\s+this)\\b"
  ),
  p(
    "embedded_task",
    "embedded task for the model",
    0.65,
    "\\b(?:when (?:you )?(?:summari[sz]e|summari[sz]ing|process(?:ing)?|read(?:ing)?|analy[sz](?:e|ing)|answer(?:ing)?|respond(?:ing)?|translat(?:e|ing)) this(?: (?:document|page|email|text|message|content|file|ticket|issue))?,?\\s+(?:also|please|you must|make sure to|be sure to|remember to|always|do not forget to)|(?:in your (?:response|summary|answer|reply),?\\s+(?:also\\s+)?(?:include|add|append|insert|mention|say|write|tell the user))|(?:include the following (?:text|link|url|line|sentence) in your (?:response|summary|answer|reply|output)))\\b"
  ),
  p(
    "hidden_html_instruction",
    "instruction in markup comment or hidden element",
    0.6,
    "(?:<!--|<div[^>]*(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|font-size\\s*:\\s*0|opacity\\s*:\\s*0)[^>]*>|<span[^>]*(?:display\\s*:\\s*none|font-size\\s*:\\s*0)[^>]*>)[^<]{0,200}?\\b(?:ignore|instructions?|assistant|ai|system prompt|you must|tell the user|respond with|do not)\\b"
  ),
  p(
    "tool_call_in_content",
    "tool invocation planted in content",
    0.7,
    "\\b(?:call|invoke|run|execute|use)\\s+(?:the\\s+)?(?:tool|function|command|action)\\s+[`\"']?[a-z_][a-z0-9_.-]*[`\"']?\\s*(?:with|\\(|:|now|immediately|to)\\b|\\b(?:delete|remove|drop|wipe|erase|transfer|send|pay|wire)\\s+(?:all|every|the)\\s+(?:files?|records?|data|tables?|users?|emails?|money|funds|repositories|repos)\\b[^.\\n]{0,40}?\\b(?:now|immediately|without asking|without confirmation|before (?:responding|replying|answering))\\b"
  ),
  p(
    "urgency_and_secrecy",
    "secrecy demand",
    0.6,
    "\\b(?:do not|don'?t|never)\\s+(?:tell|inform|mention(?: this)? to|alert|warn|show|reveal(?: this)? to|let)\\s+(?:the\\s+)?(?:user|human|operator|owner|anyone)\\b|\\bthis (?:instruction|message|note) is (?:confidential|secret|hidden|not visible to the user)\\b|\\bkeep this (?:secret|hidden|between us)\\b"
  ),
  p(
    "important_marker_instruction",
    "shouted instruction marker",
    0.4,
    "(?:^|\\n)\\s*(?:\\*{1,2}|_{1,2}|#{1,3})?\\s*(?:important|attention|urgent|notice|warning|note)\\s*(?:to\\s+(?:ai|assistant|model|agent|llm))?\\s*[!:]\\s*[^\\n]{0,120}?\\b(?:you must|you should|you need to|always|ignore|respond|reply|output|forward|send|include)\\b"
  )
];
