import type { LoggerDatabase } from "../db/database.js";
export interface SystemAdministrationOptions {
    appVersion?: string;
    dataDirectory?: string;
    systemUpdateHelper?: string;
    openVpnHelper?: string;
}
export interface SystemAdministrationStatus {
    appVersion: string;
    update: {
        helperConfigured: boolean;
        stagedVersion: string | null;
        stagedFilename: string | null;
        stagedSha256: string | null;
        stagedAt: string | null;
        lastError: string | null;
    };
    openVpn: {
        helperConfigured: boolean;
        configured: boolean;
        profileName: string | null;
        enabled: boolean;
        lastChangedAt: string | null;
        lastError: string | null;
    };
}
export interface SystemAuditContext {
    actorId?: string;
    sourceIp?: string;
}
export declare class SystemAdministrationError extends Error {
    readonly statusCode: number;
    readonly code: string;
    constructor(statusCode: number, code: string, message: string);
}
export declare function validateOpenVpnProfile(contents: Buffer): string;
export declare class SystemAdministrationService {
    private readonly database;
    readonly appVersion: string;
    readonly dataDirectory: string;
    readonly updateFilePath: string;
    readonly openVpnProfilePath: string;
    private readonly systemUpdateHelper;
    private readonly openVpnHelper;
    constructor(database: LoggerDatabase, options?: SystemAdministrationOptions);
    private initialize;
    private getUpdateState;
    private getOpenVpnState;
    getStatus(): SystemAdministrationStatus;
    createConfigurationBackup(audit: SystemAuditContext): string;
    restoreConfigurationBackup(backup: string, audit: SystemAuditContext): Promise<{
        restoredAt: string;
        reloadRequired: true;
    }>;
    factoryReset(audit: SystemAuditContext): Promise<{
        resetAt: string;
        reloadRequired: true;
    }>;
    stageUpdate(contents: Buffer, version: string, filename: string, audit: SystemAuditContext): {
        version: string;
        filename: string;
        sha256: string;
        stagedAt: string;
    };
    applyUpdate(audit: SystemAuditContext): Promise<{
        accepted: true;
        version: string;
    }>;
    saveOpenVpnProfile(contents: Buffer, filename: string, audit: SystemAuditContext): {
        profileName: string;
        configured: true;
        savedAt: string;
    };
    setOpenVpnEnabled(enabled: boolean, audit: SystemAuditContext): Promise<{
        enabled: boolean;
        changedAt: string;
    }>;
    private validateBackupEnvelope;
    private parseBackup;
    private assertBackupRecordLimits;
    private selectAll;
    private selectAllIfExists;
    private insertRows;
    private tableExists;
    private deleteOperationalConfiguration;
    private resetDataServerConfiguration;
    private upsertUpdateState;
    private upsertOpenVpnState;
    private recordUpdateError;
    private recordOpenVpnError;
    private managedFileExists;
    private readManagedFile;
    private recoverInterruptedManagedFiles;
    private replaceManagedFiles;
    private runHelper;
}
