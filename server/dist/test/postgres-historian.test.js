import assert from "node:assert/strict";
import test from "node:test";
import { buildExactHistorianCreateSql, buildLastValueDownsampleSql, configuredHistorianColumns, historianNumericType, historianSaveIsDue, HistorianSchemaWarningTracker, planHistorianColumnRenames, roundHistorianValue, } from "../src/services/postgres-historian.js";
test("keeps historian save timing independent from the poll interval", () => {
    assert.equal(historianSaveIsDue(undefined, 10_000, 1000), true);
    assert.equal(historianSaveIsDue(10_000, 10_999, 1000), false);
    assert.equal(historianSaveIsDue(10_000, 11_000, 1000), true);
    assert.equal(historianSaveIsDue(11_000, 10_500, 1000), false);
    assert.equal(historianSaveIsDue(10_700, 11_300, 1000), true);
});
test("plans exact timestamp-plus-tags historian tables", () => {
    const base = {
        deviceId: "dev_1",
        address: 0,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
    };
    const registers = [
        {
            ...base,
            id: "reg_1",
            name: "Voltage",
            historianColumn: "voltage_reg1",
            decimalPlaces: 3,
            enabled: true,
        },
        {
            ...base,
            id: "reg_2",
            name: "Disabled current",
            historianColumn: "current_reg2",
            decimalPlaces: 1,
            enabled: false,
        },
    ];
    const columns = configuredHistorianColumns(registers);
    assert.deepEqual(columns, [
        { name: "current_reg2", decimalPlaces: 1 },
        { name: "voltage_reg1", decimalPlaces: 3 },
    ]);
    const sql = buildExactHistorianCreateSql("meter_raw", columns);
    assert.match(sql, /"timestamp" TIMESTAMPTZ PRIMARY KEY/);
    assert.match(sql, /"voltage_reg1" NUMERIC\(30, 3\)/);
    assert.match(sql, /"current_reg2" NUMERIC\(30, 1\)/);
    for (const forbidden of [
        "device_id",
        "register_id",
        "quality",
        "raw_json",
        "sample_count",
        "min_value",
        "max_value",
        "avg_value",
    ]) {
        assert.equal(sql.includes(forbidden), false);
    }
});
test("plans safe historian column renames without merging duplicates", () => {
    const pending = [
        {
            registerId: "reg_power",
            from: "power_reg_123456",
            to: "power",
        },
    ];
    assert.deepEqual(planHistorianColumnRenames("meter_raw", ["timestamp", "power_reg_123456"], pending), pending);
    assert.deepEqual(planHistorianColumnRenames("meter_raw", ["timestamp", "power"], pending), []);
    assert.throws(() => planHistorianColumnRenames("meter_raw", ["timestamp", "power_reg_123456", "power"], pending), /will not merge values automatically/);
});
test("builds one valid last-value bucket expression and preserves nulls", () => {
    const sql = buildLastValueDownsampleSql("meter_raw", "meter_15m", [
        "voltage_reg1",
        "current_reg2",
    ]);
    assert.equal(sql.match(/floor\(/g)?.length, 1);
    assert.equal(sql.match(/to_timestamp\(/g)?.length, 1);
    assert.match(sql, /ORDER BY source\."timestamp" DESC\s+LIMIT 1/);
    assert.match(sql, /COALESCE\(EXCLUDED\."voltage_reg1", "meter_15m"\."voltage_reg1"\)/);
});
test("validates decimal scale and rounds values before PostgreSQL writes", () => {
    assert.equal(historianNumericType(0), "NUMERIC(30, 0)");
    assert.equal(historianNumericType(10), "NUMERIC(30, 10)");
    assert.throws(() => historianNumericType(11), /between 0 and 10/);
    assert.equal(roundHistorianValue(12.34567, 3), 12.346);
    assert.equal(roundHistorianValue(1.005, 2), 1.01);
    assert.equal(roundHistorianValue(-1.005, 2), -1.01);
    assert.equal(roundHistorianValue(null, 2), null);
});
test("warns only once per device and resets after schema state changes", () => {
    const tracker = new HistorianSchemaWarningTracker();
    assert.equal(tracker.shouldWarn("dev_1"), true);
    assert.equal(tracker.shouldWarn("dev_1"), false);
    assert.equal(tracker.shouldWarn("dev_2"), true);
    tracker.reset("dev_1");
    assert.equal(tracker.shouldWarn("dev_1"), true);
    assert.equal(tracker.shouldWarn("dev_1"), false);
    tracker.clear();
    assert.equal(tracker.shouldWarn("dev_1"), true);
    assert.equal(tracker.shouldWarn("dev_2"), true);
});
//# sourceMappingURL=postgres-historian.test.js.map