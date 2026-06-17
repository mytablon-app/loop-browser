#!/usr/bin/env node
// Loop Browser — the CLI ↔ Browser command engine.
//
// Single deterministic commands:
//   loop open  <url>
//   loop fill  "<label>" "<text>"
//   loop click "<text>"
//   loop press <Key>
//   loop read
//
// Saved Flows (run like a bot — NO LLM in the hot path):
//   loop run <flow-name> key=value key2="value 2"
//   loop flows                      (list saved flows)

import { readFileSync, readdirSync } from "fs";
import { connect, activePage, runStep, withRetry, captureFailure } from "./lib.mjs";

const FLOWS_DIR = new URL("./flows/", import.meta.url);
const [cmd, ...rest] = process.argv.slice(2);

// "loop flows" doesn't need the browser
if (cmd === "flows") {
  const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith(".json"));
  console.log("saved flows:");
  for (const f of files) {
    const flow = JSON.parse(readFileSync(new URL(f, FLOWS_DIR)));
    console.log(`  • ${flow.name.padEnd(26)} ${flow.description || ""}`);
  }
  process.exit(0);
}

const browser = await connect();
const { page, tabCount } = await activePage(browser);
console.log(`· 1 tab (reuse-only, ${tabCount} total) · front-and-center`);

try {
  switch (cmd) {
    case "open":
      await runStep(page, { do: "open", url: rest[0] });
      break;
    case "fill":
      await runStep(page, { do: "fill", target: rest[0], value: rest.slice(1).join(" ") });
      break;
    case "click":
      await runStep(page, { do: "click", target: rest.join(" ") });
      break;
    case "press":
      await runStep(page, { do: "press", key: rest[0] || "Enter" });
      break;
    case "read":
      await runStep(page, { do: "read" });
      break;
    case "snapshot":
      await runStep(page, { do: "snapshot" });
      break;

    case "run": {
      const name = rest[0];
      if (!name) throw new Error("usage: loop run <flow-name> key=value ...");
      const flow = JSON.parse(readFileSync(new URL(`${name}.json`, FLOWS_DIR)));

      // inputs: defaults from the flow, overridden by key=value args
      const vars = { ...(flow.inputs || {}) };
      for (const a of rest.slice(1)) {
        const i = a.indexOf("=");
        if (i > 0) vars[a.slice(0, i)] = a.slice(i + 1);
      }

      console.log(`▶ running flow "${flow.name}" (${flow.steps.length} steps, no LLM)`);
      let broke = false;
      for (const [i, step] of flow.steps.entries()) {
        try {
          // Guardian rung 1: retry transient failures before declaring a break.
          await withRetry(() => runStep(page, step, vars), { tries: step.tries ?? 3 });
        } catch (e) {
          // Guardian: this step truly broke. Capture evidence + offer recovery.
          const shot = await captureFailure(page, `${name}-fail-step${i + 1}`);
          console.error(`\n✗ step ${i + 1}/${flow.steps.length} (${step.do}) BROKE after retries`);
          console.error(`  reason : ${e.message}`);
          console.error(`  url    : ${page.url()}`);
          console.error(`  📸 shot : ${shot}`);
          console.error(`  recovery ladder:`);
          console.error(`    • heal     → brain re-finds the element & patches this flow  (needs brain layer)`);
          console.error(`    • takeover → finish this step in the visible window, then resume`);
          console.error(`    • abort    → stop safely (nothing destructive attempted)`);
          broke = true;
          process.exitCode = 1;
          break; // stop the flow — never barrel on past a break
        }
      }
      if (!broke) console.log(`✓ flow "${flow.name}" complete`);
      break;
    }

    default:
      console.log(
        "commands: open <url> | fill <label> <text> | click <text> | press <key> | read | snapshot\n" +
          "          run <flow> key=value ... | flows"
      );
  }
  if (!process.exitCode) console.log("✓ done — look at the window.");
} finally {
  await browser.close();
}
