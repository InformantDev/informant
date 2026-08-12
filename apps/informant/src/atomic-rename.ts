import { dlopen } from "bun:ffi";

const RENAME_EXCHANGE = 0x2;
const LINUX_AT_FDCWD = -100;

type NativeExchange = (left: Uint8Array, right: Uint8Array) => number;

let nativeExchange: NativeExchange | undefined;

function cString(value: string): Uint8Array {
  if (value.includes("\0")) throw new Error("file path contains a null byte");
  return Buffer.from(`${value}\0`);
}

function loadNativeExchange(): NativeExchange {
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: ["ptr", "ptr", "u32"], returns: "i32" },
    });
    return (left, right) => library.symbols.renamex_np(left, right, RENAME_EXCHANGE);
  }
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    });
    return (left, right) =>
      library.symbols.renameat2(LINUX_AT_FDCWD, left, LINUX_AT_FDCWD, right, RENAME_EXCHANGE);
  }
  throw new Error(`atomic file exchange is not supported on ${process.platform}`);
}

/** Atomically swaps two pathnames without making either pathname disappear. */
export function exchangeFilePaths(left: string, right: string): void {
  nativeExchange ??= loadNativeExchange();
  if (nativeExchange(cString(left), cString(right)) !== 0) {
    throw new Error(`could not atomically exchange ${left} and ${right}`);
  }
}
