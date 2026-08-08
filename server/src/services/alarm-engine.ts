import { createId } from "../utils/ids.js";
import type { LoggerDatabase } from "../db/database.js";
import type { AlarmRule, RegisterDefinition } from "../types/domain.js";

function isTriggered(rule: AlarmRule, value: number): boolean {
  switch (rule.condition) {
    case "above":
      return rule.thresholdHigh !== null && value > rule.thresholdHigh;
    case "below":
      return rule.thresholdLow !== null && value < rule.thresholdLow;
    case "inside":
      return (
        (rule.thresholdLow === null || value >= rule.thresholdLow) &&
        (rule.thresholdHigh === null || value <= rule.thresholdHigh)
      );
    case "outside":
      return (
        (rule.thresholdLow !== null && value < rule.thresholdLow) ||
        (rule.thresholdHigh !== null && value > rule.thresholdHigh)
      );
    case "hi":
    case "hii":
      return rule.thresholdHigh !== null && value > rule.thresholdHigh;
    case "lo":
    case "lolo":
      return rule.thresholdLow !== null && value < rule.thresholdLow;
  }
}

function isClear(rule: AlarmRule, value: number): boolean {
  switch (rule.condition) {
    case "above":
      return (
        rule.thresholdHigh !== null &&
        value <= rule.thresholdHigh - rule.deadband
      );
    case "below":
      return (
        rule.thresholdLow !== null && value >= rule.thresholdLow + rule.deadband
      );
    case "inside":
      return (
        (rule.thresholdLow !== null && value < rule.thresholdLow) ||
        (rule.thresholdHigh !== null && value > rule.thresholdHigh)
      );
    case "outside":
      return (
        (rule.thresholdLow === null ||
          value >= rule.thresholdLow + rule.deadband) &&
        (rule.thresholdHigh === null ||
          value <= rule.thresholdHigh - rule.deadband)
      );
    case "hi":
    case "hii":
      return (
        rule.thresholdHigh !== null &&
        value <= rule.thresholdHigh - rule.deadband
      );
    case "lo":
    case "lolo":
      return (
        rule.thresholdLow !== null &&
        value >= rule.thresholdLow + rule.deadband
      );
  }
}

function getConditionLabel(condition: string): string {
  switch (condition) {
    case "hi": return "HI";
    case "hii": return "HII";
    case "lo": return "LO";
    case "lolo": return "LOLO";
    case "inside": return "INSIDE RANGE";
    case "outside": return "OUTSIDE RANGE";
    default: return condition.toUpperCase();
  }
}

export class AlarmEngine {
  private onTagAlarm?: (input: {
    opened: boolean;
    registerId: string;
    ruleName: string;
    deviceName: string;
    tagName: string;
    currentValue: number;
    thresholdValue?: number | null;
    severity: "warning" | "critical";
  }) => void;

  constructor(private readonly database: LoggerDatabase) {}

  setOnTagAlarm(callback: (input: {
    opened: boolean;
    registerId: string;
    ruleName: string;
    deviceName: string;
    tagName: string;
    currentValue: number;
    thresholdValue?: number | null;
    severity: "warning" | "critical";
  }) => void): void {
    this.onTagAlarm = callback;
  }

  evaluate(register: RegisterDefinition, value: number): void {
    const rules = this.database.listAlarmRules(register.id);
    
    // Get device info for notifications
    let deviceName = register.deviceId || "Unknown Device";
    if (register.deviceId) {
      try {
        const device = this.database.getDevice(register.deviceId);
        if (device?.name) deviceName = device.name;
      } catch {
        // Device not found, use id as fallback
      }
    }

    for (const rule of rules) {
      const active = this.database.getActiveAlarm(rule.id);
      
      if (!active && isTriggered(rule, value)) {
        this.database.openAlarm(
          rule,
          value,
          `${rule.name}: ${register.name} measured ${value} ${register.unit}`.trim(),
        );
        
        // Notify about alarm opened
        if (this.onTagAlarm) {
          this.onTagAlarm({
            opened: true,
            registerId: rule.registerId || "",
            ruleName: rule.name,
            deviceName,
            tagName: register.name || "Unknown",
            currentValue: value,
            thresholdValue: rule.condition === "above" || rule.condition === "hi" || rule.condition === "hii" 
              ? rule.thresholdHigh : rule.condition === "below" || rule.condition === "lo" || rule.condition === "lolo"
                ? rule.thresholdLow : null,
            severity: rule.severity,
          });
        }
      } else if (active && isClear(rule, value)) {
        this.database.clearAlarm(active.id, value);
        
        // Notify about alarm cleared
        if (this.onTagAlarm) {
          this.onTagAlarm({
            opened: false,
            registerId: rule.registerId || "",
            ruleName: rule.name,
            deviceName,
            tagName: register.name || "Unknown",
            currentValue: value,
            thresholdValue: null,
            severity: rule.severity,
          });
        }
      } else if (active) {
        this.database.updateActiveAlarm(active.id, value);
      }
    }
  }

  evaluateGroupAlarms(): void {
    const groups = this.database.listAlarmGroups();
    
    for (const group of groups) {
      const members = this.database.listGroupMembers(group.id);
      if (members.length === 0) continue;
      
      const rules = this.database.listAlarmGroupRules(group.id);
      
      // Get current values for all member registers
      const registerIds = members.map(m => m.register_id);
      if (registerIds.length === 0) continue;
      
      const placeholders = registerIds.map(() => '?').join(',');
      const currentValues = this.database.connection.prepare(
        `SELECT r.id as register_id, 
                (SELECT latest.value FROM readings latest 
                 JOIN registers reg ON latest.register_id = reg.id 
                 WHERE latest.register_id = r.id 
                 ORDER BY latest.timestamp DESC LIMIT 1) as value
         FROM registers r WHERE r.id IN (${placeholders})`
      ).all(...registerIds);
      
      const valuesMap = new Map(currentValues.map((cv: any) => [cv.register_id, cv.value]));
      
      // Evaluate each rule against all members and aggregate totals
      for (const rule of rules) {
        let totalValue = 0;
        let contributingDevices: string[] = [];
        let triggered = false;
        
        for (const member of members) {
          const value = valuesMap.get(member.register_id);
          if (value === undefined || value === null) continue;
          
          // Check if this device's tag meets the condition
          if (this.checkGroupCondition(rule, value)) {
            totalValue += value * (member.weight || 1);
            contributingDevices.push(`${member.register_id}=${value.toFixed(2)}`);
            
            // For HI/LO conditions, trigger on first violation; for HII/LOLO, also trigger on first
            if (!triggered) {
              triggered = true;
            }
          }
        }
        
        if (triggered && contributingDevices.length > 0) {
          const conditionLabel = getConditionLabel(rule.condition);
          const message = `${group.name} ${conditionLabel} alarm: Total=${totalValue.toFixed(2)} (${contributingDevices.join(', ')})`;
          
          const existingAlarm = this.database.connection.prepare(
            'SELECT id FROM alarm_events WHERE rule_id = ? AND cleared_at IS NULL'
          ).get(rule.id) as { id: string } | undefined;
          
          if (!existingAlarm) {
            this.database.openGroupAlarm(rule.id, group.name, totalValue, message);
          } else {
            this.database.updateActiveAlarm(existingAlarm.id, totalValue);
          }
        } else {
          // Clear alarm if condition is no longer met
          try {
            const existingAlarm = this.database.connection.prepare(
              'SELECT id FROM alarm_events WHERE rule_id = ? AND cleared_at IS NULL'
            ).get(rule.id) as { id: string } | undefined;
            
            if (existingAlarm) {
              this.database.clearAlarm(existingAlarm.id, 0);
            }
          } catch (error) {
            // Ignore errors when clearing alarm
          }
        }
      }
    }
  }

  private checkGroupCondition(rule: any, value: number): boolean {
    switch (rule.condition) {
      case 'hi':
      case 'hii':
        return value > rule.thresholdHigh!;
      case 'lo':
      case 'lolo':
        return value < rule.thresholdLow!;
      case 'above':
        return value > rule.thresholdHigh!;
      case 'below':
        return value < rule.thresholdLow!;
      case 'outside':
        return value > rule.thresholdHigh! || value < rule.thresholdLow!;
      default:
        return false;
    }
  }

  openGroupAlarm(ruleId: string, groupName: string, value: number, message: string): void {
    const id = createId("alm");
    const now = new Date().toISOString();
    this.database.connection.prepare(
      `INSERT INTO alarm_events (id, rule_id, register_id, opened_value, current_value, opened_at, message) 
       VALUES (?, ?, 'group:${groupName}', ?, ?, ?, ?)`
    ).run(id, ruleId, value, value, now, message);
  }

  listGroupMembers(groupId: string): Array<{group_id: string; register_id: string; weight: number}> {
    return this.database.connection.prepare(
      'SELECT * FROM alarm_group_members WHERE group_id = ?'
    ).all(groupId) as any[];
  }

  listAlarmGroups(): Array<{id: string; name: string; description: string | null; created_at: string; updated_at: string}> {
    return this.database.connection.prepare('SELECT * FROM alarm_groups ORDER BY name').all() as any[];
  }

  listAlarmGroupRules(groupId: string): any[] {
    return this.database.connection.prepare(
      'SELECT * FROM alarm_group_rules WHERE group_id = ? AND enabled = 1'
    ).all(groupId) as any[];
  }

  evaluateCategoryAlarms(): void {
    const categories = this.database.listAllCategoriesWithDeviceCounts();
    
    for (const category of categories) {
      if (category.device_count === 0) continue;
      
      const rules = this.database.listCategoryAlarmRules(category.id);
      if (rules.length === 0) continue;
      
      // Get all registers in devices belonging to this category
      const allRegisters = this.database.getCategoriesWithMatchingRegisters(category.id);
      if (allRegisters.length === 0) continue;
      
      for (const rule of rules) {
        // Check if this rule has specific tags configured
        const ruleTagIds = this.database.listCategoryRuleTags(rule.id);
        
        let matchingRegisters: any[];
        if (ruleTagIds.length > 0) {
          // Use only the specified tags for this rule
          matchingRegisters = allRegisters.filter(r => ruleTagIds.includes(r.register_id));
        } else {
          // Use all registers in the category (backward compatible)
          matchingRegisters = allRegisters;
        }
        
        if (matchingRegisters.length === 0) continue;
        
        const registerIds = matchingRegisters.map(r => r.register_id);
      
      // Fetch current values for all matching registers
      const placeholders = registerIds.map(() => '?').join(',');
      const currentValues = this.database.connection.prepare(
        `SELECT r.id as register_id, 
                (SELECT latest.value FROM readings latest 
                 JOIN registers reg ON latest.register_id = reg.id 
                 WHERE latest.register_id = r.id 
                 ORDER BY latest.timestamp DESC LIMIT 1) as value
         FROM registers r WHERE r.id IN (${placeholders})`
      ).all(...registerIds);
      
      const valuesMap = new Map(currentValues.map((cv: any) => [cv.register_id, cv.value]));
      
      // Evaluate this rule against all matching registers and aggregate totals
      let aggregatedValue = 0;
      let contributingDevices: string[] = [];
      
      switch (rule.aggregation_type || 'sum') {
          case 'sum':
            for (const reg of matchingRegisters) {
              const value = valuesMap.get(reg.register_id);
              if (value === undefined || value === null) continue;
              aggregatedValue += value;
              contributingDevices.push(`${reg.device_name}=${reg.tag_name}:${value.toFixed(2)}`);
            }
            break;
          case 'avg': {
            let count = 0;
            for (const reg of matchingRegisters) {
              const value = valuesMap.get(reg.register_id);
              if (value === undefined || value === null) continue;
              aggregatedValue += value;
              contributingDevices.push(`${reg.device_name}=${reg.tag_name}:${value.toFixed(2)}`);
              count++;
            }
            if (count > 0) aggregatedValue /= count;
            break;
          }
          case 'min': {
            let minVal = Infinity;
            for (const reg of matchingRegisters) {
              const value = valuesMap.get(reg.register_id);
              if (value === undefined || value === null) continue;
              if (value < minVal) minVal = value;
              contributingDevices.push(`${reg.device_name}=${reg.tag_name}:${value.toFixed(2)}`);
            }
            aggregatedValue = minVal;
            break;
          }
          case 'max': {
            let maxVal = -Infinity;
            for (const reg of matchingRegisters) {
              const value = valuesMap.get(reg.register_id);
              if (value === undefined || value === null) continue;
              if (value > maxVal) maxVal = value;
              contributingDevices.push(`${reg.device_name}=${reg.tag_name}:${value.toFixed(2)}`);
            }
            aggregatedValue = maxVal;
            break;
          }
        }
        
        // Check if aggregated value triggers the condition
        const isTriggered = this.checkGroupCondition(rule, aggregatedValue);
        
        if (isTriggered && contributingDevices.length > 0) {
          const conditionLabel = getConditionLabel(rule.condition);
          const message = `${category.name} ${rule.aggregation_type || 'sum'} ${conditionLabel} alarm: Aggregated=${aggregatedValue.toFixed(2)} (${contributingDevices.join(', ')})`;
          
          const existingAlarm = this.database.connection.prepare(
            'SELECT id FROM alarm_events WHERE rule_id = ? AND cleared_at IS NULL'
          ).get(rule.id) as { id: string } | undefined;
          
          if (!existingAlarm) {
            this.openCategoryAlarm(rule.id, category.name, aggregatedValue, message);
          } else {
            this.database.updateActiveAlarm(existingAlarm.id, aggregatedValue);
          }
        } else {
          // Clear alarm if condition is no longer met
          try {
            const existingAlarm = this.database.connection.prepare(
              'SELECT id FROM alarm_events WHERE rule_id = ? AND cleared_at IS NULL'
            ).get(rule.id) as { id: string } | undefined;
            
            if (existingAlarm) {
              this.database.clearAlarm(existingAlarm.id, 0);
            }
          } catch (error) {
            // Ignore errors when clearing alarm
          }
        }
      }
    }
  }

  openCategoryAlarm(ruleId: string, categoryName: string, value: number, message: string): void {
    const id = createId("alm");
    const now = new Date().toISOString();
    this.database.connection.prepare(
      `INSERT INTO alarm_events (id, rule_id, register_id, opened_value, current_value, opened_at, message) 
       VALUES (?, ?, 'category:${categoryName}', ?, ?, ?, ?)`
    ).run(id, ruleId, value, value, now, message);
  }
}
