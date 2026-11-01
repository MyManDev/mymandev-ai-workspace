import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App.tsx";

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
