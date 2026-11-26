// Acceptance tests read arguments with `vi.fn(implementation).mock.calls[0][0]`.
// Vitest 5 infers an implementation with no arguments as an empty tuple, so that access is a type error.
// Acceptance test files are left unchanged, so only the type check widens fn call args to any[].
export * from "../node_modules/vitest/dist/index.js";

import type { Mock, VitestUtils as RealVitestUtils } from "../node_modules/vitest/dist/index.js";

type LooseFn = (implementation?: (...args: any[]) => any) => Mock<(...args: any[]) => any>;

export declare const vi: Omit<RealVitestUtils, "fn"> & { fn: LooseFn };
