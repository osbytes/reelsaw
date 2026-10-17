import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";

/** The signed-in account (role, approval, suspension). One query, shared by the shell and pages. */
export function useMe(enabled = true) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.me.get.queryOptions(), enabled, staleTime: 30_000, retry: false });
}

/** Public instance facts: sign-up mode, version, whether heavy jobs are paused. */
export function useSystemStatus(refetchInterval?: number) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.system.status.queryOptions(), staleTime: 10_000, refetchInterval });
}
