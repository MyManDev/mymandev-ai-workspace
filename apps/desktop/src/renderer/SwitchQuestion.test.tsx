import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { SwitchQuestionContent } from "./SwitchQuestion.tsx";
import { describeSwitchQuestion } from "./workspace-view.ts";

interface HostProps {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly onClick?: () => void;
  readonly onCancel?: (event: { preventDefault: () => void }) => void;
  readonly onClose?: () => void;
}

function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  return [node, ...elementsOf(node.props.children)];
}

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    onKeep: () => calls.push("keep"),
    onDiscard: () => calls.push("discard"),
  };
}

test("without a question, the dialog stays in the page, closed and empty", () => {
  const { onKeep, onDiscard } = recorder();

  expect(
    renderToString(
      <SwitchQuestionContent
        question={undefined}
        onKeep={onKeep}
        onDiscard={onDiscard}
      />,
    ),
  ).toBe('<dialog class="switch-question"></dialog>');
});

test("a question is a dialog named by its title and described by its text, with Keep first", () => {
  const { onKeep, onDiscard } = recorder();
  const question = { kind: "project", count: 2 } as const;
  const texts = describeSwitchQuestion(question);

  const html = renderToString(
    <SwitchQuestionContent
      question={question}
      onKeep={onKeep}
      onDiscard={onDiscard}
    />,
  );

  expect(html).toBe(
    '<dialog class="switch-question" aria-labelledby="switch-question-title" aria-describedby="switch-question-text">' +
      `<h2 id="switch-question-title">${texts.title}</h2>` +
      `<p id="switch-question-text">${texts.text}</p>` +
      '<div class="switch-question-actions">' +
      `<button type="button" class="switch-question-keep">${texts.keep}</button>` +
      `<button type="button" class="switch-question-discard">${texts.discard}</button>` +
      "</div></dialog>",
  );
});

test("Keep and Discard give their own answer, and Escape keeps the messages", () => {
  const { calls, onKeep, onDiscard } = recorder();
  const elements = elementsOf(
    SwitchQuestionContent({
      question: { kind: "workspace", count: 1 },
      onKeep,
      onDiscard,
    }),
  );

  elements
    .find((element) => element.props.className === "switch-question-keep")
    ?.props.onClick?.();
  elements
    .find((element) => element.props.className === "switch-question-discard")
    ?.props.onClick?.();
  expect(calls).toEqual(["keep", "discard"]);

  let prevented = false;
  elements
    .find((element) => element.type === "dialog")
    ?.props.onCancel?.({
      preventDefault: () => {
        prevented = true;
      },
    });
  expect(prevented).toBe(true);
  expect(calls).toEqual(["keep", "discard", "keep"]);

  // A dialog that the browser closed by itself keeps the messages too.
  elements.find((element) => element.type === "dialog")?.props.onClose?.();
  expect(calls).toEqual(["keep", "discard", "keep", "keep"]);
});
