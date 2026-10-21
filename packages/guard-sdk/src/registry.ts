import type { GuardDetector } from "./types";

export class GuardRegistry {
  private readonly detectors = new Map<string, GuardDetector>();

  register(detector: GuardDetector): this {
    if (this.detectors.has(detector.id)) {
      throw new Error(`Guard detector '${detector.id}' is already registered`);
    }
    this.detectors.set(detector.id, detector);
    return this;
  }

  /** Replace or add; for deployments that swap a built-in detector for their own. */
  replace(detector: GuardDetector): this {
    this.detectors.set(detector.id, detector);
    return this;
  }

  get(id: string): GuardDetector | undefined {
    return this.detectors.get(id);
  }

  has(id: string): boolean {
    return this.detectors.has(id);
  }

  list(): GuardDetector[] {
    return [...this.detectors.values()];
  }
}
