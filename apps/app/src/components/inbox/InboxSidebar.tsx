import type { MouseEvent as ReactMouseEvent } from "react";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { INBOX_ROUTE_PATH } from "@/lib/route-paths";

/** Focused sidebar treatment for the global, native inbox. */
export function InboxSidebar({
  appRoutePath,
  isResizing,
  onResizeMouseDown,
  showTopReserve,
}: {
  appRoutePath: string;
  isResizing: boolean;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  showTopReserve: boolean;
}) {
  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      isResizing={isResizing}
      onResizeMouseDown={onResizeMouseDown}
      showTopReserve={showTopReserve}
      testIdPrefix="inbox"
    >
      <SectionSidebarLabel>Inbox</SectionSidebarLabel>
      <div className="mt-1 space-y-0.5">
        <SectionSidebarRow
          active
          label="All notifications"
          to={INBOX_ROUTE_PATH}
        >
          <SectionSidebarIcon name="Mail" />
        </SectionSidebarRow>
      </div>
    </SectionSidebar>
  );
}
