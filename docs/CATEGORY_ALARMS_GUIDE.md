# Category Alarms Guide

## Overview
Category Alarms allow you to create alarm rules that aggregate values across specific devices within a category. You can select which devices participate in each alarm rule.

## Use Case Example
- **Category**: "Pump Station A" with 6 devices
- **Alarm Rule**: "Total Current High" - only monitors 3 specific current sensors
- When the sum/average/min/max of those 3 selected devices exceeds the threshold, the alarm triggers

## How It Works

### Step 1: Create a Category
1. Go to the **Devices** view
2. Assign multiple devices to the same category (e.g., "Pump Station")

### Step 2: Navigate to Category Alarms
1. Click on **Alarms** → **Category Alarms**
2. Select your category from the dropdown

### Step 3: Create a New Alarm Rule
1. Click **Create Category Alarm Rule**
2. Configure the rule:

   - **Rule Name**: e.g., "Total Current Exceeded"
   - **Severity**: Warning or Critical
   - **Condition**: Above, Below, Inside Range, Outside Range, Hi, Lo, HIHI, LOLO
   - **Threshold(s)**: Enter threshold value(s) based on your condition
   - **Aggregation Type**:
     - **Sum**: Total of all selected devices
     - **Average**: Mean of all selected devices  
     - **Minimum**: Lowest value among selected devices
     - **Maximum**: Highest value among selected devices

### Step 4: Select Participating Devices (CRITICAL)
This is where you specify which devices participate:

1. Under **"Devices in Alarm"**, you'll see all devices in the category
2. **Uncheck** the devices you DON'T want to include (e.g., leave unchecked the 3 devices you don't want to monitor)
3. Or **check only** the 3 devices you DO want to monitor

   - Click **"Select All"** to include all devices
   - Click **"Clear All"** to select none
   - Manually check/uncheck individual devices/tags

### Step 5: Save the Rule
Click **Create Rule** to save.

## Example Scenario

### Your Setup:
```
Category: "HVAC Unit 1"
├── Device 1: Current Sensor A (tag: I_A)
├── Device 2: Current Sensor B (tag: I_B)  
├── Device 3: Current Sensor C (tag: I_C)
├── Device 4: Voltage Sensor A (tag: V_A)
├── Device 5: Temperature Sensor A (tag: T_A)
└── Device 6: Power Factor (tag: PF)
```

### Your Requirement:
> "I want to monitor only the current total (3 devices) for overcurrent alarm"

### Configuration:
1. Create category alarm rule with:
   - **Condition**: `Above`
   - **Threshold High**: `50.0` (for example, 50 Amps)
   - **Aggregation Type**: `sum`

2. In the device selection:
   ```
   ✓ Current Sensor A: I_A
   ✓ Current Sensor B: I_B
   ✓ Current Sensor C: I_C
   ✗ Voltage Sensor A: V_A (unchecked - not monitored)
   ✗ Temperature Sensor A: T_A (unchecked - not monitored)
   ✗ Power Factor: PF (unchecked - not monitored)
   ```

3. Result:
   - Alarm triggers when: `I_A + I_B + I_C > 50.0`
   - Only the 3 current sensors contribute to the alarm

## Aggregation Types Explained

| Type | Formula | Use Case |
|------|---------|----------|
| **sum** | `value1 + value2 + ... + valueN` | Total current, total power |
| **avg** | `(value1 + value2 + ... + valueN) / N` | Average temperature |
| **min** | `MIN(value1, value2, ..., valueN)` | Lowest pressure in system |
| **max** | `MAX(value1, value2, ..., valueN)` | Highest temperature in bank |

## Alarm Events

When an alarm triggers:
- Shows: `CategoryName sum HI alarm: Aggregated=75.34 (Device1=25.10, Device2=25.20, Device3=25.04)`
- Severity badge: Warning or Critical
- Can be acknowledged in the Alarms view

## Managing Rules

### Edit a Rule
1. Click the **Edit** icon on the rule card
2. Modify settings and device selection
3. Update saves your changes

### Delete a Rule
1. Click the **Delete** icon on the rule card
2. Confirm deletion

## Notes
- If you select NO specific devices, ALL devices in the category participate (backward compatible)
- You can create multiple alarm rules per category with different device selections
- Each rule can have different aggregation types and thresholds
- Device selection is saved separately for each rule
