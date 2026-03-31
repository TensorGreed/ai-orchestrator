import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { SqliteStore } from "../db/database";

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
  constructor(
    private readonly store: SqliteStore,
    private readonly sessionTtlHours: number
  ) {}

  countUsers(): number {
    return this.store.countUsers();
  }

  private toSafeUser(user: { id: string; email: string; role: string }): SafeUser {
    return {
      id: user.id,
      email: user.email,
      role: isValidRole(user.role) ? user.role : "viewer"
    };
  }

  register(input: { email: string; password: string; role: UserRole }): SafeUser {
    const email = normalizeEmail(input.email);
    const existing = this.store.getUserByEmail(email);
    if (existing) {
      throw new Error("An account with this email already exists");
    }

    const saved = this.store.saveUser({
      id: `usr_${nanoid(12)}`,
      email,
      passwordHash: hashPassword(input.password),
      role: input.role
    });

    return this.toSafeUser(saved);
  }

  login(emailInput: string, password: string): { user: SafeUser; sessionId: string; expiresAt: string } {
    const email = normalizeEmail(emailInput);
    const user = this.store.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new Error("Invalid email or password");
    }

    this.store.revokeExpiredSessions();

    const expiresAtDate = new Date();
    expiresAtDate.setHours(expiresAtDate.getHours() + this.sessionTtlHours);
    const expiresAt = expiresAtDate.toISOString();

    const session = this.store.saveSession({
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

  getSessionUser(sessionId: string): SafeUser | null {
    if (!sessionId) {
      return null;
    }

    this.store.revokeExpiredSessions();
    const session = this.store.getSession(sessionId);
    if (!session || session.revokedAt) {
      return null;
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      this.store.revokeSession(session.id);
      return null;
    }

    const user = this.store.getUserById(session.userId);
    if (!user) {
      return null;
    }

    this.store.touchSession(session.id);
    return this.toSafeUser(user);
  }

  logout(sessionId: string): void {
    if (!sessionId) {
      return;
    }
    this.store.revokeSession(sessionId);
  }

  bootstrapAdmin(email?: string, password?: string): SafeUser | null {
    if (!email || !password) {
      return null;
    }

    if (this.store.countUsers() > 0) {
      return null;
    }

    return this.register({
      email,
      password,
      role: "admin"
    });
  }
}

