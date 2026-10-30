/** One change made from this window, with how to take it back and make it again. */
export interface Step {
  /** What the step did, as the Undo and Redo messages name it: `Archive “Fix the login”`. */
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/**
 * This window's undo and redo stacks. A new step clears what was undone, as in an editor. Undo and redo run one at a
 * time in the order asked, so pressing Ctrl+Z twice quickly takes back two steps, newest first. A step whose undo or
 * redo fails stays where it was, so it can be tried again.
 */
export class History {
  private readonly done: Step[] = [];
  private readonly undone: Step[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly onChange: () => void = () => undefined,
    private readonly limit = 50,
  ) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  record(step: Step): void {
    this.done.push(step);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    this.onChange();
  }

  /** Takes back the newest step; resolves to it, or to nothing when there was none. */
  undo(): Promise<Step | undefined> {
    return this.move(this.done, this.undone, (s) => s.undo());
  }

  /** Makes the newest undone step again; resolves to it, or to nothing when there was none. */
  redo(): Promise<Step | undefined> {
    return this.move(this.undone, this.done, (s) => s.redo());
  }

  private move(from: Step[], to: Step[], run: (s: Step) => Promise<void>): Promise<Step | undefined> {
    const next = this.queue.then(async () => {
      const step = from.pop();
      if (!step) return undefined;
      try {
        await run(step);
      } catch (err) {
        from.push(step);
        throw err;
      }
      to.push(step);
      this.onChange();
      return step;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
