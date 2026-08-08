import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import type { LoggerDatabase } from "../db/database.js";
import type { Principal, UserRole, UserSummary } from "../types/domain.js";

const secret = new TextEncoder().encode(env.jwtSecret);

function parseDuration(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 8 * 60 * 60;
  const value = Number(match[1]);
  const multiplier =
    match[2] === "s"
      ? 1
      : match[2] === "m"
        ? 60
        : match[2] === "h"
          ? 60 * 60
          : 24 * 60 * 60;
  return value * multiplier;
}

export class AuthService {
  constructor(private readonly database: LoggerDatabase) {}

  async ensureInitialAdministrator(): Promise<void> {
    const users = this.database.listUsers();
    if (
      users.some(
        (user) => user.enabled && user.role === "administrator",
      )
    ) {
      return;
    }
    const existing = this.database.getUserByUsername(env.initialAdminUsername);
    if (existing) {
      this.database.updateUser(
        existing.id,
        { role: "administrator", enabled: true },
        "system-bootstrap",
      );
      return;
    }
    const passwordHash = await bcrypt.hash(env.initialAdminPassword, 12);
    this.database.createUser({
      username: env.initialAdminUsername,
      passwordHash,
      role: "administrator",
    });
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; user: Principal } | null> {
    const user = this.database.getUserByUsername(username);
    if (!user || !user.enabled) return null;
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) return null;

    const principal: Principal = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    const tokenVersion = this.database.getUserTokenVersion(user.id) ?? 0;
    const token = await new SignJWT({
      username: principal.username,
      role: principal.role,
      tokenVersion,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(env.jwtIssuer)
      .setSubject(principal.id)
      .setIssuedAt()
      .setExpirationTime(`${parseDuration(env.accessTokenTtl)}s`)
      .sign(secret);

    return { token, user: principal };
  }

  async verify(token: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: env.jwtIssuer,
      });
      if (
        !payload.sub ||
        typeof payload.username !== "string" ||
        (payload.role !== "administrator" &&
          payload.role !== "operator" &&
          payload.role !== "viewer" &&
          payload.role !== "diagnostic")
      ) {
        return null;
      }
      const currentUser = this.database.getUserById(payload.sub);
      if (!currentUser || !currentUser.enabled) return null;
      if (
        typeof payload.tokenVersion !== "number" ||
        payload.tokenVersion !==
          (this.database.getUserTokenVersion(currentUser.id) ?? 0)
      ) {
        return null;
      }
      return {
        id: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
      };
    } catch {
      return null;
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = this.database.getUserById(userId);
    if (!user || !user.enabled) return false;
    const currentValid = await bcrypt.compare(
      currentPassword,
      user.password_hash,
    );
    if (!currentValid) return false;
    const passwordHash = await bcrypt.hash(newPassword, 12);
    return this.database.updateUserPassword(userId, passwordHash);
  }

  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = this.database.getUserById(userId);
    if (!user || !user.enabled || user.role !== "administrator") return false;
    return bcrypt.compare(password, user.password_hash);
  }

  async validateReadOnlyCredentials(
    username: string,
    password: string,
  ): Promise<boolean> {
    const user = this.database.getUserByUsername(username);
    if (!user?.enabled) return false;
    return bcrypt.compare(password, user.password_hash);
  }

  async createManagedUser(input: {
    username: string;
    password: string;
    role: UserRole;
    enabled: boolean;
  }): Promise<UserSummary> {
    const passwordHash = await bcrypt.hash(input.password, 12);
    return this.database.createUser({
      username: input.username,
      passwordHash,
      role: input.role,
      enabled: input.enabled,
    });
  }

  async resetManagedUserPassword(
    userId: string,
    password: string,
  ): Promise<boolean> {
    const passwordHash = await bcrypt.hash(password, 12);
    return this.database.updateUserPassword(userId, passwordHash);
  }
}
