import crypto from "node:crypto";
import { SqliteStore } from "../db/database";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const BACKUP_CODE_COUNT = 10;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) {
      throw new Error("Invalid base32 character in MFA secret");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
    buffer[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const hmac = crypto.createHmac("sha1", secret).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const modulo = 10 ** TOTP_DIGITS;
  return (code % modulo).toString().padStart(TOTP_DIGITS, "0");
}

export function generateTotpCode(base32Secret: string, timestampMs: number = Date.now()): string {
  const counter = Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

export function verifyTotpCode(
  base32Secret: string,
  code: string,
  timestampMs: number = Date.now()
): boolean {
  if (!code || !/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS);
  const secret = base32Decode(base32Secret);
  for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w += 1) {
    const candidate = hotp(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) {
      return true;
    }
  }
  return false;
}

export interface MfaEnrollment {
  secret: string;
  otpauthUrl: string;
  backupCodes: string[];
}

export interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  activatedAt: string | null;
  remainingBackupCodes: number;
}

function parseMasterKey(rawKey?: string): Buffer {
  if (!rawKey) {
    throw new Error("SECRET_MASTER_KEY_BASE64 is required for MFA encryption at rest");
  }
  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error("SECRET_MASTER_KEY_BASE64 must decode to 32 bytes");
  }
  return key;
}

function generateBackupCode(): string {
  const bytes = crypto.randomBytes(5);
  return bytes.toString("hex").toUpperCase().slice(0, 10);
}

export class MfaService {
  private readonly key: Buffer;

  constructor(
    private readonly store: SqliteStore,
    rawMasterKey: string | undefined,
    private readonly issuer: string = "ai-orchestrator"
  ) {
    this.key = parseMasterKey(rawMasterKey);
  }

  private encrypt(plaintext: string): { iv: string; authTag: string; ciphertext: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64")
    };
  }

  private decrypt(iv: string, authTag: string, ciphertext: string): string {
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  }

  enroll(userId: string, userEmail: string): MfaEnrollment {
    const rawSecret = crypto.randomBytes(20);
    const secret = base32Encode(rawSecret);
    const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => generateBackupCode());

    const encrypted = this.encrypt(secret);
    this.store.upsertMfaSecret({
      userId,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
      secretCiphertext: encrypted.ciphertext,
      backupCodes: backupCodes.map((c) => crypto.createHash("sha256").update(c).digest("hex")),
      enabled: false,
      activatedAt: null
    });

    const label = encodeURIComponent(`${this.issuer}:${userEmail}`);
    const issuer = encodeURIComponent(this.issuer);
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&period=${TOTP_STEP_SECONDS}&digits=${TOTP_DIGITS}`;

    return {
      secret,
      otpauthUrl,
      backupCodes
    };
  }

  activate(userId: string, code: string): boolean {
    const record = this.store.getMfaSecret(userId);
    if (!record) return false;
    const secret = this.decrypt(record.secretIv, record.secretAuthTag, record.secretCiphertext);
    if (!verifyTotpCode(secret, code)) return false;
    this.store.upsertMfaSecret({
      userId,
      secretIv: record.secretIv,
      secretAuthTag: record.secretAuthTag,
      secretCiphertext: record.secretCiphertext,
      backupCodes: record.backupCodes,
      enabled: true,
      activatedAt: new Date().toISOString()
    });
    return true;
  }

  verify(userId: string, code: string): boolean {
    const record = this.store.getMfaSecret(userId);
    if (!record || !record.enabled) return false;
    const secret = this.decrypt(record.secretIv, record.secretAuthTag, record.secretCiphertext);
    if (verifyTotpCode(secret, code)) return true;

    const codeHash = crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
    const matchIndex = record.backupCodes.findIndex((hashed) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(hashed, "hex"), Buffer.from(codeHash, "hex"));
      } catch {
        return false;
      }
    });
    if (matchIndex === -1) return false;

    const remainingBackup = [...record.backupCodes];
    remainingBackup.splice(matchIndex, 1);
    this.store.upsertMfaSecret({
      userId,
      secretIv: record.secretIv,
      secretAuthTag: record.secretAuthTag,
      secretCiphertext: record.secretCiphertext,
      backupCodes: remainingBackup,
      enabled: record.enabled,
      activatedAt: record.activatedAt
    });
    return true;
  }

  disable(userId: string): boolean {
    return this.store.deleteMfaSecret(userId);
  }

  status(userId: string): MfaStatus {
    const record = this.store.getMfaSecret(userId);
    if (!record) {
      return { enabled: false, pending: false, activatedAt: null, remainingBackupCodes: 0 };
    }
    return {
      enabled: record.enabled,
      pending: !record.enabled,
      activatedAt: record.activatedAt,
      remainingBackupCodes: record.backupCodes.length
    };
  }

  isEnabled(userId: string): boolean {
    return this.status(userId).enabled;
  }
}
