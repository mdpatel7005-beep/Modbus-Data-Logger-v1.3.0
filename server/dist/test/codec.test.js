import assert from "node:assert/strict";
import test from "node:test";
import { decodeRegisters, registerWidth, scaleValue, } from "../src/modbus/codec.js";
import { groupRegisters } from "../src/modbus/client.js";
test("reports the correct register width", () => {
    assert.equal(registerWidth("uint16"), 1);
    assert.equal(registerWidth("float32"), 2);
    assert.equal(registerWidth("float64"), 4);
});
test("decodes signed and unsigned 16-bit values", () => {
    assert.equal(decodeRegisters([65535], "uint16"), 65535);
    assert.equal(decodeRegisters([65535], "int16"), -1);
});
test("decodes IEEE-754 floats with common word orders", () => {
    assert.ok(Math.abs(decodeRegisters([0x4145, 0x70a4], "float32", "ABCD") - 12.34) <
        0.0001);
    assert.ok(Math.abs(decodeRegisters([0x70a4, 0x4145], "float32", "CDAB") - 12.34) <
        0.0001);
});
test("applies engineering scaling and offset", () => {
    assert.equal(scaleValue(250, 0.1, -5), 20);
});
test("rejects an incomplete multi-register value", () => {
    assert.throws(() => decodeRegisters([0x4145], "float32"), /Expected 2 registers/);
});
test("groups nearby registers without exceeding the device block size", () => {
    const base = {
        deviceId: "dev_1",
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        historianColumn: "tag_value_1",
        decimalPlaces: 2,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const registers = [
        { ...base, id: "r1", name: "One", address: 0 },
        { ...base, id: "r2", name: "Two", address: 4 },
        { ...base, id: "r3", name: "Three", address: 20 },
    ];
    const blocks = groupRegisters(registers, 10);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0]?.registers.map((item) => item.id), ["r1", "r2"]);
    assert.equal(blocks[0]?.length, 5);
    assert.equal(blocks[1]?.startAddress, 20);
});
test("plans every tag in 1000+ sparse mixed-area maps within protocol limits", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const registers = Array.from({ length: 1_205 }, (_, index) => {
        const functionCode = ((index % 4) + 1);
        const address = Math.floor(index / 4) * 200;
        return {
            id: `r${index}`,
            deviceId: "dev_large",
            name: `Tag ${index}`,
            address,
            functionCode,
            dataType: functionCode === 1 || functionCode === 2 ? "bool" : "float64",
            byteOrder: "ABCD",
            scale: 1,
            offset: 0,
            unit: "",
            historianColumn: `tag_${index}`,
            decimalPlaces: 2,
            enabled: true,
            createdAt,
            updatedAt: createdAt,
        };
    });
    const blocks = groupRegisters(registers.reverse(), 10_000);
    const planned = blocks.flatMap((block) => block.registers);
    assert.equal(planned.length, 1_205);
    assert.equal(new Set(planned.map((register) => register.id)).size, 1_205);
    assert.ok(blocks.every((block) => block.functionCode === 1 || block.functionCode === 2
        ? block.length <= 2_000
        : block.length <= 125));
    assert.ok(blocks.every((block) => block.registers.every((register) => register.functionCode === block.functionCode)));
});
//# sourceMappingURL=codec.test.js.map