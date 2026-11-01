import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { RuntimeBridge } from "../shared/desktop-bridge.ts";
import { App, RuntimeStatusIndicator } from "./App.tsx";

const runtime: RuntimeBridge = {
  getStatus: () => Promise.resolve({ state: "running", revision: 2 }),
  subscribeStatus: () => () => undefined,
};

test("the shell renders the product name, the navigation, and the home screen", () => {
  const html = renderToString(<App electronVersion="44.9.0" />);

  expect(html).toContain("<h1>MyManDev AI Workspace</h1>");
  expect(html).toContain('aria-label="Screens"');
  expect(html).toMatch(
    /<button type="button" aria-current="page">Home<\/button>/,
  );
  expect(html).toMatch(/<button type="button">About<\/button>/);
  expect(html).toContain('<h2 id="home-title">Home</h2>');
  expect(html).not.toContain("Electron 44.9.0");
});

test("the about screen shows the Electron version from the preload script", () => {
  expect(
    renderToString(<App electronVersion="44.9.0" initialScreen="about" />),
  ).toContain("Electron 44.9.0");
  expect(renderToString(<App initialScreen="about" />)).toContain(
    "Electron version unknown",
  );
});

test("the header shows the runtime status indicator until the first status arrives", () => {
  expect(renderToString(<App runtime={runtime} />)).toContain(
    '<p class="runtime-status" role="status" data-state="unknown"><span class="runtime-status-dot" aria-hidden="true"></span>Local runtime: Checking</p>',
  );
  expect(renderToString(<App />)).toContain("Local runtime: Unavailable");
});

test("the indicator shows the state of the runtime", () => {
  expect(
    renderToString(
      <RuntimeStatusIndicator
        view={{ kind: "known", status: { state: "running", revision: 2 } }}
      />,
    ),
  ).toBe(
    '<p class="runtime-status" role="status" data-state="running"><span class="runtime-status-dot" aria-hidden="true"></span>Local runtime: Running</p>',
  );
  expect(
    renderToString(
      <RuntimeStatusIndicator
        view={{ kind: "known", status: { state: "failed", revision: 5 } }}
      />,
    ),
  ).toContain('data-state="failed"');
});
