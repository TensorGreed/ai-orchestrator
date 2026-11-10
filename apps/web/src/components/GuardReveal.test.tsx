import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RevealRulesSection } from "./GuardProfilesView";
import { GuardRevealFields } from "./GuardNodeConfigFields";
import type { GuardDocument } from "../lib/guard-profile-edit";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchGuardProfiles: vi.fn(async () => ({ profiles: [] })) };
});

const withRule: GuardDocument = {
  id: "support",
  name: "Support",
  version: "1",
  reveal: { rules: [{ name: "Billing", dataClasses: ["card_number"], subjects: { roles: ["admin"] }, requireApproval: true }] }
};

function Harness({ initial, role, onDocument }: { initial: GuardDocument; role: "admin" | "builder"; onDocument?: (document: GuardDocument) => void }) {
  const [document, setDocument] = useState(initial);
  return (
    <RevealRulesSection
      document={document}
      role={role}
      readOnly={false}
      onChange={(next) => {
        setDocument(next);
        onDocument?.(next);
      }}
    />
  );
}

describe("Reveal rules in the rule set editor", () => {
  it("shows nothing to a builder when the rule set has no reveal rules (simple rule sets stay simple)", () => {
    const { container } = render(<Harness initial={{ id: "x", name: "X", version: "1" }} role="builder" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows reveal rules read-only to a builder, with the admin-only note", () => {
    render(<Harness initial={withRule} role="builder" />);
    const block = screen.getByLabelText("Reveal rules");
    expect(within(block).getByText(/Billing: admins may reveal card_number, after a person approves\./)).toBeInTheDocument();
    expect(within(block).getByRole("note")).toHaveTextContent("Only an admin can change reveal rules");
    expect(within(block).queryByRole("button", { name: /Add reveal rule/ })).toBeNull();
    expect(within(block).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("lets an admin add and remove reveal rules", async () => {
    const user = userEvent.setup();
    const seen: GuardDocument[] = [];
    render(<Harness initial={{ id: "x", name: "X", version: "1" }} role="admin" onDocument={(next) => seen.push(next)} />);
    const add = screen.getByRole("button", { name: "Add reveal rule" });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("Reveal data classes"), "email");
    await user.click(within(screen.getByRole("group", { name: "Reveal roles" })).getByLabelText("operator"));
    await user.click(add);
    expect(seen.at(-1)?.reveal).toEqual({ rules: [{ dataClasses: ["email"], subjects: { roles: ["operator"] } }] });
    await user.click(screen.getByRole("button", { name: "Remove reveal rule 1" }));
    expect(seen.at(-1)?.reveal).toBeUndefined();
  });
});

describe("Reveal node fields", () => {
  it("lists secrets as keys and writes secret ids only", async () => {
    const user = userEvent.setup();
    let config: Record<string, unknown> = { profileId: "effective", inputField: "text" };
    function Fields() {
      const [state, setState] = useState(config);
      return (
        <GuardRevealFields
          config={state}
          setConfig={(update) =>
            setState((current) => {
              config = update(current);
              return config;
            })
          }
          secrets={[{ id: "sec_1", name: "Card key" } as never]}
        />
      );
    }
    render(<Fields />);
    await user.click(screen.getByLabelText("Card key"));
    expect(config.keySecretRefs).toEqual([{ secretId: "sec_1" }]);
    await user.selectOptions(screen.getByLabelText("When a token may not be revealed"), "fail");
    expect(config.onRefused).toBe("fail");
  });
});
