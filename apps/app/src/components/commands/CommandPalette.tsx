import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AppCommandId } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { useNavigate } from "react-router-dom";
import { useThreadSearch } from "@/hooks/queries/thread-queries";
import { APP_COMMAND_GROUPS } from "@/lib/app-command-metadata";
import { getRootComposeRoutePath, getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  useAppCommandHandler,
  useAppCommandProvider,
} from "./AppCommandProvider";

interface CommandResult {
  command: AppCommandId;
  description: string;
  label: string;
  type: "command";
}

interface ThreadResult {
  projectId: string;
  threadId: string;
  title: string;
  type: "thread";
}

type PaletteResult = CommandResult | ThreadResult;

function fuzzyScore(value: string, query: string): number | null {
  const normalizedValue = value.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  let cursor = 0;
  let score = 0;
  for (const character of normalizedQuery) {
    const next = normalizedValue.indexOf(character, cursor);
    if (next === -1) return null;
    score += next - cursor;
    cursor = next + 1;
  }
  return score;
}

export function filterCommandPaletteCommands(
  query: string,
): readonly CommandResult[] {
  const trimmedQuery = query.trim();
  const commands = APP_COMMAND_GROUPS.flatMap((group) => group.commands);
  if (trimmedQuery.length === 0) {
    return commands.map(({ command, description, label }) => ({
      command,
      description,
      label,
      type: "command" as const,
    }));
  }
  return commands
    .map((metadata) => {
      const score = fuzzyScore(
        `${metadata.label} ${metadata.description}`,
        trimmedQuery,
      );
      return score === null ? null : { ...metadata, score };
    })
    .filter(
      (item): item is (typeof commands)[number] & { score: number } =>
        item !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score || left.label.localeCompare(right.label),
    )
    .map(({ command, description, label }) => ({
      command,
      description,
      label,
      type: "command" as const,
    }));
}

/** Global overlay for commands and full-text thread search. */
export function CommandPalette() {
  const commandProvider = useAppCommandProvider();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const threadSearch = useThreadSearch({ active: isOpen, query });

  const open = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  useAppCommandHandler("command.palette", () => {
    open();
    return true;
  });

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const commandResults = useMemo(
    () => filterCommandPaletteCommands(query),
    [query],
  );
  const threadResults = useMemo<readonly ThreadResult[]>(() => {
    if (threadSearch.debouncedQuery !== query.trim()) return [];
    return [
      ...(threadSearch.data?.active.results ?? []),
      ...(threadSearch.data?.archived.results ?? []),
    ].map(({ thread }) => ({
      projectId: thread.projectId,
      threadId: thread.id,
      title: getThreadDisplayTitle(thread),
      type: "thread" as const,
    }));
  }, [query, threadSearch.data, threadSearch.debouncedQuery]);
  const results = useMemo<readonly PaletteResult[]>(
    () => [...commandResults, ...threadResults],
    [commandResults, threadResults],
  );
  const canAskAgent =
    query.trim().length > 0 &&
    threadSearch.hasSearchableQuery &&
    !threadSearch.isDebouncing &&
    !threadSearch.isLoading &&
    results.length === 0;

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(results.length - 1, 0)),
    );
  }, [results.length]);

  const askAgent = useCallback(() => {
    const initialPrompt = query.trim();
    if (initialPrompt.length === 0) return;
    close();
    void navigate(getRootComposeRoutePath(), {
      state: { focusPrompt: true, initialPrompt, replaceInitialPrompt: true },
    });
  }, [close, navigate, query]);

  const selectResult = useCallback(
    (result: PaletteResult) => {
      close();
      if (result.type === "thread") {
        void navigate(getThreadRoutePath(result));
        return;
      }
      commandProvider?.dispatch(result.command, null);
    },
    [close, commandProvider, navigate],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) =>
          results.length === 0 ? 0 : (current + 1) % results.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) =>
          results.length === 0
            ? 0
            : (current - 1 + results.length) % results.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeIndex];
        if (result) selectResult(result);
        else if (canAskAgent) askAgent();
      }
    },
    [activeIndex, askAgent, canAskAgent, close, results, selectResult],
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="w-full max-w-2xl overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search app commands and threads.
        </DialogDescription>
        <div>
          <div className="flex h-12 items-center gap-3 border-b border-border px-4">
            <Icon name="Search" className="size-4 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              aria-label="Search commands and threads"
              placeholder="Search commands and threads"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Esc
            </kbd>
          </div>
          <div
            className="max-h-[min(60vh,34rem)] overflow-y-auto p-2"
            role="listbox"
          >
            {results.map((result, index) => (
              <button
                key={
                  result.type === "command" ? result.command : result.threadId
                }
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-accent aria-selected:bg-accent"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(result)}
              >
                <Icon
                  name={
                    result.type === "command" ? "Terminal" : "MessageSquare"
                  }
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {result.type === "command" ? result.label : result.title}
                </span>
                {result.type === "command" ? (
                  <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                    {result.description}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Thread</span>
                )}
              </button>
            ))}
            {canAskAgent ? (
              <button
                type="button"
                className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-accent"
                onClick={askAgent}
              >
                <Icon
                  name="MessageSquarePlus"
                  className="size-4 text-muted-foreground"
                />
                <span className="text-sm">No matches — ↵ to ask the agent</span>
              </button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
