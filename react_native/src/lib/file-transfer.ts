// Metro selects file-transfer.native.ts or file-transfer.web.ts at bundle time.
// This fallback lets TypeScript resolve the native implementation during checks.
export * from "./file-transfer.native";
