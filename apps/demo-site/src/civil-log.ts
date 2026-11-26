export interface CivilLogEntry {
  at: string;
  status: number;
  code: string | null;
  service: string | null;
  task: string | null;
}

export interface CivilLog {
  append(entry: CivilLogEntry): Promise<void> | void;
  recent(): Promise<CivilLogEntry[]> | CivilLogEntry[];
}

const MAX_LINES = 50;

export function memoryCivilLog(): CivilLog {
  const entries: CivilLogEntry[] = [];
  return {
    append(entry) {
      entries.unshift({ ...entry });
      if (entries.length > MAX_LINES) entries.length = MAX_LINES;
    },
    recent() {
      return entries.map((entry) => ({ ...entry }));
    },
  };
}
