import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issueMandate } from "@task-mandate/core";
import { describe, expect, it } from "vitest";
import { ed25519 } from "../../core/test/helpers.js";
import { inspect } from "../src/cli-basic.js";

describe("tm inspect", () => {
  it("verified when the signature matches, UNVERIFIED when it is broken", async () => {
    const principal = await ed25519();
    const agent = await ed25519();
    const token = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: "https://court.example", task: { type: "reserve" }, durationSec: 600 });
    const dir = await mkdtemp(path.join(tmpdir(), "tm-inspect-"));
    const good = path.join(dir, "good.txt");
    const bad = path.join(dir, "bad.txt");
    await writeFile(good, `${token}\n`);
    const jwtEnd = token.endsWith("~") ? token.length - 1 : token.length;
    const parts = token.slice(0, jwtEnd).split(".");
    const signature = parts[2] ?? "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const first = signature[0] ?? "A";
    const flipped = alphabet[(alphabet.indexOf(first) + 1) % alphabet.length] ?? "B";
    parts[2] = `${flipped}${signature.slice(1)}`;
    await writeFile(bad, `${parts.join(".")}${token.slice(jwtEnd)}\n`);
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      await inspect(good);
      await inspect(bad);
    } finally {
      process.stdout.write = original;
    }
    const text = chunks.join("");
    expect(text).toContain('"status": "verified"');
    expect(text).toContain("UNVERIFIED");
  });
});
