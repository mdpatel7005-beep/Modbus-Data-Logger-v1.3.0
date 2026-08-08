import type { LoggerDatabase } from "../db/database.js";
import type { Principal, UserRole, UserSummary } from "../types/domain.js";
export declare class AuthService {
    private readonly database;
    constructor(database: LoggerDatabase);
    ensureInitialAdministrator(): Promise<void>;
    login(username: string, password: string): Promise<{
        token: string;
        user: Principal;
    } | null>;
    verify(token: string): Promise<Principal | null>;
    changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean>;
    verifyPassword(userId: string, password: string): Promise<boolean>;
    validateReadOnlyCredentials(username: string, password: string): Promise<boolean>;
    createManagedUser(input: {
        username: string;
        password: string;
        role: UserRole;
        enabled: boolean;
    }): Promise<UserSummary>;
    resetManagedUserPassword(userId: string, password: string): Promise<boolean>;
}
