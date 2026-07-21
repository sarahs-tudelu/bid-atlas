import type { ProjectRecord } from "./types";

export function mergeProjectRecords(
  persisted: ProjectRecord,
  live: ProjectRecord,
): ProjectRecord {
  const documents = new Map(
    [...live.documents, ...persisted.documents].map((document) => [document.url, document]),
  );
  const participants = new Map<string, ProjectRecord["participants"][number]>();
  for (const participant of [...persisted.participants, ...live.participants]) {
    const key = `${participant.role}:${participant.name.toLowerCase()}`;
    participants.set(key, { ...participants.get(key), ...participant });
  }
  return {
    ...persisted,
    ...live,
    documents: Array.from(documents.values()),
    participants: Array.from(participants.values()),
    documentTextIndexed: Boolean(
      persisted.documentTextIndexed || live.documentTextIndexed,
    ),
  };
}
