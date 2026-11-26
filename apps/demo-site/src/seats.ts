export type SeatResult = { status: "ok"; remaining: number } | { status: "not-found" } | { status: "full" };

export interface SeatBook {
  list(): Promise<Record<string, number>>;
  take(facility: string): Promise<SeatResult>;
  release(facility: string): Promise<void>;
}

export function memorySeatBook(initial: Record<string, number>): SeatBook {
  const seats: Record<string, number> = {};
  for (const [name, count] of Object.entries(initial)) seats[name] = count;
  return {
    async list() {
      return { ...seats };
    },
    // No await. If the check and the decrement split, concurrent bookings oversell the seats.
    async take(facility) {
      if (!Object.hasOwn(seats, facility)) return { status: "not-found" };
      if (seats[facility]! <= 0) return { status: "full" };
      seats[facility] -= 1;
      return { status: "ok", remaining: seats[facility]! };
    },
    async release(facility) {
      if (!Object.hasOwn(seats, facility)) return;
      seats[facility] += 1;
    },
  };
}
