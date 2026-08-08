import type { LoggerDatabase } from "../db/database.js";
import type { RegisterDefinition } from "../types/domain.js";
export declare class AlarmEngine {
    private readonly database;
    private onTagAlarm?;
    constructor(database: LoggerDatabase);
    setOnTagAlarm(callback: (input: {
        opened: boolean;
        registerId: string;
        ruleName: string;
        deviceName: string;
        tagName: string;
        currentValue: number;
        thresholdValue?: number | null;
        severity: "warning" | "critical";
    }) => void): void;
    evaluate(register: RegisterDefinition, value: number): void;
    evaluateGroupAlarms(): void;
    private checkGroupCondition;
    openGroupAlarm(ruleId: string, groupName: string, value: number, message: string): void;
    listGroupMembers(groupId: string): Array<{
        group_id: string;
        register_id: string;
        weight: number;
    }>;
    listAlarmGroups(): Array<{
        id: string;
        name: string;
        description: string | null;
        created_at: string;
        updated_at: string;
    }>;
    listAlarmGroupRules(groupId: string): any[];
    evaluateCategoryAlarms(): void;
    openCategoryAlarm(ruleId: string, categoryName: string, value: number, message: string): void;
}
