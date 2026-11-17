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
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("Rules only: street addresses in 6 countries");
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
    expect(screen.getByTestId("entities-engine")).toHaveTextContent("Engine: local-model 2 (error: model file missing)");
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
