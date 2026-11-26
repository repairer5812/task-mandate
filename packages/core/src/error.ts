/** Caller mistakes. Request outcomes use `ReasonCode` instead. */
export type TaskMandateErrorCode = "CONFIG_INVALID" | "INPUT_INVALID" | "KEY_INVALID" | "STORE_REQUIRED";

/** Thrown when configuration or caller input is invalid. */
export class TaskMandateError extends Error {
  readonly code: TaskMandateErrorCode;

  constructor(code: TaskMandateErrorCode, message: string) {
    super(message);
    this.name = "TaskMandateError";
    this.code = code;
  }
}
