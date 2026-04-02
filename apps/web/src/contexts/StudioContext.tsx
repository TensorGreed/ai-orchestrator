import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import type { ExecutionHistoryDetail, ExecutionHistorySummary } from "../lib/api";
import { createBlankWorkflow } from "../lib/workflow";
import type { StudioMode } from "../components/studio-layout-types";

interface StudioContextValue {
  workflowList: WorkflowListItem[];
  setWorkflowList: Dispatch<SetStateAction<WorkflowListItem[]>>;
  currentWorkflow: Workflow;
  setCurrentWorkflow: Dispatch<SetStateAction<Workflow>>;
  activeMode: StudioMode;
  setActiveMode: Dispatch<SetStateAction<StudioMode>>;
  executionHistoryItems: ExecutionHistorySummary[];
  setExecutionHistoryItems: Dispatch<SetStateAction<ExecutionHistorySummary[]>>;
  executionHistoryTotal: number;
  setExecutionHistoryTotal: Dispatch<SetStateAction<number>>;
  expandedExecutionIds: string[];
  setExpandedExecutionIds: Dispatch<SetStateAction<string[]>>;
  executionDetailById: Record<string, ExecutionHistoryDetail | undefined>;
  setExecutionDetailById: Dispatch<SetStateAction<Record<string, ExecutionHistoryDetail | undefined>>>;
}

const StudioContext = createContext<StudioContextValue | undefined>(undefined);

export function StudioProvider({ children }: { children: ReactNode }) {
  const [workflowList, setWorkflowList] = useState<WorkflowListItem[]>([]);
  const [currentWorkflow, setCurrentWorkflow] = useState<Workflow>(createBlankWorkflow());
  const [activeMode, setActiveMode] = useState<StudioMode>("dashboard");
  const [executionHistoryItems, setExecutionHistoryItems] = useState<ExecutionHistorySummary[]>([]);
  const [executionHistoryTotal, setExecutionHistoryTotal] = useState(0);
  const [expandedExecutionIds, setExpandedExecutionIds] = useState<string[]>([]);
  const [executionDetailById, setExecutionDetailById] = useState<Record<string, ExecutionHistoryDetail | undefined>>({});

  const value = useMemo<StudioContextValue>(
    () => ({
      workflowList,
      setWorkflowList,
      currentWorkflow,
      setCurrentWorkflow,
      activeMode,
      setActiveMode,
      executionHistoryItems,
      setExecutionHistoryItems,
      executionHistoryTotal,
      setExecutionHistoryTotal,
      expandedExecutionIds,
      setExpandedExecutionIds,
      executionDetailById,
      setExecutionDetailById
    }),
    [
      workflowList,
      currentWorkflow,
      activeMode,
      executionHistoryItems,
      executionHistoryTotal,
      expandedExecutionIds,
      executionDetailById
    ]
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudioContext(): StudioContextValue {
  const context = useContext(StudioContext);
  if (!context) {
    throw new Error("useStudioContext must be used within a StudioProvider");
  }
  return context;
}
