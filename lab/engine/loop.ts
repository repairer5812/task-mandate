import type { Clock, Queue } from "./types";

export function createQueue(clock: Clock, mode: "fake" | "real"): Queue & { drain(): Promise<void> } {
  const events: { at: number; seq: number; run: () => Promise<void> | void }[] = [];
  let seq = 0;
  return {
    schedule(at, run) {
      events.push({ at, seq: seq++, run });
    },
    async drain() {
      while (events.length > 0) {
        let best = 0;
        for (let index = 1; index < events.length; index += 1) {
          const ev = events[index]!;
          const cur = events[best]!;
          if (ev.at < cur.at || (ev.at === cur.at && ev.seq < cur.seq)) best = index;
        }
        const ev = events.splice(best, 1)[0]!;
        if (mode === "fake") clock.ms = ev.at;
        else {
          const wait = ev.at - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          clock.ms = Date.now();
        }
        await ev.run();
      }
    },
  };
}
