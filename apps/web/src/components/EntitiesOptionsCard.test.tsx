import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { GuardEntityEngineInfo } from "@ai-orchestrator/shared";
import { EntitiesOptionsCard } from "./EntitiesOptionsCard";

function Harness({ initial, seen, engine }: { initial: Record<string, unknown>; seen: Array<Record<string, unknown>>; engine?: GuardEntityEngineInfo }) {
  const [options, setOptions] = useState(initial);
  return (
    <EntitiesOptionsCard
      options={options}
      {...(engine ? { engine } : {})}
      readOnly={false}
      onChange={(next) => {
        seen.push(next);
        setOptions(next);
      }}
    />
  );
}

const RULES: GuardEntityEngineInfo = { id: "rules", version: "rules-1", status: "rules", languages: ["en"], classes: ["person_name", "location", "street_address"] };

describe("Names and addresses card", () => {
  it("says the engine is rules only, and edits classes and thresholds", async () => {
    const seen: Array<Record<string, unknown>> = [];
    render(<Harness initial={{ classes: ["person_name", "street_address"] }} seen={seen} engine={RULES} />);
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("Basic: built-in rules only. Good on street addresses in 6 countries");
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("docker compose --profile ner up -d");
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("CONTENT_RULES_NER_ENDPOINT");
    expect(screen.getByLabelText("Lowest score for locations")).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Locations"));
    expect(seen.at(-1)!.classes).toEqual(["person_name", "location", "street_address"]);
    fireEvent.change(screen.getByLabelText("Lowest score for person names"), { target: { value: "0.9" } });
    expect(seen.at(-1)!.minScore).toEqual({ person_name: 0.9 });
    await userEvent.selectOptions(screen.getByLabelText("Engine"), "rules");
    expect(seen.at(-1)!.engine).toBe("rules");
  });

  it("keeps the last class on", () => {
    render(<Harness initial={{ classes: ["location"] }} seen={[]} />);
    expect(screen.getByLabelText("Locations")).toBeDisabled();
    expect(screen.getByLabelText("Person names")).not.toBeDisabled();
  });

  it("shows a configured engine and its status", () => {
    render(<Harness initial={{ classes: ["location"] }} seen={[]} engine={{ ...RULES, id: "local-model", version: "2", status: "error", error: "model file missing" }} />);
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("Engine local-model 2: not working (model file missing).");
  });

  const SERVICE: GuardEntityEngineInfo = {
    ...RULES,
    id: "endpoint",
    version: "gliner@1#abc",
    kind: "endpoint",
    status: "loaded",
    model: { id: "gliner-pii-base", version: "1.0", sha256: "a".repeat(64) }
  };

  it("shows the service's health and model, and that a rules-only rule set does not use it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    render(<Harness initial={{ classes: ["location"] }} seen={seen} engine={SERVICE} />);
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("Names and addresses service: ready, model gliner-pii-base 1.0.");
    expect(screen.getByLabelText("Time limit of this check")).toHaveValue(30000);
    await userEvent.selectOptions(screen.getByLabelText("Engine"), "union");
    expect(seen.at(-1)!.engine).toBe("union");
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("The built-in rules run as well.");
    await userEvent.selectOptions(screen.getByLabelText("Engine"), "rules");
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("does not use the deployment's names and addresses service");
    expect(screen.queryByLabelText("Time limit of this check")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Engine"), "auto");
    expect(seen.at(-1)!.engine).toBeUndefined();
  });

  it("shows a service that runs without a model", () => {
    render(<Harness initial={{ classes: ["location"] }} seen={[]} engine={{ ...SERVICE, status: "not_ready", model: undefined, message: "No model is loaded" }} />);
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("Names and addresses service: running, no model loaded (No model is loaded).");
  });

  it("warns when the service engine is picked and the deployment has none", () => {
    render(<Harness initial={{ classes: ["location"], engine: "endpoint" }} seen={[]} engine={RULES} />);
    expect(screen.getByRole("alert")).toHaveTextContent("no names and addresses service");
  });

  it("turns the judge on with a warning about where spans go, and off without leaving its settings behind", async () => {
    const seen: Array<Record<string, unknown>> = [];
    render(<Harness initial={{ classes: ["person_name"] }} seen={seen} engine={RULES} />);
    expect(screen.queryByTestId("entities-judge-warning")).toBeNull();
    await userEvent.click(screen.getByLabelText("Ask a chat model about uncertain spans (counted in the run's cost)"));
    expect(seen.at(-1)!.judge).toEqual({ enabled: true });
    expect(screen.getByTestId("entities-judge-warning")).toHaveTextContent("leaves the deployment");
    fireEvent.change(screen.getByLabelText("Judge model: provider"), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("Judge model: model"), { target: { value: "gpt-test" } });
    expect((seen.at(-1)!.judge as Record<string, unknown>).model).toMatchObject({ providerId: "openai", model: "gpt-test" });
    fireEvent.change(screen.getByLabelText("Uncertain from score"), { target: { value: "0.4" } });
    expect((seen.at(-1)!.judge as Record<string, unknown>).band).toEqual([0.4, 0.7]);
    fireEvent.change(screen.getByLabelText("Time limit of this check"), { target: { value: "15000" } });
    expect(seen.at(-1)!.timeoutMs).toBe(15000);
    await userEvent.click(screen.getByLabelText("Ask a chat model about uncertain spans (counted in the run's cost)"));
    expect(seen.at(-1)!.judge).toBeUndefined();
  });

  it("saves context words when the field is left and the text limit when changed", () => {
    const seen: Array<Record<string, unknown>> = [];
    render(<Harness initial={{ classes: ["person_name"] }} seen={seen} />);
    const boost = screen.getByLabelText("Words that raise the score");
    fireEvent.change(boost, { target: { value: "patient, doctor" } });
    fireEvent.blur(boost);
    expect(seen.at(-1)!.contextWords).toEqual({ boost: ["patient", "doctor"] });
    fireEvent.change(screen.getByLabelText("Longest text checked"), { target: { value: "50000" } });
    expect(seen.at(-1)!.maxChars).toBe(50000);
  });
});
