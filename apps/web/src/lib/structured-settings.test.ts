import { describe, expect, it } from "vitest";
import {
  duplicateCaseLabels,
  embedderSettingFields,
  fieldNameFromLabel,
  formFieldsOf,
  mappingOf,
  otherSettings,
  ragSettingFields,
  readFormFields,
  readMapping,
  readSwitchCases,
  settingText,
  withCaseValue,
  withOtherSettings,
  keysEditedElsewhere,
  withSetting
} from "./structured-settings";

describe("setting fields", () => {
  it("lists what each embedder reads, and nothing for the built-in one", () => {
    expect(embedderSettingFields("token-embedder")).toEqual([]);
    expect(embedderSettingFields("openai-embedder").map((field) => field.key)).toEqual(["model", "baseUrl"]);
    expect(embedderSettingFields("azure-openai-embedder").map((field) => field.key)).toEqual(["endpoint", "deployment", "apiVersion"]);
    expect(embedderSettingFields("unknown")).toEqual([]);
  });

  it("puts the embedder's fields before the store's, and shows a key both read once", () => {
    expect(ragSettingFields("openai-embedder", "pinecone-vector-store").map((field) => field.key)).toEqual(["model", "baseUrl", "indexName"]);
    const shared = ragSettingFields("azure-openai-embedder", "qdrant-vector-store");
    expect(shared.filter((field) => field.key === "endpoint")).toHaveLength(1);
    expect(shared.find((field) => field.key === "endpoint")?.help).toBe("Used by the embedder and the vector store.");
    expect(ragSettingFields("token-embedder", "in-memory-vector-store")).toEqual([]);
  });
});

describe("editing settings", () => {
  it("sets a key and removes it when emptied", () => {
    expect(withSetting({ a: "1" }, "model", "m")).toEqual({ a: "1", model: "m" });
    expect(withSetting({ a: "1", model: "m" }, "model", "  ")).toEqual({ a: "1" });
  });

  it("keeps the keys the fields do not show as other settings, and the handled ones out of them", () => {
    const fields = ragSettingFields("openai-embedder", "pinecone-vector-store");
    const settings = { model: "m", indexName: "i", knowledgeBaseId: "kb", namespace: "ns", filter: { a: 1 } };
    expect(otherSettings(settings, fields)).toEqual({ namespace: "ns", filter: { a: 1 } });
    expect(withOtherSettings(settings, fields, { region: "eu", model: "ignored" })).toEqual({ model: "m", indexName: "i", knowledgeBaseId: "kb", region: "eu" });
  });

  it("shows a value that is not text as JSON", () => {
    expect(settingText({ a: "x", b: 3, c: { d: 1 } }, "a")).toBe("x");
    expect(settingText({ a: "x", b: 3 }, "b")).toBe("3");
    expect(settingText({}, "a")).toBe("");
  });
});

describe("Switch cases", () => {
  it("reads objects and plain text cases", () => {
    expect(readSwitchCases([{ value: "a", label: "A" }, "b", { value: 3 }, null, { value: "c", label: "" }])).toEqual([
      { value: "a", label: "A" },
      { value: "b", label: "b" },
      // Saved without a label: drawn and routed by its value.
      { value: "3", label: "3" },
      { value: "", label: "" },
      { value: "c", label: "" }
    ]);
    expect(readSwitchCases("nope")).toEqual([]);
  });

  it("lets a new case's label follow its value, and keeps a saved case's label (its branch is connected to it)", () => {
    expect(withCaseValue({ value: "pos", label: "pos" }, "positive", true)).toEqual({ value: "positive", label: "positive" });
    expect(withCaseValue({ value: "pos", label: "Happy" }, "positive", true)).toEqual({ value: "positive", label: "Happy" });
    expect(withCaseValue({ value: "pos", label: "pos" }, "positive")).toEqual({ value: "positive", label: "pos" });
  });

  it("finds labels used twice, the default output's included", () => {
    expect(duplicateCaseLabels([{ value: "a", label: "x" }, { value: "b", label: "x" }, { value: "c", label: "default" }], "default")).toEqual(["x", "default"]);
    expect(duplicateCaseLabels([{ value: "a", label: "" }, { value: "b", label: "" }], "default")).toEqual([]);
  });
});

describe("mappings", () => {
  it("reads and writes a mapping, leaving out rows without a source", () => {
    expect(readMapping({ name: "user_name", n: 1 })).toEqual([{ from: "name", to: "user_name" }, { from: "n", to: "1" }]);
    expect(readMapping(["x"])).toEqual([]);
    expect(mappingOf([{ from: " name ", to: " user " }, { from: "", to: "x" }])).toEqual({ name: "user" });
  });
});

describe("Form Trigger fields", () => {
  it("round-trips fields, keeping keys the editor does not show", () => {
    const saved = [
      { name: "topic", label: "Topic", type: "select", required: true, options: ["A", "B"], hint: "kept" },
      { name: "note", type: "bogus" }
    ];
    const rows = readFormFields(saved);
    expect(rows[1]!.type).toBe("text");
    expect(formFieldsOf(rows)).toEqual([
      { hint: "kept", name: "topic", label: "Topic", type: "select", required: true, options: ["A", "B"] },
      { name: "note", type: "text" }
    ]);
  });

  it("drops the options of a field that is no longer a select, and blank options", () => {
    const [row] = readFormFields([{ name: "t", type: "select", options: ["A", " ", "B "] }]);
    expect(formFieldsOf([{ ...row!, type: "text" }])).toEqual([{ name: "t", type: "text" }]);
    expect(formFieldsOf([row!])[0]!.options).toEqual(["A", "B"]);
  });

  it("names a field after its label", () => {
    expect(fieldNameFromLabel("Your e-mail address")).toBe("your_e_mail_address");
    expect(fieldNameFromLabel("  ")).toBe("");
  });
});

describe("keysEditedElsewhere", () => {
  it("names the keys Other settings cannot set", () => {
    expect(keysEditedElsewhere({ model: "x", extra: 1, secretRef: {}, knowledgeBaseId: "kb" }, [{ key: "model", label: "Model" }], ["secretRef"])).toEqual([
      "model",
      "secretRef",
      "knowledgeBaseId"
    ]);
  });
});
