import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OutputCheckOptions } from "./OutputCheckOptions";
import { OutputGuardrailFields } from "./OutputGuardrailFields";

type Config = Record<string, unknown>;

function GuardrailHarness({ initial, onConfig }: { initial: Config; onConfig: (config: Config) => void }) {
  const [config, setConfigState] = useState(initial);
  return (
    <OutputGuardrailFields
      config={config}
      setConfig={(update) =>
        setConfigState((current) => {
          const next = update(current);
          onConfig(next);
          return next;
        })
      }
    />
  );
}

describe("Output Guardrail fields", () => {
  it("lists every check and shows a check's settings when it is on", async () => {
    const seen: Config[] = [];
    render(<GuardrailHarness initial={{ checks: ["no_pii"], onFail: "error" }} onConfig={(config) => seen.push(config)} />);
    expect(screen.getByLabelText("No personal data")).toBeChecked();
    expect(screen.queryByLabelText("Output Guardrail JSON Schema")).toBeNull();
    await userEvent.click(screen.getByLabelText("Matches a JSON Schema"));
    expect(seen.at(-1)!.checks).toEqual(["no_pii", "matches_schema"]);
    fireEvent.change(screen.getByLabelText("Output Guardrail JSON Schema"), { target: { value: '{"type":"object"}' } });
    expect(seen.at(-1)!.schema).toEqual({ type: "object" });
    fireEvent.change(screen.getByLabelText("Output Guardrail JSON Schema"), { target: { value: '{"type":' } });
    expect(screen.getByRole("alert")).toHaveTextContent("last valid schema is kept");
    expect(seen.at(-1)!.schema).toEqual({ type: "object" });
  });

  it("topics are typed one per line and saved as names and phrases", async () => {
    const seen: Config[] = [];
    render(<GuardrailHarness initial={{ checks: ["topic"], onFail: "error" }} onConfig={(config) => seen.push(config)} />);
    const deny = screen.getByLabelText("Output Guardrail denied topics");
    fireEvent.change(deny, { target: { value: "investing: buy stocks, crypto\nlegal advice" } });
    fireEvent.blur(deny);
    expect(seen.at(-1)!.topics).toEqual({ deny: [{ name: "investing", phrases: ["buy stocks", "crypto"] }, "legal advice"] });
  });

  it("a model-backed check asks for the check model", async () => {
    const seen: Config[] = [];
    render(<GuardrailHarness initial={{ checks: ["safety"], onFail: "error" }} onConfig={(config) => seen.push(config)} />);
    expect(screen.queryByLabelText("Check model provider")).toBeNull();
    await userEvent.click(screen.getByLabelText("Judge with a chat model instead of the built-in rules"));
    expect(seen.at(-1)!.safety).toEqual({ mode: "model" });
    fireEvent.change(screen.getByLabelText("Check model provider"), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("Check model name"), { target: { value: "gpt-4o-mini" } });
    expect(seen.at(-1)!.checkModel).toEqual({ providerId: "openai", model: "gpt-4o-mini" });
    await userEvent.click(screen.getByLabelText("Hate"));
    expect(seen.at(-1)!.safety).toEqual({ mode: "model", categories: ["self_harm", "violence", "sexual", "sexual_minors"] });
  });
});

describe("Output check settings in the rule set editor", () => {
  it("edits topics and the matching mode", () => {
    const onChange = vi.fn();
    render(<OutputCheckOptions detectorId="output.topic" options={{ deny: ["crypto"] }} readOnly={false} buffered={false} onChange={onChange} onBuffered={vi.fn()} />);
    const allow = screen.getByLabelText("Allowed topics");
    fireEvent.change(allow, { target: { value: "billing: refund" } });
    fireEvent.blur(allow);
    expect(onChange).toHaveBeenLastCalledWith({ deny: ["crypto"], allow: [{ name: "billing", phrases: ["refund"] }] });
    fireEvent.change(screen.getByLabelText("Match by"), { target: { value: "semantic" } });
    expect(onChange).toHaveBeenLastCalledWith({ deny: ["crypto"], mode: "semantic" });
  });

  it("whole-answer checks offer buffering; read-only disables everything", async () => {
    const onBuffered = vi.fn();
    const { rerender } = render(<OutputCheckOptions detectorId="output.grounding" options={{}} readOnly={false} buffered={false} onChange={vi.fn()} onBuffered={onBuffered} />);
    expect(screen.getByText(/the rest of the answer is withheld/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Check the whole answer before streaming any of it"));
    expect(onBuffered).toHaveBeenCalledWith(true);
    rerender(<OutputCheckOptions detectorId="output.safety" options={{}} readOnly buffered={false} onChange={vi.fn()} onBuffered={onBuffered} />);
    expect(screen.queryByLabelText("Check the whole answer before streaming any of it")).toBeNull();
    expect(screen.getByLabelText("Hate")).toBeDisabled();
  });
});
