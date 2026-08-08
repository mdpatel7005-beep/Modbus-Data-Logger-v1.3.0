export function registerWidth(dataType) {
    switch (dataType) {
        case "uint32":
        case "int32":
        case "float32":
            return 2;
        case "float64":
            return 4;
        default:
            return 1;
    }
}
function registersToBytes(registers) {
    const buffer = Buffer.alloc(registers.length * 2);
    registers.forEach((value, index) => {
        buffer.writeUInt16BE(value & 0xffff, index * 2);
    });
    return buffer;
}
function reorder(buffer, byteOrder) {
    if (buffer.length === 2) {
        return byteOrder === "BADC" || byteOrder === "DCBA"
            ? Buffer.from([buffer[1] ?? 0, buffer[0] ?? 0])
            : buffer;
    }
    const words = Array.from({ length: buffer.length / 2 }, (_, index) => buffer.subarray(index * 2, index * 2 + 2));
    const swapBytes = byteOrder === "BADC" || byteOrder === "DCBA";
    const swapWords = byteOrder === "CDAB" || byteOrder === "DCBA";
    const orderedWords = swapWords ? words.reverse() : words;
    return Buffer.concat(orderedWords.map((word) => swapBytes ? Buffer.from([word[1] ?? 0, word[0] ?? 0]) : word));
}
export function decodeRegisters(registers, dataType, byteOrder = "ABCD") {
    if (registers.length < registerWidth(dataType)) {
        throw new Error(`Expected ${registerWidth(dataType)} registers for ${dataType}, received ${registers.length}`);
    }
    if (dataType === "bool") {
        return registers[0] ? 1 : 0;
    }
    const buffer = reorder(registersToBytes(registers.slice(0, registerWidth(dataType))), byteOrder);
    switch (dataType) {
        case "uint16":
            return buffer.readUInt16BE(0);
        case "int16":
            return buffer.readInt16BE(0);
        case "uint32":
            return buffer.readUInt32BE(0);
        case "int32":
            return buffer.readInt32BE(0);
        case "float32":
            return buffer.readFloatBE(0);
        case "float64":
            return buffer.readDoubleBE(0);
        default:
            throw new Error(`Unsupported data type: ${String(dataType)}`);
    }
}
export function scaleValue(rawValue, scale, offset) {
    const value = rawValue * scale + offset;
    if (!Number.isFinite(value)) {
        throw new Error("Decoded value is not finite");
    }
    return value;
}
//# sourceMappingURL=codec.js.map