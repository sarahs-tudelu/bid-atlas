"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectResearchRecord } from "./project-research/types";

export type ProjectResearchLoadState =
  | "idle"
  | "checking"
  | "researching"
  | "ready"
  | "signin-required"
  | "unavailable"
  | "error";

type ResearchResponse = { research?: ProjectResearchRecord } | ProjectResearchRecord;

class ResearchRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function responseRecord(payload: ResearchResponse): ProjectResearchRecord | undefined {
  if ("research" in payload) return payload.research;
  return "projectId" in payload ? payload : undefined;
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } | string; message?: string }
    | null;
  if (typeof body?.error === "string") return body.error;
  if (body?.error && typeof body.error === "object" && body.error.message) {
    return body.error.message;
  }
  return body?.message ?? `Project research returned HTTP ${response.status}.`;
}

async function requestResearch(
  projectId: string,
  signal: AbortSignal,
  method: "GET" | "POST",
  force = false,
): Promise<ProjectResearchRecord | undefined> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/research`,
    {
      method,
      signal,
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ force }) } : {}),
    },
  );
  if (response.status === 404 && method === "GET") return undefined;
  if (!response.ok) {
    throw new ResearchRequestError(response.status, await readErrorMessage(response));
  }
  const payload = (await response.json()) as ResearchResponse;
  return responseRecord(payload);
}

function needsRefresh(record: ProjectResearchRecord | undefined): boolean {
  if (!record || record.status === "not-researched") return true;
  if (record.status === "queued" || record.status === "running") return false;
  if (record.status === "failed") {
    return Boolean(record.nextRetryAt && Date.parse(record.nextRetryAt) <= Date.now());
  }
  return Boolean(record.freshUntil && Date.parse(record.freshUntil) <= Date.now());
}

function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Project research request was cancelled.", "AbortError"));
      },
      { once: true },
    );
  });
}

export function useProjectResearch(projectId?: string) {
  const [records, setRecords] = useState<Record<string, ProjectResearchRecord>>({});
  const [loadStates, setLoadStates] = useState<Record<string, ProjectResearchLoadState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [requestVersion, setRequestVersion] = useState(0);
  const forceNextRequest = useRef(false);

  const refresh = useCallback(() => {
    forceNextRequest.current = true;
    setRequestVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const force = forceNextRequest.current;
    forceNextRequest.current = false;

    const setState = (state: ProjectResearchLoadState) => {
      if (controller.signal.aborted) return;
      setLoadStates((current) => ({ ...current, [projectId]: state }));
    };
    const setRecord = (record: ProjectResearchRecord) => {
      if (controller.signal.aborted) return;
      setRecords((current) => ({ ...current, [projectId]: record }));
      setErrors((current) => {
        if (!(projectId in current)) return current;
        const next = { ...current };
        delete next[projectId];
        return next;
      });
    };

    const run = async () => {
      setState("checking");
      let record = force
        ? undefined
        : await requestResearch(projectId, controller.signal, "GET");
      if (record) setRecord(record);

      if (force || needsRefresh(record)) {
        setState("researching");
        record = await requestResearch(projectId, controller.signal, "POST", force);
        if (record) setRecord(record);
      }

      for (let poll = 0; record && (record.status === "queued" || record.status === "running") && poll < 12; poll += 1) {
        setState("researching");
        await waitForPoll(controller.signal, 2_000);
        const refreshed = await requestResearch(projectId, controller.signal, "GET");
        if (refreshed) {
          record = refreshed;
          setRecord(refreshed);
        }
      }

      if (!record || record.status === "not-researched") {
        setState("error");
        setErrors((current) => ({
          ...current,
          [projectId]: "No research result was returned for this exact project.",
        }));
      } else if (record.status === "queued" || record.status === "running") {
        setState("error");
        setErrors((current) => ({
          ...current,
          [projectId]:
            "The bounded wait ended while the server job was still running. Retry after the current lease expires; no duplicate source run will be started inside the lease.",
        }));
      } else if (record.status === "failed") {
        setState("error");
        setErrors((current) => ({
          ...current,
          [projectId]: record.notice || "Official-source research did not complete.",
        }));
      } else {
        setState("ready");
      }
    };

    run().catch((error: unknown) => {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      const requestError = error instanceof ResearchRequestError ? error : undefined;
      const state: ProjectResearchLoadState =
        requestError?.status === 401
          ? "signin-required"
          : requestError?.status === 503
            ? "unavailable"
            : "error";
      setState(state);
      setErrors((current) => ({
        ...current,
        [projectId]:
          error instanceof Error
            ? error.message
            : "Official-source research could not be loaded.",
      }));
    });

    return () => controller.abort();
  }, [projectId, requestVersion]);

  const activeFreshUntil = projectId ? records[projectId]?.freshUntil : undefined;
  useEffect(() => {
    if (!projectId || !activeFreshUntil) return;
    const expiresIn = Date.parse(activeFreshUntil) - Date.now();
    if (!Number.isFinite(expiresIn)) return;
    const timer = window.setTimeout(() => {
      setLoadStates((current) => ({ ...current, [projectId]: "checking" }));
      setRequestVersion((current) => current + 1);
    }, Math.max(0, Math.min(expiresIn + 25, 2_147_000_000)));
    return () => window.clearTimeout(timer);
  }, [projectId, activeFreshUntil]);

  return {
    research: projectId ? records[projectId] : undefined,
    loadState: projectId ? loadStates[projectId] ?? "idle" : "idle",
    error: projectId ? errors[projectId] : undefined,
    refresh,
  };
}
