import { useEffect, useRef, type RefObject } from "react";
import {
  describeSwitchQuestion,
  type SwitchQuestion,
} from "./workspace-view.ts";

export interface SwitchQuestionProps {
  /** The open question, or undefined when none is open. */
  readonly question: SwitchQuestion | undefined;
  /** Keeps the waiting chat messages; the switch does not happen. */
  readonly onKeep: () => void;
  /** Discards the waiting chat messages, and the switch goes ahead. */
  readonly onDiscard: () => void;
}

/**
 * The question before a switch while chat messages wait to be sent, as a
 * modal dialog of the page (`showModal`): the rest of the page is inert
 * until the person answers, the focus moves to the first button, "Keep",
 * and Escape keeps the messages too. Closing the dialog returns the focus.
 */
export function SwitchQuestionDialog(props: SwitchQuestionProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = props.question !== undefined;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  return <SwitchQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for a question, without state. The element stays in the page
 * while no question is open, empty and closed, so that closing it can
 * return the focus to where it was.
 */
export function SwitchQuestionContent({
  question,
  onKeep,
  onDiscard,
  dialogRef,
}: SwitchQuestionProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (question === undefined) {
    return <dialog ref={dialogRef} className="switch-question" />;
  }
  const texts = describeSwitchQuestion(question);
  return (
    <dialog
      ref={dialogRef}
      className="switch-question"
      aria-labelledby="switch-question-title"
      aria-describedby="switch-question-text"
      onCancel={(event) => {
        // Escape keeps the messages; the dialog closes with the question.
        event.preventDefault();
        onKeep();
      }}
      // A dialog that the browser closed by itself keeps the messages too.
      onClose={onKeep}
    >
      <h2 id="switch-question-title">{texts.title}</h2>
      <p id="switch-question-text">{texts.text}</p>
      <div className="switch-question-actions">
        <button type="button" className="switch-question-keep" onClick={onKeep}>
          {texts.keep}
        </button>
        <button
          type="button"
          className="switch-question-discard"
          onClick={onDiscard}
        >
          {texts.discard}
        </button>
      </div>
    </dialog>
  );
}
