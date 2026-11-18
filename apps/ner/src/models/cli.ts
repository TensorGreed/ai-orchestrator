import path from "node:path";
import { createInterface } from "node:readline/promises";
import { findNerModel, loadNerManifest, nerModelFolder, type NerManifest, type NerModel } from "./manifest.js";
import { formatBytes, pullNerModel } from "./pull.js";
import { describeFileStatus, verifyNerModel } from "./verify.js";

/**
 * `models list | pull | verify`, shared by `l2m models …` and the l2m-ner image (`docker compose run --rm ner models …`).
 *
 *   models list   [--dir <folder>] [--manifest <file>]
 *   models pull   [<model id>] [--dir <folder>] [--manifest <file>] [--accept-licence]
 *   models verify [<model id>] [--dir <folder>] [--manifest <file>]
 *
 * The folder defaults to NER_MODEL_DIR, then ./ner-models. Exit codes: 0 done, 1 a download or a check failed,
 * 2 usage error (including a licence that was not accepted).
 */

export interface NerModelsIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export const NER_MODELS_USAGE = `Usage:
  models list   [--dir <folder>] [--manifest <file>]
  models pull   [<model id>] [--dir <folder>] [--manifest <file>] [--accept-licence]
  models verify [<model id>] [--dir <folder>] [--manifest <file>]

Models are downloaded from their publisher (URLs and SHA-256 in the manifest),
never from L2M. pull shows the model's licence and needs --accept-licence or a
typed "yes". The folder defaults to NER_MODEL_DIR, then ./ner-models.
Exit codes: 0 done, 1 a download or a check failed, 2 usage error.`;

class NerUsageError extends Error {}

interface ParsedModelsArgs {
  sub: string | undefined;
  id: string | undefined;
  dir: string | undefined;
  manifest: string | undefined;
  acceptLicence: boolean;
  help: boolean;
}

function parseModelsArgs(argv: string[]): ParsedModelsArgs {
  const result: ParsedModelsArgs = { sub: undefined, id: undefined, dir: undefined, manifest: undefined, acceptLicence: false, help: false };
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--accept-licence" || arg === "--accept-license") {
      result.acceptLicence = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (name !== "dir" && name !== "manifest") throw new NerUsageError(`Unknown flag --${name.slice(0, 40)}`);
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++index];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new NerUsageError(`--${name} needs a value`);
      result[name] = value;
      continue;
    }
    positionals.push(arg);
  }
  result.sub = positionals[0];
  result.id = positionals[1];
  if (positionals.length > 2) throw new NerUsageError(`Unexpected argument ${JSON.stringify(positionals[2]!.slice(0, 60))}`);
  return result;
}

const write = (stream: NodeJS.WritableStream, text: string) => {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
};

export async function runNerModelsCommand(argv: string[], io: NerModelsIo): Promise<number> {
  let args: ParsedModelsArgs;
  try {
    args = parseModelsArgs(argv);
  } catch (error) {
    write(io.stderr, `${(error as Error).message}\n\n${NER_MODELS_USAGE}`);
    return 2;
  }
  if (args.help || !args.sub) {
    write(args.help ? io.stdout : io.stderr, NER_MODELS_USAGE);
    return args.help ? 0 : 2;
  }
  if (args.sub === "list" && args.id !== undefined) {
    write(io.stderr, "models list takes no model id");
    return 2;
  }
  let manifest: NerManifest;
  try {
    manifest = loadNerManifest(args.manifest ? path.resolve(args.manifest) : undefined);
  } catch (error) {
    write(io.stderr, (error as Error).message);
    return 2;
  }
  const modelsDir = path.resolve(args.dir ?? (io.env.NER_MODEL_DIR || "ner-models"));
  try {
    switch (args.sub) {
      case "list":
        return await listModels(manifest, modelsDir, io);
      case "pull":
        return await pullModel(findNerModel(manifest, args.id), modelsDir, args.acceptLicence, io);
      case "verify":
        return await verifyModel(findNerModel(manifest, args.id), modelsDir, io);
      default:
        write(io.stderr, `Unknown models command ${JSON.stringify(args.sub.slice(0, 40))}\n\n${NER_MODELS_USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof NerUsageError) {
      write(io.stderr, error.message);
      return 2;
    }
    write(io.stderr, (error as Error).message);
    return /not in the manifest/.test((error as Error).message) ? 2 : 1;
  }
}

async function listModels(manifest: NerManifest, modelsDir: string, io: NerModelsIo): Promise<number> {
  write(io.stdout, `Models folder: ${modelsDir}`);
  for (const model of manifest.models) {
    const check = await verifyNerModel(nerModelFolder(modelsDir, model), model, { sizesOnly: true });
    const size = model.files.reduce((sum, file) => sum + file.bytes, 0);
    const state = check.ok ? "present (run verify to check checksums)" : check.files.every((file) => file.status === "missing") ? "not pulled" : "incomplete";
    write(
      io.stdout,
      [
        `${model.id}${model.id === manifest.default ? " (default)" : ""}`,
        `  ${model.name}, ${formatBytes(size)}, languages: ${model.languages.join(", ")}`,
        `  licence: ${model.licence.id} (${model.licence.url})`,
        `  training data: ${model.licence.trainingData}`,
        `  status: ${state}`
      ].join("\n")
    );
  }
  return 0;
}

function licenceText(model: NerModel): string {
  const size = model.files.reduce((sum, file) => sum + file.bytes, 0);
  return [
    `Model:         ${model.name} (${model.id}, revision ${model.revision.slice(0, 12)})`,
    `Publisher:     ${model.publisher} — ${model.homepage}`,
    `Licence:       ${model.licence.id} — ${model.licence.url}`,
    `Training data: ${model.licence.trainingData}`,
    ...(model.licence.notes ? [`Notes:         ${model.licence.notes}`] : []),
    `Download:      ${formatBytes(size)} from ${[...new Set(model.files.map((file) => new URL(file.url).host))].join(", ")}`,
    "",
    "L2M does not distribute this model. You download it from its publisher and use it under the publisher's licence."
  ].join("\n");
}

async function confirmLicence(model: NerModel, accepted: boolean, io: NerModelsIo): Promise<boolean> {
  write(io.stdout, licenceText(model));
  if (accepted) {
    write(io.stdout, "Licence accepted with --accept-licence.");
    return true;
  }
  if (!io.stdin.isTTY) {
    write(io.stderr, "Not accepted: run again with --accept-licence once you have read the licence (no terminal to ask on).");
    return false;
  }
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = await rl.question(`Accept the ${model.licence.id} licence and download? Type "yes": `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function pullModel(model: NerModel, modelsDir: string, acceptLicence: boolean, io: NerModelsIo): Promise<number> {
  if (!(await confirmLicence(model, acceptLicence, io))) {
    write(io.stderr, "Nothing was downloaded.");
    return 2;
  }
  const result = await pullNerModel({ modelsDir, model, log: (line) => write(io.stdout, line), ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) });
  write(io.stdout, `Done: ${result.folder} (${result.downloaded.length} downloaded, ${result.alreadyPresent.length} already present). Every file matches the manifest.`);
  return 0;
}

async function verifyModel(model: NerModel, modelsDir: string, io: NerModelsIo): Promise<number> {
  const folder = nerModelFolder(modelsDir, model);
  const check = await verifyNerModel(folder, model);
  for (const file of check.files) write(io.stdout, `${file.path}: ${describeFileStatus(file)}`);
  write(check.ok ? io.stdout : io.stderr, check.ok ? `${model.id}: every file matches the manifest (${folder}).` : `${model.id}: the folder ${folder} does not match the manifest; run models pull again.`);
  return check.ok ? 0 : 1;
}
