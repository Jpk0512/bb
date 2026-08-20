import { useCallback } from "react";
import { appToast } from "@/components/ui/app-toast";
import { useCreateTerminal } from "@/hooks/queries/thread-terminal-queries";
import { useSetFixedRightTerminalActiveTerminal } from "@/lib/fixed-panel-tabs";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";

/** Same panel id RootComposeView uses for the home terminal drawer. */
const ROOT_COMPOSE_FIXED_PANEL_STATE_ID = "root-compose";

export function useProviderLoginTerminal() {
  const createTerminal = useCreateTerminal();
  const setActiveFixedTerminal = useSetFixedRightTerminalActiveTerminal(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );

  const openLogin = useCallback(
    async (args: { hostId: string; command: string; title: string }) => {
      const session = await createTerminal.mutateAsync({
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
        target: {
          kind: "host_path",
          hostId: args.hostId,
          cwd: null,
        },
        title: args.title,
        start: { mode: "command", command: args.command },
      });
      setActiveFixedTerminal(session.id);
      appToast.success(`${args.title} opened in a terminal`);
      return session;
    },
    [createTerminal, setActiveFixedTerminal],
  );

  return {
    openLogin,
    isPending: createTerminal.isPending,
  };
}
