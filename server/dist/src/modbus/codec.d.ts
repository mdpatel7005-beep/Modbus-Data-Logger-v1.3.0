import type { ByteOrder, RegisterDataType } from "../types/domain.js";
export declare function registerWidth(dataType: RegisterDataType): number;
export declare function decodeRegisters(registers: number[], dataType: RegisterDataType, byteOrder?: ByteOrder): number;
export declare function scaleValue(rawValue: number, scale: number, offset: number): number;
