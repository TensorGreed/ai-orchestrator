import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { Store } from "../db/store.js";

export type UserRole = "admin" | "builder" | "operator" | "viewer";

export interface SafeUser {
  id: string;
  email: string;
  role: UserRole;
}

const validRoles: UserRole[] = ["admin", "builder", "operator", "viewer"];

function isValidRole(value: string): value is UserRole {
  return validRoles.includes(value as UserRole);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) {
    return false;
  }

  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "base64");

  if (candidate.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidate, expected);
}

export class AuthService {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly sessionTtlHours: number
  ) {}

  async countUsers(): Promise<number> {
    return await this.store.countUsers();
  }

  startSessionCleanup(intervalMs = 5 * 60 * 1000): void {
    if (this.cleanupTimer !== null) return;
    const tick = async () => {
      try {
        const result = await this.store.revokeExpiredSessions() as unknown;
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // best-effort background cleanup; ignore failures
      }
    };
    // promise-ok: tick catches its own errors (best-effort cleanup)
    this.cleanupTimer = setInterval(tick, intervalMs);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  stopSessionCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private toSafeUser(user: { id: string; email: string; role: string }): SafeUser {
    return {
      id: user.id,
      email: user.email,
      role: isValidRole(user.role) ? user.role : "viewer"
    };
  }

  async register(input: { email: string; password: string; role: UserRole }): Promise<SafeUser> {
    const email = normalizeEmail(input.email);
    const existing = await this.store.getUserByEmail(email);
    if (existing) {
      throw new Error("An account with this email already exists");
    }

    const saved = await this.store.saveUser({
      id: `usr_${nanoid(12)}`,
      email,
      passwordHash: hashPassword(input.password),
      role: input.role
    });

    return this.toSafeUser(saved);
  }

  async login(emailInput: string, password: string): Promise<{ user: SafeUser; sessionId: string; expiresAt: string }> {
    const email = normalizeEmail(emailInput);
    const user = await this.store.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new Error("Invalid email or password");
    }

    await this.store.revokeExpiredSessions();

    const expiresAtDate = new Date();
    expiresAtDate.setHours(expiresAtDate.getHours() + this.sessionTtlHours);
    const expiresAt = expiresAtDate.toISOString();

    const session = await this.store.saveSession({
      id: `sess_${nanoid(24)}`,
      userId: user.id,
      expiresAt
    });

    return {
      user: this.toSafeUser(user),
      sessionId: session.id,
      expiresAt: session.expiresAt
    };
  }

  /**
   * `knownSession` is the row a caller already looked up for this ID (`null`: it does not exist). Leave it out to
   * look the session up here.
   */
  async getSessionUser(
    sessionId: string,
    knownSession?: Awaited<ReturnType<Store["getSession"]>>
  ): Promise<SafeUser | null> {
    if (!sessionId) {
      return null;
    }

    const session = knownSession === undefined ? await this.store.getSession(sessionId) : knownSession;
    if (!session || session.revokedAt) {
      return null;
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.store.revokeSession(session.id);
      return null;
    }

    const user = await this.store.getUserById(session.userId);
    if (!user) {
      return null;
    }

    await this.store.touchSession(session.id);
    return this.toSafeUser(user);
  }

  async logout(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    await this.store.revokeSession(sessionId);
  }

  async bootstrapAdmin(email?: string, password?: string): Promise<SafeUser | null> {
    if (!email || !password) {
      return null;
    }

    if (await this.store.countUsers() > 0) {
      return null;
    }

    return await this.register({
      email,
      password,
      role: "admin"
    });
  }
}

